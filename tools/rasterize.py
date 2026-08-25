#!/usr/bin/env python3
"""Turn an SVG logo into a transparent PNG CapCut can actually place.

CapCut will not render SVG, and macOS `qlmanage` — the only rasteriser present on a stock
machine — composites onto opaque white. So the white has to be keyed back out. That is safe
for a dark glyph on white (which is what every logo in the library is) and destructive for a
white-on-transparent mark, so the result is reported, not assumed: the printed opaque-pixel
percentage is how you tell a real logo from a white rectangle.
"""
import argparse, os, subprocess, sys, tempfile

def rasterize(svg, out, size=1024, threshold=246):
    try:
        from PIL import Image
    except ImportError:
        sys.exit("needs Pillow: uv tool install pillow  (or pip install pillow)")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["qlmanage", "-t", "-s", str(size), "-o", tmp, svg],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        made = [f for f in os.listdir(tmp) if f.endswith(".png")]
        if not made:
            sys.exit(f"qlmanage produced no thumbnail for {svg}")
        im = Image.open(os.path.join(tmp, made[0])).convert("RGBA")

    px = im.load()
    w, h = im.size
    kept = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= threshold and g >= threshold and b >= threshold:
                px[x, y] = (r, g, b, 0)
            elif a:
                kept += 1
    # crop to the glyph so --scale means the same thing for every brand
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out)
    pct = 100.0 * kept / (w * h)
    print(f"{out}\n  {im.size[0]}x{im.size[1]}  {pct:.1f}% of the source frame is ink")
    if pct < 0.5:
        print("  WARNING: almost nothing survived the white key — this logo is probably white-on-white.")
    if pct > 60:
        print("  WARNING: most of the frame survived — this may be a solid block, not a glyph.")
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("svg")
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--threshold", type=int, default=246)
    a = ap.parse_args()
    rasterize(a.svg, a.out, a.size, a.threshold)
