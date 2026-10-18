#!/usr/bin/env python3
"""Watcher runner: pick + watch for one or more rl2 takes, then a cost/timing summary.

usage: run.py <take-dir>... [--out productions/watcher-v0] [--modes mixed] [--per-15 30]
  e.g. run.py ~/Desktop/Screen\\ Recordings/screen-20261017-165029 --modes mixed,ocr,images

Each take lands in <out>/<take>/ (keyframes, OCR, timeline, privacy log, journal-<mode>.md/.json).
<out>/summary.json collects keyframes per 15 min, tokens, list cost and wall time per window.
Nothing is scheduled; run it by hand. Never reads or writes outside the take (read-only) and --out.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("takes", nargs="+")
    ap.add_argument("--out", default="productions/watcher-v0")
    ap.add_argument("--modes", default="mixed")
    ap.add_argument("--per-15", default="30")
    ap.add_argument("--model", default="claude-haiku-5-5")
    a = ap.parse_args()
    summary_path = os.path.join(a.out, "summary.json")
    summary = json.loads(Path(summary_path).read_text()) if os.path.exists(summary_path) else {}
    for take in a.takes:
        name = os.path.basename(take.rstrip("/"))
        dst = os.path.join(a.out, name)
        t = time.time()
        pick = subprocess.run([sys.executable, os.path.join(HERE, "pick.py"), take, "--out", dst,
                               "--per-15", a.per_15], check=True, capture_output=True, text=True)
        entry = {"pick": json.loads(pick.stdout.strip().splitlines()[-1]), "pick_wall_s": round(time.time() - t, 1),
                 "modes": {}}
        for mode in a.modes.split(","):
            w = subprocess.run([sys.executable, os.path.join(HERE, "watch.py"), dst, "--mode", mode,
                                "--model", a.model], check=True, capture_output=True, text=True)
            entry["modes"][mode] = [json.loads(ln) for ln in w.stdout.splitlines() if ln.startswith("{")]
        summary[name] = entry
        for mode, wins in entry["modes"].items():
            for w in wins:
                print(f"{name} {mode} {w['window']}: {w['keyframes']} kf, {w['images']} img, "
                      f"{w['input_tokens']:,} in, {w['output_tokens']:,} out, ${w['cost_usd_list']:.4f}, {w['wall_s']}s")
    Path(summary_path).write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
