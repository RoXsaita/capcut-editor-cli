"""Compose a labelled before/action/after strip for ``capcutctl verify-shots``.

Frames come from ``frame_qa.extract_frame`` (the accuracy-checked source-time
path ``qa`` / ``export-grid`` already use). The contact sheet is the same
labelled-strip drawer as ``export-grid``. This tool never touches a CapCut draft.
"""
from __future__ import annotations

import argparse
import json
import math
import tempfile
from pathlib import Path

from frame_qa import contact_sheet, extract_frame


def compose_strip(media, times, labels, out, tile_w=270):
    """Write a 1×N labelled PNG of source frames. ``times`` and ``labels`` align 1:1."""
    if not times:
        raise SystemExit("times must not be empty")
    if tile_w <= 0:
        raise SystemExit("tile width must be a positive pixel size")
    if len(times) != len(labels):
        raise SystemExit("times and labels must be the same length")
    out = str(Path(out).resolve())
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="capcutctl-verify-") as tmp:
        tiles = []
        for index, (when, label) in enumerate(zip(times, labels, strict=True)):
            dest = str(Path(tmp) / f"{index:02d}.png")
            sample = extract_frame(media, float(when))
            sample.image.convert("RGB").save(dest)
            tiles.append((dest, str(label)[:44]))
        contact_sheet(tiles, out, tile_w)
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--times", required=True, help="comma-separated source seconds")
    parser.add_argument("--labels", help="comma-separated labels (default before,action,after)")
    parser.add_argument("--tile", type=int, default=270)
    args = parser.parse_args(argv)
    try:
        times = [float(item) for item in str(args.times).split(",") if item.strip()]
    except ValueError:
        parser.error("times must be comma-separated finite seconds")
    if not times or any(not math.isfinite(t) or t < 0 for t in times):
        parser.error("times must contain finite nonnegative seconds")
    if args.tile <= 0:
        parser.error("--tile must be a positive pixel width")
    labels = [item.strip() for item in str(args.labels).split(",")] if args.labels else (
        ["before", "action", "after"][:len(times)]
    )
    if len(labels) < len(times):
        labels.extend(f"t{t:.2f}s" for t in times[len(labels):])
    path = compose_strip(args.media, times, labels[:len(times)], args.out, args.tile)
    print(json.dumps({"strip": path, "times": times, "labels": labels[:len(times)]}))


if __name__ == "__main__":
    main()
