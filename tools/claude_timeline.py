#!/usr/bin/env python3
"""
claude_timeline — where in this rl2 take did a Claude Code session do X?

Maps every Claude Code transcript event (prompt / reply / tool / result) that falls inside an
rl2 take onto video time, so an editing agent can grep "studied Apple's video" and get a take
and a vt to seek to, instead of hand-searching a 100-minute recording.

    python3 claude_timeline.py --take screen-20261017-184430 [--grep TEXT] [--session NAME]
                               [--kind prompt,reply] [--from VT] [--to VT] [--limit N]

Always writes <take>/claude-timeline.jsonl (every row, not just the filtered ones).

Clock. rl2 stamps events on the host clock; vt = host - session.json clock.first_frame_host.
session.json has no sub-second wall time and created_wall can be stamped long after the start
(watcher/pick.py), so the wall time of vt 0 is the screen.mp4 file's birth time (the file is
created as capture starts), sanity-checked against the folder name (local time), which is the
fallback. Transcript timestamps are UTC. Accuracy: about 1-2 s (a prompt bubble was absent at vt-2 and present at vt+1.4).

On screen. rl2 records no window titles, so which session was visible is a guess. A prompt row
counts as "typed at the screen" when a Send click or typing burst sits within a few seconds
before it; the row's session is then marked on-screen (`*`) from that moment while the Claude
app is frontmost, until another typed prompt, or the app loses focus. Treat `*` as a hint; the
`app` field is the frontmost app at that vt and is exact.

Read-only on the take; only claude-timeline.jsonl is written. Seeks nothing in the video.
"""
import argparse
import bisect
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

RECORDINGS = os.path.expanduser("~/Desktop/Screen Recordings")
PROJECTS = os.path.expanduser("~/.claude/projects")
SESSIONS = os.path.expanduser("~/Library/Application Support/Claude/claude-code-sessions")
OUT = "claude-timeline.jsonl"
TEXT_MAX = 2000        # chars kept per row in the jsonl (grep sees all of it)
SNIP = 150             # chars shown per row in the terminal
SEND_LEAD = 6.0        # a Send click / typing burst this long before a prompt = typed at the screen
STICKY = 25 * 60.0     # on-screen guess expires this long after the last typed prompt

# Looks like a secret: vendor prefixes, JWTs, key=value assignments, long opaque blobs.
SECRET = re.compile(
    r"(?:sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[abprs]-[A-Za-z0-9\-]{10,}"
    r"|AIza[0-9A-Za-z_\-]{30,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|(?i:bearer)\s+[A-Za-z0-9._\-]{20,}"
    r"|(?i:(?:api[_-]?key|secret|token|passw(?:or)?d|authorization)[\"']?\s*[:=]\s*[\"']?)[^\s\"',;]{8,}"
    r"|(?<![\w/.\-])[A-Za-z0-9]{32,}(?![\w/.\-]))")


def redact(s):
    """(text, was_redacted). A bare 32+ char alphanumeric run only counts when it mixes letters and
    digits, so a long camelCase word is kept; paths and hyphenated slugs never match."""
    hit = []

    def sub(m):
        t = m.group(0)
        if re.fullmatch(r"[A-Za-z0-9]{32,}", t) and not (re.search(r"\d", t) and re.search(r"[A-Za-z]", t)):
            return t
        hit.append(1)
        return "[redacted]"
    out = SECRET.sub(sub, s)
    return out, bool(hit)


def one_line(s):
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- take

def find_take(arg):
    cand = [arg, os.path.join(RECORDINGS, arg)]
    for c in cand:
        if os.path.isfile(os.path.join(c, "session.json")):
            return os.path.abspath(c)
    sys.exit("no take %r (looked in %s)" % (arg, RECORDINGS))


def last_json_line(path, tail=65536):
    with open(path, "rb") as f:
        f.seek(0, 2)
        n = f.tell()
        f.seek(max(0, n - tail))
        for ln in reversed(f.read().splitlines()):
            try:
                return json.loads(ln)
            except ValueError:
                continue
    return None


def take_clock(take):
    """-> (t0_host, wall0 (aware utc), duration_s)."""
    sess = json.load(open(os.path.join(take, "session.json")))
    t0 = sess["clock"]["first_frame_host"]
    name = os.path.basename(take.rstrip("/"))
    m = re.search(r"(\d{8})-(\d{6})", name)
    folder = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").astimezone() if m else None
    wall0 = None
    mp4 = os.path.join(take, sess.get("video") or "screen.mp4")
    if os.path.exists(mp4):
        b = datetime.fromtimestamp(os.stat(mp4).st_birthtime, timezone.utc)
        if folder is None or -2 <= (b - folder).total_seconds() <= 5:
            wall0 = b          # file created as capture starts; ~0.1 s before the first frame
    if wall0 is None:
        if folder is None:
            sys.exit("cannot place the take on the wall clock (no usable birth time or folder stamp)")
        wall0 = folder.astimezone(timezone.utc) + timedelta(seconds=0.4)   # folder name is second-truncated
    dur = 0.0
    fr = os.path.join(take, "frames.ndjson")
    if os.path.exists(fr):
        d = last_json_line(fr)
        dur = (d or {}).get("vt", 0.0)
    if not dur:
        dur = os.stat(mp4).st_mtime - os.stat(mp4).st_birthtime
    return t0, wall0, dur


