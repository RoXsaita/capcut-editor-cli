#!/usr/bin/env python3
"""Keyframe picker for the watcher tier. Local, no model.

From an rl2 take (change.ndjson + trace.ndjson + screen-clean.mp4) pick the moments worth a look:
  focus   - an app switch (focus_change), sampled once the screen settles
  settle  - the screen settling after a big change (>= BIG_BLOCKS of 64 blocks, or score >= BIG_SCORE)
  prompt  - his own words: a long typed burst, or a dictation (record-button click) up to the
            Enter/Send that ships it; sampled with the text still in the composer
  typing  - the end of a typing burst (>= 5 keys)
  scroll  - the end of a scroll burst (>= 5 ticks)
  drift   - nothing picked for a while but the screen kept changing (streaming agent output)
Then: merge near ones, drop ones where nothing changed since the last pick (block masks), cap at
--per-15 per 15-min window by priority, extract 1280-px JPEGs, OCR them on device, drop OCR
near-duplicates, and run the privacy gates (privacy.py). A frame whose frontmost app is unknown is
marked no_image (watch.py sends its text only): the app gate is the only cover for a frame with no
readable text. Writes to --out:
  keyframes/kNN.jpg, keyframes.json, timeline.json, privacy.json, pick-stats.json

Dropped frames are decoded into a temp dir and deleted; they never reach --out.

usage: pick.py <take-dir> --out <dir> [--per-15 30]
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import privacy

BIG_BLOCKS = 12      # of 64 (8x8 mask)
BIG_SCORE = 7.0      # ~99th percentile on 165029
QUIET_BLOCKS = 1     # Claude's streaming text / spinner keeps 1 block busy ~30% of frames
QUIET_SCORE = 0.5
SETTLE_S = 0.8
MERGE_S = 3.0
DRIFT_GAP_S = 75.0
DRIFT_MIN_BLOCKS = 6
PRIORITY = {"prompt": 0, "focus": 1, "settle": 2, "typing": 3, "scroll": 4, "drift": 5}
RECORD_TITLE = re.compile(r"press and hold to record|dictat|voice mode", re.I)
SEND_TITLE = re.compile(r"^send( message)?$", re.I)
PROMPT_KEYS = 20      # a typed burst this long is him writing a prompt, not a shortcut
OVERSAMPLE = 1.6      # privacy + OCR dupes drop frames after the cap; pick extra, trim after
WIDTH = 1280
HERE = os.path.dirname(os.path.abspath(__file__))


def take_start(take_dir):
    """Wall-clock start = folder-name timestamp (local). session.json created_wall is stamped after
    the cursor render and can be ~30 min late."""
    m = re.search(r"(\d{8})-(\d{6})", os.path.basename(take_dir.rstrip("/")))
    return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S") if m else None


def load_take(take_dir):
    session = json.loads(Path(take_dir, "session.json").read_text())
    t0 = session["clock"]["first_frame_host"]
    frames = []
    for line in Path(take_dir, "change.ndjson").read_text().splitlines():
        d = json.loads(line)
        frames.append((d["vt"], d["score"], d["blocks"], int(d["mask"], 16)))
    events = []
    for line in Path(take_dir, "trace.ndjson").read_text().splitlines():
        d = json.loads(line)
        if d.get("type") in ("focus_change", "typing_burst", "scroll_burst", "click", "drag", "session_end"):
            d.pop("samples", None)
            d["vt"] = d["host"] - t0
            if "end" in d:
                d["vt_end"] = d["end"] - t0
            events.append(d)
    events.sort(key=lambda e: e["vt"])
    duration = frames[-1][0] if frames else 0
    for e in events:
        if e["type"] == "session_end":
            duration = max(duration, e["vt"])
    return session, frames, events, duration


def settle_after(frames, idx_from_vt, t, max_wait):
    """First time >= t where the next SETTLE_S of frames are all quiet. rl2 is VFR: a gap with no
    frames means nothing changed, which counts as quiet."""
    i = idx_from_vt(t)
    limit = t + max_wait
    cand = t
    while cand <= limit:
        j = i
        ok = True
        while j < len(frames) and frames[j][0] <= cand + SETTLE_S:
            vt, score, blocks, _ = frames[j]
            if vt > cand and (blocks > QUIET_BLOCKS or score >= QUIET_SCORE):
                ok = False
                cand = vt
                i = j
                break
            j += 1
        if ok:
            return cand + 0.1
        i = max(i, idx_from_vt(cand))
    return limit


def union_mask(frames, idx_from_vt, a, b):
    m = 0
    for j in range(idx_from_vt(a), idx_from_vt(b) + 1):
        if j < len(frames) and a < frames[j][0] <= b:
            m |= frames[j][3]
    return bin(m).count("1")


def candidates(frames, events, duration):
    import bisect
    vts = [f[0] for f in frames]

    def idx(t):
        return max(0, bisect.bisect_left(vts, t))

    out = []
    # big-change episodes -> settle
    i, n = 0, len(frames)
    while i < n:
        vt, score, blocks, _ = frames[i]
        if blocks >= BIG_BLOCKS or score >= BIG_SCORE:
            end = vt
            peak = blocks
            j = i + 1
            while j < n and frames[j][0] - end <= 1.0:
                if frames[j][2] >= BIG_BLOCKS or frames[j][1] >= BIG_SCORE:
                    end = frames[j][0]
                    peak = max(peak, frames[j][2])
                j += 1
            out.append({"vt": settle_after(frames, idx, end, 6.0), "reason": "settle", "peak_blocks": peak})
            i = j
        else:
            i += 1
    last_record = -1e9
    for e in events:
        title = ((e.get("target") or {}).get("title") or "") if e["type"] == "click" else ""
        if title and RECORD_TITLE.search(title):
            last_record = e["vt"]
            out.append({"vt": settle_after(frames, idx, e["vt"] + 0.5, 3.0), "reason": "prompt"})
        elif (title and SEND_TITLE.search(title)) or (
                e["type"] == "typing_burst" and e.get("keys", 0) <= 2 and e["vt"] - last_record < 180):
            out.append({"vt": max(0.0, e["vt"] - 0.25), "reason": "prompt"})  # composer still full
            out.append({"vt": settle_after(frames, idx, e["vt"] + 0.6, 3.0), "reason": "settle"})
            last_record = -1e9
        elif e["type"] == "typing_burst" and e.get("keys", 0) >= PROMPT_KEYS:
            out.append({"vt": settle_after(frames, idx, e["vt_end"] + 0.6, 3.0), "reason": "prompt", "keys": e["keys"]})
        elif e["type"] == "focus_change":
            out.append({"vt": settle_after(frames, idx, e["vt"] + 0.3, 4.0), "reason": "focus", "app": e["app"]})
        elif e["type"] == "typing_burst" and e.get("keys", 0) >= 5:
            out.append({"vt": settle_after(frames, idx, e["vt_end"] + 0.6, 3.0), "reason": "typing", "keys": e["keys"]})
        elif e["type"] == "scroll_burst" and e.get("ticks", 0) >= 5:
            out.append({"vt": settle_after(frames, idx, e["vt_end"] + 0.6, 3.0), "reason": "scroll", "ticks": e["ticks"]})
    out = [c for c in out if 0 <= c["vt"] <= duration - 0.05]
    out.sort(key=lambda c: c["vt"])
    # drift: long gaps where the screen still changed (agent output streaming in)
    drift = []
    prev = 0.0
    for c in [*out, {"vt": duration}]:
        t = prev + DRIFT_GAP_S
        while c["vt"] - t > 10:
            if union_mask(frames, idx, prev, t) >= DRIFT_MIN_BLOCKS:
                drift.append({"vt": settle_after(frames, idx, t, 4.0), "reason": "drift"})
                prev = t
            t += DRIFT_GAP_S
        prev = c["vt"]
    out = sorted(out + drift, key=lambda c: c["vt"])
    return out, idx


def merge(cands):
    """Cluster picks within MERGE_S; keep the latest time (most settled), best reason first."""
    merged = []
    for c in cands:
        if merged and c["vt"] - merged[-1]["vt_first"] <= MERGE_S:
            m = merged[-1]
            m["reasons"].append(c["reason"])
            m["vt"] = c["vt"]
            for k in ("app", "keys", "ticks", "peak_blocks"):
                if k in c:
                    m[k] = c[k]
        else:
            m = dict(c)
            m["reasons"] = [c["reason"]]
            m["vt_first"] = c["vt"]
            merged.append(m)
    for m in merged:
        m["reasons"] = sorted(set(m["reasons"]), key=PRIORITY.get)
        m["priority"] = PRIORITY[m["reasons"][0]]
        m.pop("reason", None)
        m.pop("vt_first", None)
    return merged


UNKNOWN_APP = "?unknown"


def _names_app(e):
    return e["type"] == "focus_change" or (e["type"] in ("click", "drag") and e.get("app"))


def frontmost(events, t):
    """Frontmost app at t. Before the first focus_change of a take rl2 says nothing, so: the app of
    the first later click/drag if no focus_change comes before it (that app was already in front),
    else UNKNOWN_APP."""
    app = None
    for e in events:
        if e["vt"] > t:
            break
        if _names_app(e):
            app = e["app"]
    if app:
        return app
    nxt = next((e for e in events if e["vt"] > t and _names_app(e)), None)
    return nxt["app"] if nxt and nxt["type"] != "focus_change" else UNKNOWN_APP


def gate_app(app, apps):
    """Gate 1 -> (rule, no_image). An unknown app is not dropped (most of a take would go), but the
    frame is never sent as an image: OCR is then the only gate, and it is blind to text-free screens."""
    if rule := privacy.check_app(app, apps):
        return rule, False
    return None, app == UNKNOWN_APP


def build_timeline(events, apps, rules):
    """Compact app/action timeline for the model. Generic AXGroup/AXStaticText clicks are dropped;
    clicks on titled controls are kept (the nearest thing rl2 has to window titles)."""
    tl, filtered = [], []
    last_title = None
    for e in events:
        t = round(e["vt"], 1)
        app_rule = privacy.check_app(e.get("app"), apps)
        app = f"[withheld: {app_rule}]" if app_rule else e.get("app")
        if e["type"] == "focus_change":
            if app_rule:
                filtered.append({"stage": "trace", "vt": t, "rule": app_rule, "what": "focus_change"})
            tl.append({"vt": t, "ev": "app", "app": app})
        elif e["type"] == "typing_burst" and e.get("keys", 0) >= 3:
            tl.append({"vt": t, "ev": "typed", "keys": e["keys"], "secs": round(e["vt_end"] - e["vt"], 1)})
        elif e["type"] == "scroll_burst" and e.get("ticks", 0) >= 5:
            tl.append({"vt": t, "ev": "scrolled", "ticks": e["ticks"]})
        elif e["type"] == "drag":
            if app_rule:
                filtered.append({"stage": "trace", "vt": t, "rule": app_rule, "what": "drag"})
            tl.append({"vt": t, "ev": "dragged", "app": app, "px": round(e.get("distance", 0))})
        elif e["type"] == "click":
            title = (e.get("target") or {}).get("title")
            if not title or title == last_title:
                continue
            last_title = title
            rule = app_rule or privacy.check_text(title, rules)
            if rule:
                filtered.append({"stage": "trace", "vt": t, "rule": rule, "what": "click title"})
                title = f"[withheld: {rule}]"
            tl.append({"vt": t, "ev": "clicked", "app": app, "control": title[:90]})
    return tl, filtered


def ocr_binary():
    cache = os.path.expanduser("~/.cache/capcutctl/watcher")
    os.makedirs(cache, exist_ok=True)
    src = os.path.join(HERE, "ocr.swift")
    exe = os.path.join(cache, "ocr")
    if not os.path.exists(exe) or os.path.getmtime(exe) < os.path.getmtime(src):
        subprocess.run(["swiftc", "-O", "-o", exe, src], check=True)
    return exe


def extract(video, vt, dst):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{vt:.3f}", "-i", video, "-frames:v", "1",
                    "-vf", f"scale={WIDTH}:-2", "-q:v", "4", dst], check=True)


def ocr_lines(rec, min_conf=0.3):
    return [ln["text"].strip() for ln in rec["lines"] if ln["conf"] >= min_conf and ln["text"].strip()]


def gate_ocr(rec, rules, min_conf=0.3):
    """Gate 2 -> (stage, rule, lines). stage is None when the frame passes; lines are then the text
    kept for dedupe and the prompt (min_conf applies here only). The gate itself reads every line,
    whatever its confidence: a half-read "payment method" is still a billing page. A missing or
    failed OCR record drops the frame, since an unread frame is not a text-free one."""
    if rec is None:
        return "ocr-missing", "ocr-missing", []
    if rec.get("error") or not isinstance(rec.get("lines"), list):
        return "ocr-error", f"ocr-{rec.get('error') or 'malformed'}", []
    every = [(ln.get("text") or "").strip() for ln in rec["lines"]]
    if rule := privacy.check_text("\n".join(x for x in every if x), rules):
        return "ocr", rule, []
    return None, None, ocr_lines(rec, min_conf)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("take")
    ap.add_argument("--out", required=True)
    ap.add_argument("--per-15", type=int, default=30, help="cap on keyframes per 15 minutes")
    a = ap.parse_args()
    take = a.take.rstrip("/")
    name = os.path.basename(take)
    timing = {}
    t = time.time()
    _session, frames, events, duration = load_take(take)
    apps, rules = privacy.load()
    cands, idx = candidates(frames, events, duration)
    merged = merge(cands)
    timing["parse_pick_s"] = round(time.time() - t, 2)
    stats = {"take": name, "duration_s": round(duration, 1), "candidates": len(cands), "merged": len(merged)}

    # drop picks where nothing changed since the previous kept pick (unless it's an app switch)
    kept, prev = [], 0.0
    for m in merged:
        changed = union_mask(frames, idx, prev, m["vt"])
        m["changed_blocks"] = changed
        if changed <= 1 and m["priority"] > 0 and kept:
            continue
        kept.append(m)
        prev = m["vt"]
    stats["after_mask_dedupe"] = len(kept)

    # cap per 15-min window by priority, then by how much changed. Oversample here; trim to the
    # real cap after the privacy and OCR-dupe drops so they don't eat the window's budget.
    caps, capped = {}, []
    for w in range(int(duration // 900) + 1):
        inwin = [k for k in kept if w * 900 <= k["vt"] < (w + 1) * 900]
        span = min(900, duration - w * 900)
        # pro-rata for a partial window, with a floor: a 50-s take still gets a handful of looks
        caps[w] = max(min(6, a.per_15), round(a.per_15 * span / 900))
        inwin.sort(key=lambda k: (k["priority"], -k["changed_blocks"]))
        capped += inwin[:int(caps[w] * OVERSAMPLE + 0.999)]
    capped.sort(key=lambda k: k["vt"])
    stats["after_cap"] = len(capped)

    filtered = []
    for k in capped:
        k["app"] = frontmost(events, k["vt"])
    # gate 1: app denylist, before decoding anything
    gated = []
    for k in capped:
        rule, k["no_image"] = gate_app(k["app"], apps)
        if rule:
            filtered.append({"stage": "app", "vt": round(k["vt"], 1), "rule": rule})
        else:
            gated.append(k)

    os.makedirs(os.path.join(a.out, "keyframes"), exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="watcher-")
    try:
        t = time.time()
        for i, k in enumerate(gated):
            k["tmp"] = os.path.join(tmp, f"c{i:03d}.jpg")
            extract(os.path.join(take, "screen-clean.mp4"), k["vt"], k["tmp"])
        timing["extract_s"] = round(time.time() - t, 2)
        t = time.time()
        exe = ocr_binary()
        recs = {}
        if gated:
            res = subprocess.run([exe] + [k["tmp"] for k in gated], check=True, capture_output=True, text=True)
            recs = {json.loads(ln)["file"]: json.loads(ln) for ln in res.stdout.splitlines() if ln.strip()}
        timing["ocr_s"] = round(time.time() - t, 2)
        final, prev_lines = [], set()
        for k in gated:
            # gate 2: OCR text. A frame with no known app keeps every line (it goes as text only)
            stage, rule, lines = gate_ocr(recs.get(os.path.basename(k["tmp"])), rules,
                                          min_conf=0 if k["no_image"] else 0.3)
            if stage:
                filtered.append({"stage": stage, "vt": round(k["vt"], 1), "rule": rule, "app": k["app"]})
                continue
            s = set(lines)
            if prev_lines and k["priority"] > 0 and s and len(s & prev_lines) / len(s | prev_lines) >= 0.92:
                stats["ocr_dupes"] = stats.get("ocr_dupes", 0) + 1
                continue
            prev_lines = s
            k["ocr"] = lines
            final.append(k)
        trimmed = []
        for w, cap in caps.items():
            inwin = sorted((k for k in final if w * 900 <= k["vt"] < (w + 1) * 900),
                           key=lambda k: (k["priority"], -k["changed_blocks"]))
            trimmed += inwin[:cap]
        final = sorted(trimmed, key=lambda k: k["vt"])
        stats["final"] = len(final)
        start = take_start(take)
        out = []
        for n, k in enumerate(final, 1):
            kid = f"k{n:02d}"
            shutil.move(k["tmp"], os.path.join(a.out, "keyframes", f"{kid}.jpg"))
            rec = {"id": kid, "take": name, "vt": round(k["vt"], 2), "app": k["app"], "reasons": k["reasons"],
                   "changed_blocks": k["changed_blocks"], "ocr": k["ocr"]}
            if k["no_image"]:
                rec["no_image"] = True
            for f in ("keys", "ticks", "peak_blocks"):
                if f in k:
                    rec[f] = k[f]
            if start:
                rec["wall"] = (start + timedelta(seconds=k["vt"])).strftime("%Y-%m-%d %H:%M:%S")
            out.append(rec)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    tl, tl_filtered = build_timeline(events, apps, rules)
    filtered += tl_filtered
    stats["filtered"] = len(filtered)
    stats["timing"] = timing
    Path(a.out, "keyframes.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    Path(a.out, "timeline.json").write_text(json.dumps(
        {"take": name, "start": start.isoformat() if start else None, "duration_s": round(duration, 1),
         "events": tl}, indent=1, ensure_ascii=False))
    Path(a.out, "privacy.json").write_text(json.dumps(sorted(filtered, key=lambda f: f["vt"]), indent=1))
    Path(a.out, "pick-stats.json").write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
