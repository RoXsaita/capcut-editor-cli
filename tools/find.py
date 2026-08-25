#!/usr/bin/env python3
"""
capcutctl find — where does this phrase happen?

Two haystacks, one answer shape:
  --says   the Whisper transcript of a talking-head recording  (what was SAID, and when)
  --shows  the OCR index of a screen recording                 (what was ON SCREEN, and when)

This exists because doing it by hand got a shot wrong. A coarse OCR search reported
"reading files 168-318"; source 168 is actually the sidebar drawer, and the file list
does not start until 176. The B-roll sat on the wrong content until frames were checked.
Runs are collapsed and reported with their FIRST STABLE second, not the first flicker.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CACHE = os.path.expanduser("~/Downloads/.video-index")


def load_ocr(media):
    stem = os.path.basename(media).rsplit(".", 1)[0]
    path = os.path.join(CACHE, stem + ".ocr.json")
    if not os.path.exists(path):
        raise SystemExit(f"no OCR index for {stem}. Expected {path}")
    return {int(k): v.lower() for k, v in json.loads(Path(path).read_text()).items()}


def load_transcript(media):
    stem = os.path.basename(media).rsplit(".", 1)[0]
    for name in sorted(os.listdir(CACHE)):
        if name.startswith(stem) and ".whisper" in name:
            return json.load(open(os.path.join(CACHE, name)))
    legacy = os.path.join(CACHE, stem.split("-")[0] + "_transcript_ar.json")
    if os.path.exists(legacy):
        return json.loads(Path(legacy).read_text())
    raise SystemExit(f"no transcript for {stem}. Run `capcutctl cut {media}` first.")


def collapse(hits, gap=3):
    runs = []
    for t in sorted(hits):
        if runs and t - runs[-1][1] <= gap:
            runs[-1][1] = t
        else:
            runs.append([t, t])
    return runs


def main():
    ap = argparse.ArgumentParser(prog="capcutctl find")
    ap.add_argument("query", help="text to look for (case-insensitive, all words must appear)")
    ap.add_argument("--media", required=True)
    ap.add_argument("--shows", action="store_true", help="search the OCR index (screen recording)")
    ap.add_argument("--says", action="store_true", help="search the transcript (talking head)")
    ap.add_argument("--settle", type=float, default=2.0,
                    help="seconds a run must persist before its start is reported as stable")
    ap.add_argument("--context", action="store_true", help="print the matching line(s)")
    ap.add_argument("--strip", nargs="?", const="find-strip.png", default=None,
                    help="grab a frame at each run and write a contact sheet — OCR matches text "
                         "that can be occluded or scrolled off, so LOOK before you cut")
    a = ap.parse_args()
    if not (a.shows or a.says):
        a.shows = True
    terms = [w for w in a.query.lower().split() if w]

    if a.says:
        tr = load_transcript(a.media)
        rows = []
        for seg in tr.get("segments", []):
            for w in seg.get("words", []) or []:
                if all(t in w["word"].lower() for t in terms) or a.query.lower() in w["word"].lower():
                    rows.append((round(w["start"], 2), w["word"].strip(), seg["text"].strip()))
        if not rows:
            for seg in tr.get("segments", []):
                if all(t in seg["text"].lower() for t in terms):
                    rows.append((round(seg["start"], 2), "(segment)", seg["text"].strip()))
        print(f"{len(rows)} spoken match(es) in {os.path.basename(a.media)}")
        for t, word, line in rows[:40]:
            print(f"  {t:8.2f}s  {word}" + (f"   — {line[:70]}" if a.context else ""))
        return

    idx = load_ocr(a.media)
    hits = [t for t in idx if all(x in idx[t] for x in terms)]
    runs = collapse(hits)
    picks = []
    print(f"{len(runs)} run(s) on screen in {os.path.basename(a.media)}  "
          f"(index {min(idx)}-{max(idx)}s)")
    for lo, hi in runs[:25]:
        stable = next((t for t in range(lo, hi + 1)
                       if all(all(x in idx.get(t + k, "") for x in terms)
                              for k in range(int(a.settle)))), lo)
        held = hi - lo + 1
        mark = "" if stable == lo else f"  (flickers from {lo}s)"
        print(f"  {stable:6d}s -> {hi:6d}s   held {held:4d}s{mark}")
        if a.context:
            line = re.sub(r"\s+", " ", idx.get(stable, ""))
            print(f"           {line[:100]}")
        picks.append((stable, f"{stable}s ({held}s)"))

    if a.strip and picks:
        from frame_qa import contact_sheet
        out = os.path.abspath(a.strip)
        tmp = os.path.join(os.environ.get("TMPDIR", "/tmp"), "capcutctl-find")
        os.makedirs(tmp, exist_ok=True)
        tiles = []
        for t, label in picks[:12]:
            f = os.path.join(tmp, f"f{t}.png")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", a.media,
                            "-frames:v", "1", f], check=True)
            tiles.append((f, label))
        print(f"\n  -> {contact_sheet(tiles, out)}")
        print("     OCR sees text it cannot see is occluded. Check the frames before you cut.")


if __name__ == "__main__":
    main()
