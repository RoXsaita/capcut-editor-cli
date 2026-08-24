#!/usr/bin/env python3
"""frame_qa.py — render CapCut timeline frames outside CapCut, for rendered-pixel QA.

Why this exists: capcutctl validates STRUCTURE (ids, refs, timing, mirrors, media).
It cannot see the PICTURE. Two real defects in grok-build-gpt passed `doctor` clean:
a split that was 900/1020 instead of 960/960, and an indigo frame 47px off its card.
This script resolves every segment to its on-canvas rect so those show up as numbers
and as pixels.

CapCut geometry model (verified against the suheil-vertical preset to 1px):
    scale 1.0  == FIT the whole source inside the canvas (k0 = min(W/sw, H/sh))
    displayed  == (sw*k0*scale.x,  sh*k0*scale.y)
    centre     == (W/2 + tx*(W/2),  H/2 - ty*(H/2))      <- y is positive UP
Z-order: track order (see --z). `render_index` is preserved by CapCut but in
grok-build-gpt it disagrees with the visible result; normalise it if you rely on it.

Usage:
    python3 frame_qa.py --project NAME --times 1.5,6,41.5 --out qa/
    python3 frame_qa.py --project NAME --times 6 --rects-only
"""
import argparse, json, os, subprocess, sys, hashlib
from PIL import Image, ImageFilter, ImageDraw
import numpy as np

DRAFTS = os.path.expanduser("~/Movies/CapCut/User Data/Projects/com.lveditor.draft")
_CACHE = {}


def load_project(name):
    proj = name if os.path.isdir(name) else os.path.join(DRAFTS, name)
    meta = os.path.join(proj, "Timelines", "project.json")
    tl_id = None
    if os.path.exists(meta):
        j = json.load(open(meta))
        tl_id = j.get("active_timeline_id") or j.get("activeTimelineId")
    if not tl_id:
        tls = [d for d in os.listdir(os.path.join(proj, "Timelines"))
               if os.path.isdir(os.path.join(proj, "Timelines", d))] if os.path.isdir(os.path.join(proj, "Timelines")) else []
        tl_id = tls[0] if tls else None
    path = (os.path.join(proj, "Timelines", tl_id, "draft_info.json")
            if tl_id else os.path.join(proj, "draft_info.json"))
    return proj, json.load(open(path)), path


def resolve(proj, p):
    return os.path.join(proj, p.split("##/", 1)[1]) if p.startswith("##_draftpath_placeholder") else p


def grab(path, t):
    key = (path, round(t, 3))
    if key in _CACHE:
        return _CACHE[key].copy()
    if path.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
        im = Image.open(path).convert("RGBA")
    else:
        tmp = os.path.join(os.environ.get("TMPDIR", "/tmp"),
                           "fqa_%s.png" % hashlib.md5(repr(key).encode()).hexdigest()[:12])
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(max(0, t)), "-i", path,
                        "-frames:v", "1", tmp], check=True)
        im = Image.open(tmp).convert("RGBA")
        os.remove(tmp)
    _CACHE[key] = im
    return im.copy()


def place(canvas, im, clip, W, H, blur=False, mask=None):
    sw, sh = im.size
    k0 = min(W / sw, H / sh)
    sc = clip.get("scale", {})
    w = max(1, round(sw * k0 * sc.get("x", 1.0)))
    h = max(1, round(sh * k0 * sc.get("y", 1.0)))
    tf = clip.get("transform", {})
    cx = W / 2 + tf.get("x", 0.0) * (W / 2)
    cy = H / 2 - tf.get("y", 0.0) * (H / 2)          # y positive = UP
    im = im.resize((w, h), Image.LANCZOS)
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(radius=max(2, w * 0.04)))
    if mask:
        kind, cfg = mask
        a = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(a)
        # positions: half-CLIP units, y up.  sizes: full-clip fractions.
        mcx = w / 2 + float(cfg.get("centerX", 0)) * (w / 2)
        mcy = h / 2 - float(cfg.get("centerY", 0)) * (h / 2)
        if kind == "circle":
            rx = float(cfg.get("width", .5)) * w / 2
            ry = float(cfg.get("height", .5)) * h / 2
            d.ellipse([mcx - rx, mcy - ry, mcx + rx, mcy + ry], fill=255)
        elif kind == "line":
            rot = float(cfg.get("rotation", 0)) % 360
            d.rectangle([0, mcy, w, h] if abs(rot - 180) < 1 else [0, 0, w, mcy], fill=255)
        else:
            a = Image.new("L", (w, h), 255)
        im.putalpha(Image.fromarray(np.minimum(np.array(im.getchannel("A")), np.array(a))))
    al = float(clip.get("alpha", 1.0))
    if al < 1.0:
        im.putalpha(im.getchannel("A").point(lambda v: int(v * al)))
    x, y = round(cx - w / 2), round(cy - h / 2)
    canvas.alpha_composite(im, (x, y))
    return x, y, w, h


