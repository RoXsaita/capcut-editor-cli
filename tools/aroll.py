#!/usr/bin/env python3
"""
aroll — deterministic A-roll (talking head) cleanup.

One command, run twice. Code does the mechanical work; the agent only makes judgement calls.

    capcutctl cut VIDEO.mp4 [--lang ar]
        Transcribe with word timestamps, build the acoustic energy index, snap every
        boundary acoustically, delete dead air, detect takes and repeated beats, and
        write a handout for the agent to read.

    capcutctl cut VIDEO.mp4 --keep 0,2-9 --project NAME
        Apply the agent's selection, lint every seam, pack the timeline with no gaps,
        and build the CapCut project.

The division of labour that matters:
    Whisper decides WHICH WORDS.  The energy index decides EXACTLY WHERE.
Whisper's word starts are contiguous-filled and lie by up to ~0.7s. Every seam defect in
this project's history came from trusting them. Boundaries here come only from
onset_after() and trough().
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from difflib import SequenceMatcher
from itertools import pairwise
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audio_index import SOFT, AudioIndex, lint

FPS = 30.0
FRAME = 1.0 / FPS
LEAD_FRAMES = 2          # start this many frames before the onset, so the attack survives
HESITATION = 0.60        # silence longer than this inside a beat is dead air
HESITATION_KEEP = 0.25   # ...trimmed back to this
MIN_BEAT = 0.25          # anything shorter is a fragment, not a beat
DUPE_RATIO = 0.82        # normalised-text similarity that counts as the same line


# ---------------------------------------------------------------- helpers
def norm(text):
    """Arabic-friendly normalisation for duplicate detection."""
    t = unicodedata.normalize("NFKD", text)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[ـً-ٟ]", "", t)          # tatweel + diacritics
    t = t.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي").replace("ة", "ه")
    t = re.sub(r"[^\w\s]", " ", t)
    return re.sub(r"\s+", " ", t).strip().lower()


def quantise(t):
    """Whole frames, so CapCut never renders a half-frame seam."""
    return round(t * FPS) / FPS


DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


CREDIT = re.compile(r"ترجمة|نانسي")


def media_token(media):
    st = os.stat(media)
    return {"ino": st.st_ino, "size": st.st_size, "mtime": int(st.st_mtime)}


def transcribe(media, lang, model, cache_dir, force=False):
    """
    mlx_whisper on Apple silicon, running large-v3-turbo by default — accuracy matters
    most here because Whisper's Arabic is what duplicate detection reads. Falls back to
    the openai-whisper package if a plain model name is given or mlx is unavailable.
    """
    slug = re.sub(r"[^a-zA-Z0-9._-]", "-", model)
    cache = os.path.join(cache_dir, os.path.basename(media).rsplit(".", 1)[0] + f".whisper-{slug}.json")
    token = media_token(media)
    if not force and os.path.exists(cache):
        d = json.loads(Path(cache).read_text())
        if d.get("_token") == token:
            print(f"  transcript: cached ({model})", file=sys.stderr)
            return d

    mlx = shutil.which("mlx_whisper")
    if mlx and "/" in model:
        print(f"  transcribing with mlx_whisper {model} (lang={lang or 'auto'}) …", file=sys.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            cmd = [mlx, media, "--model", model, "--word-timestamps", "True",
                   "--output-format", "json", "--output-dir", tmp, "--output-name", "out"]
            if lang:
                cmd += ["--language", lang]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            out = os.path.join(tmp, "out.json")
            if proc.returncode != 0 or not os.path.exists(out):
                raise SystemExit(f"mlx_whisper failed:\n{proc.stderr[-2000:]}")
            result = json.loads(Path(out).read_text())
    else:
        import whisper
        print(f"  transcribing with openai-whisper:{model} (lang={lang or 'auto'}) …", file=sys.stderr)
        result = whisper.load_model(model).transcribe(
            media, language=lang, word_timestamps=True, verbose=False,
            condition_on_previous_text=False,      # stops one hallucination poisoning the rest
        )
    result["_token"] = token
    Path(cache).write_text(json.dumps(result, ensure_ascii=False))
    return result


# ---------------------------------------------------------------- indexing
def split_on_dead_air(idx, start, end):
    """Break a beat wherever it goes quiet for longer than a hesitation.

    Leading silence is dropped, not kept as a 0.25s 'beat' that then snaps
    onto the first syllable (Whisper starts can sit 0.7s early; HESITATION is 0.60).
    """
    on = idx.onset_after(start)
    if on is None or on >= end:
        return []
    start = max(start, on)
    spans, run_start, silence_from = [], start, None
    t = start
    while t < end:
        quiet = idx.at(t) < SOFT
        if quiet and silence_from is None:
            silence_from = t
        elif not quiet and silence_from is not None:
            if t - silence_from > HESITATION:
                spans.append((run_start, silence_from + HESITATION_KEEP))
                run_start = t
            silence_from = None
        t += idx.bin
    spans.append((run_start, end))
    out = []
    for a, b in spans:
        if b - a < MIN_BEAT:
            continue
        u = a
        spoke = False
        while u < b:
            if idx.at(u) >= SOFT:
                spoke = True
                break
            u += idx.bin
        if spoke:
            out.append((a, b))
    return out


def words_in(seg, a, b):
    """Text whose word timestamps fall in [a, b), not the parent Whisper segment."""
    picked = []
    for w in seg.get("words") or []:
        t = w.get("start")
        if t is None:
            continue
        if a - 0.05 <= t < b:
            picked.append((w.get("word") or w.get("text") or "").strip())
    text = " ".join(p for p in picked if p).strip()
    if text:
        return text
    parent = (seg.get("text") or "").strip()
    dur = max(1e-6, seg.get("end", b) - seg.get("start", a))
    return parent if (b - a) >= 0.8 * dur else ""


def snap(idx, a, b, floor=0.0):
    """
    IN on the next real onset (minus a lead). OUT by walking back from the
    next onset (or `b`) to a trough — not a ±0.20s window around Whisper's end.
    """
    on = idx.onset_after(max(floor, a - 0.30))
    if on is None:
        return None
    src_in = max(floor, 0.0, on - LEAD_FRAMES * FRAME)
    nxt = idx.onset_after(b)
    anchor = (nxt - 0.04) if nxt is not None and nxt > src_in + MIN_BEAT else b
    src_out = idx.trough(anchor, win=0.45)
    if src_out <= src_in:
        src_out = max(b, src_in + MIN_BEAT)
    return quantise(src_in), quantise(src_out)


def detect_takes(beats, gap=2.5):
    """A long silence, or the opening line coming round again, starts a new take."""
    if not beats:
        return []
    opener = norm(beats[0]["text"])[:40]
    takes, current = [], 0
    for i, beat in enumerate(beats):
        if i:
            silence = beat["src_in"] - beats[i - 1]["src_out"]
            restart = opener and SequenceMatcher(None, opener, norm(beat["text"])[:40]).ratio() > 0.75
            if silence > gap or (restart and i > 2):
                current += 1
        beat["take"] = current
        takes.append(current)
    return takes


def group_duplicates(beats):
    """Cluster beats that say the same thing. His rule: the LAST one wins."""
    groups = []
    for beat in beats:
        key = norm(beat["text"])
        placed = False
        for g in groups:
            if SequenceMatcher(None, key, g["key"]).ratio() >= DUPE_RATIO:
                g["members"].append(beat["id"])
                placed = True
                break
        if not placed:
            groups.append({"key": key, "members": [beat["id"]]})
    for gi, g in enumerate(groups):
        for bid in g["members"]:
            beats[bid]["dupe_group"] = gi if len(g["members"]) > 1 else None
            beats[bid]["is_last_of_group"] = (bid == g["members"][-1])
    return groups


def defects_for(idx, beat):
    """The three in-take faults worth flagging, from the locked procedure."""
    out = []
    if idx.head_silence(beat["src_in"]) > 0.30:
        out.append("dead air at IN")
    if idx.at(beat["src_out"]) > SOFT and idx.rising(beat["src_out"]):
        out.append("OUT cuts a rising envelope")
    words = [norm(w) for w in beat["text"].split()]
    if any(words[i] and words[i] == words[i + 1] for i in range(len(words) - 1)):
        out.append("stutter (repeated word)")
    if beat["src_out"] - beat["src_in"] < 0.45:
        out.append("very short")
    return out


def cmd_index(args):
    media = os.path.abspath(args.media)
    cache_dir = os.path.expanduser("~/Downloads/.video-index")
    os.makedirs(cache_dir, exist_ok=True)

    print(f"aroll index {os.path.basename(media)}", file=sys.stderr)
    idx = AudioIndex.build_or_load(media, force=getattr(args, "reindex", False))
    print(f"  energy index: {len(idx.db)} bins @ {int(idx.bin*1000)}ms = {len(idx.db)*idx.bin:.1f}s", file=sys.stderr)
    result = transcribe(media, args.lang, args.model, cache_dir, force=getattr(args, "reindex", False))

    beats = []
    for seg in result.get("segments", []):
        text = seg.get("text", "").strip()
        if not text or CREDIT.search(text):
            continue
        for a, b in split_on_dead_air(idx, seg["start"], seg["end"]):
            snapped = snap(idx, a, b, floor=beats[-1]["src_out"] if beats else 0.0)
            if snapped is None:
                continue
            src_in, src_out = snapped
            if src_out - src_in < MIN_BEAT:
                continue
            slice_text = words_in(seg, src_in, src_out) or text
            beats.append({
                "id": len(beats), "text": slice_text, "src_in": src_in, "src_out": src_out,
                "dur": round(src_out - src_in, 3), "take": 0,
                "dupe_group": None, "is_last_of_group": True, "defects": [],
            })
    detect_takes(beats)
    groups = group_duplicates(beats)
    for beat in beats:
        beat["defects"] = defects_for(idx, beat)

    # the default selection: last take, and the last instance of every repeated line
    last_take = max((b["take"] for b in beats), default=0)
    keep = [b["id"] for b in beats
            if b["take"] == last_take and b["is_last_of_group"] and "very short" not in b["defects"]]

    raw = sum(b["dur"] for b in beats)
    out = {
        "media": media, "fps": FPS,
        "source_duration": round(len(idx.db) * idx.bin, 3),
        "beats": beats,
        "takes": [{"id": t, "beats": [b["id"] for b in beats if b["take"] == t],
                   "duration": round(sum(b["dur"] for b in beats if b["take"] == t), 2)}
                  for t in sorted({b["take"] for b in beats})],
        "duplicate_groups": [g for g in groups if len(g["members"]) > 1],
        "default_keep": keep,
        "stats": {
            "beats": len(beats), "speech": round(raw, 2),
            "dead_air_removed": round(len(idx.db) * idx.bin - raw, 2),
            "default_cut_duration": round(sum(beats[i]["dur"] for i in keep), 2),
        },
    }
    path = args.out or os.path.join(os.path.dirname(media),
                                    os.path.basename(media).rsplit(".", 1)[0] + ".aroll.json")
    Path(path).write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print_handout(out, path)
    return 0


def compact(ids):
    """[0,2,3,4,5,9] -> '0,2-5,9' so the suggested command is short enough to edit."""
    if not ids:
        return ""
    runs, start, prev = [], ids[0], ids[0]
    for i in ids[1:]:
        if i == prev + 1:
            prev = i
            continue
        runs.append((start, prev)); start = prev = i
    runs.append((start, prev))
    return ",".join(str(a) if a == b else f"{a}-{b}" for a, b in runs)


def print_handout(data, path):
    s = data["stats"]
    print(f"\n{'='*78}\nA-ROLL HANDOUT — {os.path.basename(data['media'])}")
    print(f"source {data['source_duration']:.1f}s | speech {s['speech']:.1f}s | "
          f"dead air removed {s['dead_air_removed']:.1f}s | {s['beats']} beats")
    print("takes: " + ", ".join(f"#{t['id']} ({len(t['beats'])} beats, {t['duration']:.1f}s)"
                                 for t in data["takes"]))
    print(f"default keep: {len(data['default_keep'])} beats = {s['default_cut_duration']:.1f}s "
          f"(last take, last instance of every repeat)")
    if data["duplicate_groups"]:
        print("\nrepeated lines — LAST instance wins:")
        for g in data["duplicate_groups"]:
            print(f"   beats {g['members']}  \"{g['key']}\"")
    head = f"{'id':>3} {'take':>4} {'in':>8} {'out':>8} {'dur':>6}  {'keep':>4}  text"
    rows = []
    for b in data["beats"]:
        mark = "KEEP" if b["id"] in data["default_keep"] else "  · "
        flag = (" ⚠ " + "; ".join(b["defects"])) if b["defects"] else ""
        rows.append(f"{b['id']:>3} {b['take']:>4} {b['src_in']:>8.3f} {b['src_out']:>8.3f} "
                    f"{b['dur']:>6.2f}  {mark}  {b['text']}{flag}")
    # untruncated text runs past 78 columns, so size the rules to the table instead of
    # leaving rows hanging off the end of a rule that no longer means anything
    rule = "-" * max([78] + [len(r) for r in rows])
    print(f"\n{head}")
    print(rule)
    for r in rows:
        print(r)
    print(rule)
    print(f"wrote {path}")
    print(f"\nreview the text above, then build with your selection:\n"
          f"  capcutctl cut {os.path.basename(data['media'])} "
          f"--keep {compact(data['default_keep'])} --project NAME")


# ---------------------------------------------------------------- cutting
def parse_ids(spec):
    out = set()
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            bits = part.split("-")
            if len(bits) != 2:
                raise ValueError(f"bad id range {part!r}")
            a, b = int(bits[0]), int(bits[1])
            if b < a:
                raise ValueError(f"reversed id range {part!r}")
            out.update(range(a, b + 1))
        else:
            out.add(int(part))
    return out


def repair(idx, picked):
    """
    Apply the lint's own suggestions. These are mechanical — the trough and the onset are
    computed, not judged — so there is no reason to hand them back to a human.
    A boundary is only moved when it cannot collide with the neighbouring kept beat.
    """
    fixed = []
    for i, b in enumerate(picked):
        nxt = picked[i + 1] if i + 1 < len(picked) else None
        prev = picked[i - 1] if i else None

        # OUT sitting on a rising envelope -> slide to the nearby trough
        if idx.at(b["src_out"]) > SOFT and idx.rising(b["src_out"]):
            tr = quantise(idx.trough(b["src_out"]))
            ceiling = nxt["src_in"] if nxt else b["src_out"] + 0.5
            if b["src_in"] < tr <= ceiling and idx.at(tr) < idx.at(b["src_out"]) - 6.0 and tr != b["src_out"]:
                fixed.append(f"b{b['id']} OUT {b['src_out']:.3f} -> {tr:.3f} (trough, {idx.at(tr):.0f}dB)")
                b["src_out"] = tr

        # dead air at the head -> slide IN forward to the real onset
        head = idx.head_silence(b["src_in"])
        if head > 0.30:
            on = idx.onset_after(b["src_in"])
            if on is not None:
                new_in = quantise(max(prev["src_out"] if prev else 0.0, on - LEAD_FRAMES * FRAME))
                if b["src_in"] < new_in < b["src_out"] - MIN_BEAT:
                    fixed.append(f"b{b['id']} IN {b['src_in']:.3f} -> {new_in:.3f} (cuts {head:.2f}s dead air)")
                    b["src_in"] = new_in
    return fixed


def cmd_cut(args):
    data = json.loads(Path(args.index).read_text())
    beats = {b["id"]: b for b in data["beats"]}
    keep = parse_ids(args.keep) if args.keep else set(data["default_keep"])
    if args.drop:
        keep -= parse_ids(args.drop)
    keep = [i for i in sorted(keep) if i in beats]
    if not keep:
        print("nothing kept", file=sys.stderr)
        return 2

    idx = AudioIndex.build_or_load(data["media"])
    picked = [dict(beats[i]) for i in keep]

    if not args.no_repair:
        repairs = repair(idx, picked)
        for r in repairs:
            print("  fixed: " + r)
        for b, p in zip(keep, picked, strict=True):
            beats[b]["src_in"], beats[b]["src_out"] = p["src_in"], p["src_out"]

    spans = [(f"b{p['id']}", p["src_in"], p["src_out"]) for p in picked]
    findings = lint(idx, spans, fps=data["fps"])
    for (la, _, ea), (lb, sb, _) in pairwise(spans):
        if sb < ea:
            findings.append(f"{la}->{lb} OVERLAP {ea - sb:.3f}s of source is used twice")

    # pack the timeline with no gaps — this is the dead-space removal
    timeline, cursor = [], 0.0
    for i in keep:
        b = beats[i]
        dur = quantise(b["src_out"] - b["src_in"])
        timeline.append({"beat": i, "tl_in": round(cursor, 3), "tl_out": round(cursor + dur, 3),
                         "src_in": b["src_in"], "dur": round(dur, 3), "text": b["text"]})
        cursor += dur

    scenes = ",".join(f"{t['tl_in']:.3f}:{t['tl_out']:.3f}@{t['src_in']:.3f}" for t in timeline)
    plan = {"media": data["media"], "kept": keep, "timeline": timeline,
            "duration": round(cursor, 3), "lint": findings, "scenes": scenes}
    plan_path = args.plan or args.index.replace(".aroll.json", ".plan.json")
    Path(plan_path).write_text(json.dumps(plan, ensure_ascii=False, indent=1))

    print(f"kept {len(keep)} beats -> {cursor:.2f}s (source {data['source_duration']:.1f}s)")
    for t in timeline:
        # never slice the text: [:46] cut Arabic mid-word, and this is the table he actually
        # reads back after choosing beats. Text is the last field, so the numbers still line up.
        print(f"  {t['tl_in']:>7.3f}->{t['tl_out']:>7.3f}  src {t['src_in']:>8.3f}  {t['text']}")
    print(f"\nseam lint: {'CLEAN' if not findings else str(len(findings)) + ' findings'}")
    for f in findings:
        print("  ! " + f)
    print(f"wrote {plan_path}")

    if args.project:
        if findings and not args.force:
            print("\nrefusing to build with unresolved seam findings; re-run with --force to override",
                  file=sys.stderr)
            return 1
        cmd = ["capcutctl", "new", "--project", args.project,
               "--media", data["media"], "--scenes", scenes]
        if args.dry_run:
            cmd.append("--dry-run")
        print("\n$ " + " ".join(cmd[:6]) + f" --scenes <{len(timeline)} scenes>")
        r = subprocess.run(cmd, capture_output=True, text=True)
        print(r.stdout or r.stderr)
        return r.returncode
    return 0


def cmd_selftest(args):
    """Guards the pure logic. The overlap bug below shipped silently once already."""
    ok = []
    def check(name, cond):
        ok.append(cond)
        print(f"  {'PASS' if cond else 'FAIL'}  {name}")

    check("parse_ids ranges", parse_ids("1,3-5,9") == {1, 3, 4, 5, 9})
    try:
        parse_ids("9-2")
        check("parse_ids rejects reversed ranges", False)
    except ValueError:
        check("parse_ids rejects reversed ranges", True)
    check("quantise snaps to frames", abs(quantise(1.0 / 30 * 2.4) - 2 / 30) < 1e-9)
    check("norm folds arabic orthography", norm("أَحْلَى") == norm("احلى"))
    check("norm strips punctuation", norm("hello, world!") == "hello world")
    check("credit line is dropped", bool(CREDIT.search("ترجمة نانسي قنقر")))

    class Fake:
        """silence, speech 1.0-2.0, silence, speech 3.0-4.0, silence"""
        bin = 0.01
        def at(self, t): return -20.0 if (1.0 <= t < 2.0 or 3.0 <= t < 4.0) else -70.0
        def rising(self, t, span=0.10): return False
        def head_silence(self, t, thresh=SOFT, cap=2.0):
            n = 0
            while n * self.bin < cap and self.at(t + n * self.bin) < thresh: n += 1
            return n * self.bin
        def tail_silence(self, t, thresh=SOFT, cap=2.0):
            n = 0
            while n * self.bin < cap and self.at(t - (n + 1) * self.bin) < thresh: n += 1
            return n * self.bin
        def onset_after(self, t, thresh=SOFT, cap=3.0):
            n = 0
            while n * self.bin < cap:
                if self.at(t + n * self.bin) >= thresh: return t + n * self.bin
                n += 1
            return None
        def trough(self, t, win=0.20): return t

    fake = Fake()
    spans = split_on_dead_air(fake, 0.5, 4.5)
    check("dead air splits one beat into two", len(spans) == 2)
    check("leading silence is not its own beat", abs(spans[0][0] - 1.0) < 0.02)

    a1, b1 = snap(fake, 0.9, 2.1)
    a2, _ = snap(fake, 2.9, 4.1, floor=b1)
    check("snap finds the onset", abs(a1 - (1.0 - LEAD_FRAMES * FRAME)) < 0.05)
    check("consecutive beats never overlap", a2 >= b1)

    seg = {"start": 0.5, "end": 4.5, "text": "hello world and more",
           "words": [{"start": 1.1, "word": "hello"}, {"start": 3.2, "word": "world"}]}
    check("words_in uses the window not the parent", words_in(seg, 1.0, 2.2) == "hello")

    from audio_index import lint as lint_seams
    findings = lint_seams(fake, [("a", 3.5, 4.5), ("b", 8.0, 8.5)])
    check("lint reports no-onset rather than crashing",
          any("no onset" in f for f in findings))

    print("selftest:", "all passed" if all(ok) else "FAILURES")
    return 0 if all(ok) else 1


def main():
    ap = argparse.ArgumentParser(
        prog="capcutctl cut",
        description="One command. Run it on a video to get a review table; run it again "
                    "with --keep to build the project.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("media", nargs="?", help="the talking-head recording")
    ap.add_argument("--keep", help="beat ids to keep, e.g. 0,2,3,7-16")
    ap.add_argument("--drop", help="beat ids to remove from the default selection")
    ap.add_argument("--project", help="build this CapCut project from the selection")
    ap.add_argument("--lang", default=None, help="e.g. ar; omit to auto-detect")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"default {DEFAULT_MODEL}")
    ap.add_argument("--reindex", action="store_true", help="ignore the cached index")
    ap.add_argument("--no-repair", action="store_true", help="do not auto-fix seam faults")
    ap.add_argument("--force", action="store_true", help="build despite seam findings")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true", help="check the pure logic")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(cmd_selftest(args))
    if not args.media:
        ap.error("a media path is required")

    media = os.path.abspath(args.media)
    if not os.path.exists(media):
        ap.error(f"no such file: {media}")
    args.index = os.path.join(os.path.dirname(media),
                              os.path.basename(media).rsplit(".", 1)[0] + ".aroll.json")
    args.out = args.index
    args.media = media

    # index once, reuse thereafter — the expensive half never runs twice
    if args.reindex or not os.path.exists(args.index):
        cmd_index(args)
        if not (args.keep or args.drop or args.project):
            sys.exit(0)
        print()
    elif not (args.keep or args.drop or args.project):
        print_handout(json.loads(Path(args.index).read_text()), args.index)
        sys.exit(0)

    args.plan = None
    sys.exit(cmd_cut(args))


if __name__ == "__main__":
    main()