def read_trace(take, t0):
    """focus spans [(vt, app)] and typed-input event vts, from trace.ndjson (170 MB: prefilter bytes)."""
    focus, inputs = [], []
    with open(os.path.join(take, "trace.ndjson"), "rb") as f:
        for ln in f:
            if b'"focus_change"' in ln:
                kind = "f"
            elif b'"typing_burst"' in ln:
                kind = "t"
            elif b'"type":"click"' in ln and b'"title"' in ln:
                kind = "c"
            else:
                continue
            try:
                d = json.loads(ln)
            except ValueError:
                continue
            vt = d["host"] - t0
            if kind == "f":
                focus.append((vt, d.get("app", "?")))
            elif kind == "t":
                inputs.append(d.get("end", d["host"]) - t0)
            else:
                title = ((d.get("target") or {}).get("title") or "").strip().lower()
                if title in ("send", "send message"):
                    inputs.append(vt)
    focus.sort()
    inputs.sort()
    return focus, inputs


# ---------------------------------------------------------------- claude sessions

def load_meta():
    by_cli = {}
    for f in glob.glob(os.path.join(SESSIONS, "*", "*", "local_*.json")):
        try:
            d = json.load(open(f))
        except (OSError, ValueError):
            continue
        cli = d.get("cliSessionId")
        if not cli:
            continue
        sf = d.get("spawnedFrom") or {}
        by_cli[cli] = {"title": d.get("title") or "", "name": sf.get("name") or "",
                       "local": d.get("sessionId", ""), "orchestrator": False}
    return by_cli


REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
TS = re.compile(rb'"timestamp":\s*"(\d{4}-\d\d-\d\dT[\d:.]+Z)"')


def transcripts(w_lo, w_hi):
    lo = w_lo.timestamp()
    files = glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")) + \
        glob.glob(os.path.join(PROJECTS, "*", "*", "subagents", "*.jsonl"))
    for f in files:
        try:
            st = os.stat(f)
        except OSError:
            continue
        if st.st_mtime < lo or st.st_birthtime > w_hi.timestamp():
            continue
        yield f


def text_of(c):
    if isinstance(c, str):
        return c
    return " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")


def tool_line(name, inp):
    for k in ("command", "file_path", "path", "pattern", "query", "url", "prompt", "description", "skill", "to", "message"):
        v = inp.get(k)
        if isinstance(v, str) and v:
            if name == "Bash" and inp.get("description"):
                return "%s: %s  # %s" % (name, v, inp["description"])
            return "%s %s: %s" % (name, k, v)
    return "%s %s" % (name, json.dumps(inp, ensure_ascii=False)[:300])