def render(proj, tl, t, z="track"):
    cc = tl.get("canvas_config", {})
    W, H = cc.get("width", 1080), cc.get("height", 1920)
    idx = {}
    for k, v in tl["materials"].items():
        if isinstance(v, list):
            for m in v:
                if isinstance(m, dict) and "id" in m:
                    idx.setdefault(m["id"], (k, m))
    us = int(t * 1e6)
    act = [(ti, s) for ti, tr in enumerate(tl["tracks"]) if tr["type"] == "video"
           for s in tr.get("segments", [])
           if s["target_timerange"]["start"] <= us < s["target_timerange"]["start"] + s["target_timerange"]["duration"]]
    act.sort(key=lambda p: (p[0], p[1].get("render_index", 0)) if z == "track"
             else (p[1].get("render_index", 0), p[0]))
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    rows = []
    for ti, s in act:
        k, m = idx.get(s["material_id"], (None, None))
        if not m:
            continue
        p = resolve(proj, m.get("path", ""))
        if not os.path.exists(p):
            rows.append((ti, s["id"][:8], "MISSING:" + os.path.basename(m.get("path", "")), None))
            continue
        st = (s.get("source_timerange") or {"start": 0})["start"] / 1e6 + (us - s["target_timerange"]["start"]) / 1e6
        blur, mask = False, None
        for r in s.get("extra_material_refs", []):
            kk, mm = idx.get(r, (None, None))
            if kk == "video_effects" and mm.get("name") == "Blur":
                blur = True
            if kk in ("masks", "common_mask") and s.get("enable_video_mask", True):
                mask = (mm.get("resource_type"), mm.get("config"))
        rc = place(canvas, grab(p, st), s.get("clip") or {}, W, H, blur, mask)
        rows.append((ti, s["id"][:8], os.path.basename(p)[:34], rc))
    return canvas, rows, W, H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--times", required=True, help="comma-separated seconds")
    ap.add_argument("--out", default="qa")
    ap.add_argument("--z", choices=["track", "render_index"], default="track")
    ap.add_argument("--guide", type=float, action="append", default=[],
                    help="draw a horizontal guide at this y (repeatable); 960 = the half line")
    ap.add_argument("--rects-only", action="store_true")
    a = ap.parse_args()
    proj, tl, path = load_project(a.project)
    print(f"timeline: {path}")
    os.makedirs(a.out, exist_ok=True)
    for t in [float(x) for x in a.times.split(",")]:
        img, rows, W, H = render(proj, tl, t, a.z)
        print(f"\n=== t={t}  z={a.z}  canvas {W}x{H}")
        for ti, sid, nm, rc in rows:
            if rc is None:
                print(f"  trk{ti:<2} {sid} {nm}")
            else:
                x, y, w, h = rc
                print(f"  trk{ti:<2} {sid} {nm:<34} x{x}..{x+w} y{y}..{y+h}  {w}x{h}")
        if a.rects_only:
            continue
        d = ImageDraw.Draw(img)
        for g in (a.guide or [H / 2]):
            d.line([0, g, W, g], fill=(255, 0, 0, 255), width=4)
            d.text((14, g + 8), f"y={g:g}", fill=(255, 90, 90, 255))
        f = os.path.join(a.out, f"t{t:g}.png")
        img.convert("RGB").save(f)
        print(f"  -> {f}")


if __name__ == "__main__":
    main()