def events_of(path, w_lo, w_hi):
    lo_b, hi_b = w_lo.strftime("%Y-%m-%dT%H:%M:%S"), (w_hi + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S")
    with open(path, "rb") as f:
        for ln in f:
            m = TS.search(ln)
            if not m:
                continue
            s = m.group(1)[:19].decode()
            if s < lo_b or s > hi_b:
                continue
            try:
                d = json.loads(ln)
            except ValueError:
                continue
            ts = d.get("timestamp")
            t = d.get("type")
            if t not in ("user", "assistant") or not ts:
                continue
            wall = datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc) + \
                timedelta(seconds=float("0" + ts[19:].rstrip("Z")) if len(ts) > 20 else 0)
            if wall < w_lo or wall > w_hi:
                continue
            msg = d.get("message") or {}
            c = msg.get("content")
            if t == "user":
                if d.get("isMeta") or d.get("isCompactSummary"):
                    continue
                if isinstance(c, list) and c and all(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
                    for x in c:
                        r = x.get("content")
                        yield wall, "result", one_line(text_of(r) if r is not None else ""), {"err": bool(x.get("is_error"))}
                    continue
                raw = one_line(text_of(c))
                # the app prepends <system-reminder> blocks (linked sessions, notices) to real prompts
                txt = one_line(REMINDER.sub("", raw))
                if not raw:
                    continue
                org = d.get("origin") or {}
                typed = org.get("kind") == "human" or d.get("turnOrigin") in ("human", "sdk") or \
                    d.get("promptSource") == "sdk"
                if org.get("kind") == "task-notification" or d.get("turnOrigin") == "task_notification" \
                        or not txt or txt.startswith(("<cross-session-message", "Background (from the session")):
                    typed = False          # a notice, not words he wrote
                yield wall, "prompt", txt or raw, {"typed": typed, "from": d.get("turnOrigin") or org.get("kind") or ""}
            else:
                if not isinstance(c, list):
                    continue
                for x in c:
                    if not isinstance(x, dict):
                        continue
                    if x.get("type") == "text" and x.get("text", "").strip():
                        yield wall, "reply", one_line(x["text"]), {}
                    elif x.get("type") == "tool_use":
                        yield wall, "tool", one_line(tool_line(x.get("name", "?"), x.get("input") or {})), {}


def session_of(path, meta):
    p = path.split(os.sep)
    sub = "subagents" in p
    sid = p[p.index("subagents") - 1] if sub else os.path.basename(path)[:-6]
    m = meta.get(sid)
    proj = p[p.index("projects") + 1] if "projects" in p else ""
    if m:
        title = m["title"] or m["name"] or sid[:8]
        short = m["name"] or re.sub(r"\W+", "-", title.lower()).strip("-")[:24]
    else:
        title = short = "cli:%s/%s" % (proj.rsplit("-", 1)[-1], sid[:8])
    if sub:
        title, short = title + " >agent", short + ">agent"
    return sid, title, short


# ---------------------------------------------------------------- main

def fmt_vt(v):
    return "%d:%02d:%02d" % (v // 3600, v % 3600 // 60, v % 60) if v >= 3600 else "%d:%02d" % (v // 60, v % 60)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--take", required=True, help="take folder name (in ~/Desktop/Screen Recordings) or path")
    ap.add_argument("--grep", action="append", default=[], help="case-insensitive text; repeat for AND")
    ap.add_argument("--session", help="substring of session title, name or id")
    ap.add_argument("--kind", help="comma list of prompt,reply,tool,result")
    ap.add_argument("--from", dest="vfrom", type=float, help="video seconds")
    ap.add_argument("--to", dest="vto", type=float)
    ap.add_argument("--limit", type=int, default=300, help="max rows printed (default 300; the jsonl is never cut)")
    a = ap.parse_args()

    take = find_take(a.take)
    t0, wall0, dur = take_clock(take)
    w_hi = wall0 + timedelta(seconds=dur)
    focus, inputs = read_trace(take, t0)
    fvt = [f[0] for f in focus]
    meta = load_meta()

    rows = []
    for path in transcripts(wall0, w_hi):
        sid, title, short = session_of(path, meta)
        for wall, kind, txt, extra in events_of(path, wall0, w_hi):
            rows.append({"vt": round((wall - wall0).total_seconds(), 2), "wall": wall.astimezone().strftime("%H:%M:%S"),
                         "session": title, "name": short, "cli": sid, "kind": kind, "_t": txt, **extra})
    rows.sort(key=lambda r: r["vt"])

    # which session was on screen, per row
    typed_at = []
    for r in rows:
        if r["kind"] == "prompt" and r.get("typed"):
            i = bisect.bisect_left(inputs, r["vt"] - SEND_LEAD)
            if i < len(inputs) and inputs[i] <= r["vt"] + 1.0:
                typed_at.append((r["vt"], r["cli"]))
    tvt = [t[0] for t in typed_at]
    for r in rows:
        i = bisect.bisect_right(fvt, r["vt"]) - 1
        r["app"] = focus[i][1] if i >= 0 else ""
        j = bisect.bisect_right(tvt, r["vt"] + 0.5) - 1
        r["on_screen"] = bool(j >= 0 and typed_at[j][1] == r["cli"] and r["vt"] - tvt[j] <= STICKY and r["app"] == "Claude")
        txt, red = redact(r.pop("_t"))
        r["text"] = txt[:TEXT_MAX] + ("…" if len(txt) > TEXT_MAX else "")
        r["redacted"] = red
        r["take"] = os.path.basename(take)

    with open(os.path.join(take, OUT), "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    kinds = set(a.kind.split(",")) if a.kind else None
    needles = [g.lower() for g in a.grep]
    sess = a.session.lower() if a.session else None
    sel = [r for r in rows
           if (kinds is None or r["kind"] in kinds)
           and (a.vfrom is None or r["vt"] >= a.vfrom) and (a.vto is None or r["vt"] <= a.vto)
           and (sess is None or sess in (r["session"] + " " + r["name"] + " " + r["cli"]).lower())
           and all(n in r["text"].lower() or n in r["session"].lower() for n in needles)]

    print("# %s  wall0=%s  duration=%s  rows=%d  matched=%d  -> %s"
          % (os.path.basename(take), wall0.astimezone().strftime("%H:%M:%S"), fmt_vt(dur), len(rows), len(sel), OUT),
          file=sys.stderr)
    for r in sel[:a.limit]:
        snip = one_line(r["text"])
        snip = snip[:SNIP] + ("…" if len(snip) > SNIP else "")
        print("%8.1f %7s %s %s %-30.30s %-6s %s%s" % (r["vt"], fmt_vt(r["vt"]), r["wall"], "*" if r["on_screen"] else " ",
                                                       r["session"], r["kind"], snip, "  [redacted]" if r["redacted"] else ""))
    if len(sel) > a.limit:
        print("# … %d more (raise --limit, or narrow with --grep/--session/--from/--to)" % (len(sel) - a.limit), file=sys.stderr)


if __name__ == "__main__":
    main()
