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
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import OrderedDict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

DRAFTS = os.path.expanduser("~/Movies/CapCut/User Data/Projects/com.lveditor.draft")

# ffmpeg exits 0 and writes NO file when a seek lands past the last frame, so a
# clamp 1ms off the end of a fully-consumed source yields a missing picture, not
# a picture. Back every end-of-media clamp off by about one frame instead.
_FRAME_EPS = 1.0 / 24

# grab() memoises decoded frames. Sized for the 3-6 stills a QA run asks for it was
# a plain dict; a default-fps --preview asks for ~1300 distinct stills and the same
# dict grew to ~17GB RSS. Consecutive preview frames reuse the same handful of
# images, so locality — an LRU on a byte budget — is all this ever needed.
_CACHE = OrderedDict()
_CACHE_BUDGET = 512 << 20      # bytes of decoded RGBA
_CACHE_BYTES = 0


def _cache_put(key, im):
    global _CACHE_BYTES
    n = im.width * im.height * 4
    if n > _CACHE_BUDGET:
        return                                       # one frame over budget: just don't keep it
    _CACHE[key] = im
    _CACHE_BYTES += n
    while _CACHE_BYTES > _CACHE_BUDGET:
        _, evicted = _CACHE.popitem(last=False)
        _CACHE_BYTES -= evicted.width * evicted.height * 4


def _cache_reset():
    global _CACHE_BYTES
    _CACHE.clear()
    _CACHE_BYTES = 0


def load_project(name):
    proj = name if os.path.isdir(name) else os.path.join(DRAFTS, name)
    meta = os.path.join(proj, "Timelines", "project.json")
    tl_id = None
    if os.path.exists(meta):
        j = json.loads(Path(meta).read_text())
        tl_id = j.get("active_timeline_id") or j.get("activeTimelineId")
    if not tl_id:
        tls = [d for d in os.listdir(os.path.join(proj, "Timelines"))
               if os.path.isdir(os.path.join(proj, "Timelines", d))] if os.path.isdir(os.path.join(proj, "Timelines")) else []
        tl_id = tls[0] if tls else None
    path = (os.path.join(proj, "Timelines", tl_id, "draft_info.json")
            if tl_id else os.path.join(proj, "draft_info.json"))
    return proj, json.loads(Path(path).read_text()), path


def resolve(proj, p):
    return os.path.join(proj, p.split("##/", 1)[1]) if p.startswith("##_draftpath_placeholder") else p


def source_span(segment):
    """(start, duration) of a segment's source material, in seconds.

    A null `source_timerange` means "play this material from its own beginning at
    1x", so the fallback is 0 + the target duration — ELAPSED time. Falling back to
    the target START hands back absolute timeline time, which is invisible for
    stills (grab ignores `t` for png/jpg) and wrong for every video and gif.
    """
    tt = segment["target_timerange"]
    st = segment.get("source_timerange") or {"start": 0, "duration": tt.get("duration", 0)}
    return st["start"] / 1e6, st["duration"] / 1e6


def source_time(segment, t):
    """Timeline second `t` -> media second. Speed is source_dur / target_dur.

    CapCut plays `source_timerange` across `target_timerange`. Ignoring that
    ratio (the previous formula) shows the wrong frame on any ramped clip —
    a 0.44× usage shot at t=63.5 read as the sidebar, while CapCut was still
    on the 10% page.
    """
    tt = segment["target_timerange"]
    tgt0, tgt_d = tt["start"] / 1e6, tt["duration"] / 1e6
    src0, src_d = source_span(segment)
    if tgt_d <= 0:
        return src0
    out = src0 + (t - tgt0) * (src_d / tgt_d)
    hi = src0 + src_d
    if hi <= src0:
        return src0
    # Stop ~a frame short of the source end (see _FRAME_EPS). The outer max() keeps
    # that ceiling from falling BELOW src0 on a sub-millisecond segment, where the
    # old `hi - 1e-3` returned a time before the segment even started.
    return min(max(out, src0), max(src0, hi - _FRAME_EPS))


def parse_expect(specs):
    """Parse --expect SECONDS=phrase[|phrase]. A second SECONDS= that BEGINS a
    phrase segment starts a new group (so '9.2=Build|45.5=Publish' is two
    timestamps, not a phrase named '45.5=Publish').

    The anchor matters: matching the marker anywhere silently ate real phrases —
    '5=Claude 3.5=Sonnet' became {5: ['Claude'], 3.5: ['Sonnet']}, asserting two
    things nobody asked about instead of the one thing they did.
    """
    out = {}
    marker = re.compile(r'(?:^|\|)\s*(\d+(?:\.\d+)?)=')
    for spec in specs:
        spec = (spec or "").strip()
        if "=" not in spec:
            raise SystemExit(f"--expect wants SECONDS=phrase, got {spec!r}")
        matches = list(marker.finditer(spec))
        if not matches or matches[0].start() != 0:
            raise SystemExit(f"--expect wants SECONDS=phrase, got {spec!r}")
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(spec)
            rest = spec[m.end():end].strip("| \t")
            phrases = [p for p in rest.split("|") if p]
            if not phrases:
                # An empty expectation drags its timestamp into --times and then asserts
                # nothing — a check that can only pass. Refuse it.
                raise SystemExit(f"--expect {spec!r}: {m.group(1)}= has no phrase to look for")
            out.setdefault(float(m.group(1)), []).extend(phrases)
    return out


def times_close(a, b, eps=1e-6):
    return abs(a - b) < eps


def grab(path, t):
    key = (path, round(t, 3))
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key].copy()
    if path.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
        im = Image.open(path).convert("RGBA")
    else:
        tmp = os.path.join(os.environ.get("TMPDIR", "/tmp"),
                           f"fqa_{hashlib.md5(repr(key).encode()).hexdigest()[:12]}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(max(0, t)), "-i", path,
                        "-frames:v", "1", tmp], check=True)
        if not os.path.exists(tmp):
            # ffmpeg seeking past the last frame exits 0 having written nothing, so
            # check=True is not evidence that we got a picture.
            raise SystemExit(f"no frame at t={t:.3f}s in {path} — seek is past the last frame")
        im = Image.open(tmp).convert("RGBA")
        os.remove(tmp)
    _cache_put(key, im)
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
        st = source_time(s, us / 1e6)
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


def contact_sheet(tiles, out, tile_w=240, pad=6, bar=22):
    """
    Every review in this project ended with a labelled grid of frames, and every one of
    them was a throwaway PIL script. It is the single most repeated thing here.
    """
    ims = []
    for path, label in tiles:
        im = Image.open(path).convert("RGB")
        h = max(1, round(im.height * tile_w / im.width))
        ims.append((im.resize((tile_w, h), Image.LANCZOS), label))
    rows = max(i.height for i, _ in ims)
    sheet = Image.new("RGB", (len(ims) * (tile_w + pad) + pad, rows + bar + pad * 2), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    for i, (im, label) in enumerate(ims):
        x = pad + i * (tile_w + pad)
        sheet.paste(im, (x, bar + pad))
        d.text((x + 2, 5), str(label)[:44], fill=(255, 235, 90))
    sheet.save(out)
    return out


OCR_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vision", "ocr")


def ocr(path, languages="en-US,ar"):
    """Text in a rendered frame, via Apple's Vision framework.

    doctor validates structure and cannot see the picture; qa draws the picture and needs a
    human to read it. This closes the loop: the frame the viewer will actually see is read
    back and checked against what the edit claims is on screen. It is the only check that
    would have caught the sidebar-vs-file-list mistake, where the JSON was valid, the
    geometry was right, and the frame simply showed the wrong thing.
    """
    if not os.path.exists(OCR_BIN):
        raise SystemExit(
            "the OCR helper is not built. Run:\n"
            "  swiftc -O -o tools/vision/ocr tools/vision/ocr.swift")
    out = subprocess.run([OCR_BIN, path, "--languages", languages],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"ocr failed on {path}: {out.stderr.strip()}")
    return json.loads(out.stdout or "[]")


def normalise_text(s):
    return " ".join((s or "").lower().split())


def check_expectations(path, wanted, languages="en-US,ar"):
    """Every phrase in `wanted` present in the frame? Returns (ok, found, runs)."""
    runs = ocr(path, languages)
    haystack = normalise_text(" ".join(r["text"] for r in runs))
    found = {w: (normalise_text(w) in haystack) for w in wanted}
    return all(found.values()), found, runs


def report_frame(f, t, wanted, show_ocr, languages, failures):
    """OCR one rendered frame, print PASS/FAIL per phrase, collect the misses."""
    _, found, runs = check_expectations(f, wanted, languages)
    if show_ocr:
        for r in sorted(runs, key=lambda r: r["y"])[:20]:
            print(f"       y={r['y']:.3f} {r['text'][:64]}")
    for phrase, hit in found.items():
        print(f"       {'PASS' if hit else 'FAIL'}  expected {phrase!r}")
        if not hit:
            failures.append((t, phrase))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project")
    ap.add_argument("--times", help="comma-separated seconds")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--out", default="qa")
    ap.add_argument("--z", choices=["track", "render_index"], default="track")
    ap.add_argument("--guide", type=float, action="append", default=[],
                    help="draw a horizontal guide at this y (repeatable); 960 = the half line")
    ap.add_argument("--rects-only", action="store_true")
    ap.add_argument("--sheet", nargs="?", const="sheet.png", default=None,
                    help="also write a labelled contact sheet of every rendered frame")
    ap.add_argument("--label", action="append", default=[],
                    help="caption for the Nth frame (repeatable); defaults to the timecode")
    ap.add_argument("--expect", action="append", default=[],
                    help="SECONDS=phrase[|phrase] — assert the rendered frame contains it "
                         "(repeatable). Exit 1 if any expectation fails.")
    ap.add_argument("--ocr", action="store_true", help="print the text found in each frame")
    ap.add_argument("--languages", default="en-US,ar")
    ap.add_argument("--width", type=int, default=240, help="tile width in the contact sheet")
    ap.add_argument("--preview", nargs="?", const="preview.mp4", default=None,
                    help="write a 6fps compositor proxy (optional path)")
    ap.add_argument("--fps", type=float, default=6, help="preview frame rate (default 6)")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(_selftest())
    if a.preview:
        if not a.project:
            ap.error("--project is required")
        if a.expect:
            # --preview writes a movie, not per-timestamp stills, so there is nothing to
            # OCR. Exiting 0 having verified none of the expectations is the failure mode
            # the unmatched-timestamp check exists to prevent; refuse instead.
            ap.error("--preview cannot check --expect (it renders a movie, not frames at "
                     "--times); run the same --expect without --preview")
        proj, tl, path = load_project(a.project)
        print(f"timeline: {path}")
        out = write_preview(proj, tl, a.preview, fps=a.fps, z=a.z)
        print(f"  -> {out}")
        return
    if not a.project or not a.times:
        ap.error("--project and --times are required")
    proj, tl, path = load_project(a.project)
    print(f"timeline: {path}")
    os.makedirs(a.out, exist_ok=True)
    expectations = parse_expect(a.expect)
    rendered = [float(x) for x in a.times.split(",") if x.strip() != ""]
    failures = []
    tiles = []
    # An expectation whose timestamp is never rendered is a different failure from a
    # phrase that was looked for and missing. Printing it as the latter read like an
    # OCR miss and sent the last reader hunting for text that was never searched for.
    unchecked = sorted(t for t in expectations if not any(times_close(t, u) for u in rendered))
    for t in rendered:
        img, rows, W, H = render(proj, tl, t, a.z)
        print(f"\n=== t={t}  z={a.z}  canvas {W}x{H}")
        for ti, sid, nm, rc in rows:
            if rc is None:
                print(f"  trk{ti:<2} {sid} {nm}")
            else:
                x, y, w, h = rc
                print(f"  trk{ti:<2} {sid} {nm:<34} x{x}..{x+w} y{y}..{y+h}  {w}x{h}")
        wanted = [p for et, phrases in expectations.items() if times_close(et, t) for p in phrases]
        if a.rects_only:
            # --rects-only skips the PNGs, never the assertions: this mode used to exit 0
            # with --expect on the command line having checked nothing at all. OCR needs a
            # file on disk, so give it a throwaway one rather than an output artefact.
            if wanted or a.ocr:
                with tempfile.TemporaryDirectory(prefix="fqa-rects-") as td:
                    f = os.path.join(td, "frame.png")
                    img.convert("RGB").save(f)
                    report_frame(f, t, wanted, a.ocr, a.languages, failures)
            continue
        d = ImageDraw.Draw(img)
        for g in (a.guide or [H / 2]):
            d.line([0, g, W, g], fill=(255, 0, 0, 255), width=4)
            d.text((14, g + 8), f"y={g:g}", fill=(255, 90, 90, 255))
        f = os.path.join(a.out, f"t{t:g}.png")
        img.convert("RGB").save(f)
        print(f"  -> {f}")
        if a.ocr or wanted:
            report_frame(f, t, wanted, a.ocr, a.languages, failures)
        tiles.append((f, a.label[len(tiles)] if len(tiles) < len(a.label) else f"t={t:g}"))

    if a.sheet and tiles:
        out = a.sheet if os.path.isabs(a.sheet) else os.path.join(a.out, a.sheet)
        print(f"\n  -> {contact_sheet(tiles, out, a.width)}")

    if failures or unchecked:
        print(f"\n{len(failures) + len(unchecked)} expectation(s) failed:")
        for t in unchecked:
            print(f"  t={t:g}  NOT CHECKED — no such timestamp in --times")
        for t, phrase in failures:
            print(f"  t={t:g}  {phrase!r} is not on screen")
        sys.exit(1)


def preview_times(duration_s, fps=6):
    """Inclusive 0 .. last-frame-inside-duration at `fps` stills/sec."""
    if duration_s <= 0 or fps <= 0:
        return []
    step = 1.0 / fps
    times = []
    t = 0.0
    last = max(0.0, duration_s - _FRAME_EPS)
    while t < last - 1e-9:
        times.append(round(t, 6))
        t += step
    if not times or times[-1] < last - step * 0.25:
        times.append(round(last, 6))
    return times


def atempo_chain(speed):
    """ffmpeg atempo is 0.5..100; chain for the rest. None if ~1x."""
    if speed <= 0:
        raise ValueError("speed must be positive")
    if abs(speed - 1.0) < 1e-3:
        return None
    parts, s = [], float(speed)
    while s > 100:
        parts.append("atempo=100")
        s /= 100.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    parts.append(f"atempo={s:.6f}")
    return ",".join(parts)


def principal_video_track(tl):
    """Gapless video track that starts at 0 and spans most of the timeline, else the longest."""
    total = (tl.get("duration") or 0)
    scored = []
    longest = None
    for i, tr in enumerate(tl.get("tracks") or []):
        if tr.get("type") != "video":
            continue
        segs = sorted(tr.get("segments") or [], key=lambda s: s["target_timerange"]["start"])
        if not segs:
            continue
        span = (segs[-1]["target_timerange"]["start"] + segs[-1]["target_timerange"]["duration"]
                - segs[0]["target_timerange"]["start"])
        if longest is None or span > longest[0]:
            longest = (span, i, tr, segs)
        cursor = segs[0]["target_timerange"]["start"]
        gap = False
        for s in segs:
            if s["target_timerange"]["start"] - cursor > 20_000:
                gap = True
                break
            cursor = s["target_timerange"]["start"] + s["target_timerange"]["duration"]
        if gap or segs[0]["target_timerange"]["start"] > 20_000:
            continue
        if total and span < total * 0.9:
            continue
        scored.append((span, i, tr, segs))
    if scored:
        scored.sort(reverse=True)
        return scored[0][1], scored[0][2], scored[0][3]
    if longest:
        return longest[1], longest[2], longest[3]
    return None, None, []


def write_preview(proj, tl, out_path, fps=6, z="track"):
    """6fps compositor stills + timeline audio. Not a CapCut export."""
    duration_s = (tl.get("duration") or 0) / 1e6
    times = preview_times(duration_s, fps)
    if not times:
        raise SystemExit("preview: draft duration is 0")
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    # A default --fps 6 pass over a 79s draft writes 478 full-size PNGs plus the wavs.
    # Leaking that per invocation (>1GB) is what the finally is for.
    tmp = tempfile.mkdtemp(prefix="capcutctl-preview-")
    try:
        frames_dir = os.path.join(tmp, "frames")
        os.makedirs(frames_dir)
        for i, t in enumerate(times):
            img, _, _, _ = render(proj, tl, t, z)
            img.convert("RGB").save(os.path.join(frames_dir, f"f{i:06d}.png"))
        video = os.path.join(tmp, "video.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps),
             "-i", os.path.join(frames_dir, "f%06d.png"),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", video],
            check=True)
        audio = _timeline_audio(proj, tl, tmp, duration_s)
        if audio:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-i", audio,
                 "-c:v", "copy", "-c:a", "aac", "-shortest", out_path],
                check=True)
        else:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-c", "copy", out_path],
                           check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out_path


def _timeline_audio(proj, tl, tmp, duration_s):
    """Principal-video-track audio PLUS every `audio` track, mixed onto silence.

    The whole point of --preview is hearing the seams, and the music and SFX live on
    the audio tracks — reading only the principal video track dropped 28 segments and
    13.5s of sound in GrokBuild-20260825 and made the seams silent.
    """
    idx = {}
    for _k, v in (tl.get("materials") or {}).items():
        if isinstance(v, list):
            for m in v:
                if isinstance(m, dict) and "id" in m:
                    idx[m["id"]] = m
    _, _track, segs = principal_video_track(tl)
    sources = list(segs)
    for tr in tl.get("tracks") or []:
        if tr.get("type") == "audio":
            sources += tr.get("segments") or []
    if not sources:
        return None
    slices = []
    for n, s in enumerate(sources):
        mat = idx.get(s.get("material_id"))
        if not mat:
            continue
        p = resolve(proj, mat.get("path", ""))
        if not p or not os.path.exists(p):
            continue
        tt = s["target_timerange"]
        # Same span/speed math as source_time — a second copy of it is how the
        # original speed bug survived, and how the null fallback drifted apart.
        src0, src_d = source_span(s)
        tgt_d = tt["duration"] / 1e6
        speed = src_d / tgt_d if tgt_d > 0 else 1.0
        vol = s.get("volume")
        vol = 1.0 if vol is None else float(vol)      # a muted segment is not a silent slice, it is no slice
        if speed <= 0 or vol <= 0:
            continue
        wav = os.path.join(tmp, f"a{n:03d}.wav")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(max(0, src0)), "-t", str(max(0.01, src_d)),
               "-i", p]
        af = [x for x in (atempo_chain(speed),) if x]
        if abs(vol - 1.0) > 1e-3:
            af.append(f"volume={vol:.6f}")
        if af:
            cmd += ["-af", ",".join(af)]
        cmd += ["-ac", "1", "-ar", "44100", wav]
        try:
            subprocess.run(cmd, check=True)
            slices.append((tt["start"] / 1e6, wav))
        except subprocess.CalledProcessError:
            continue
    if not slices:
        return None
    # Mix onto a silent bed so gaps stay gaps.
    bed = os.path.join(tmp, "bed.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                    "-i", "anullsrc=r=44100:cl=mono", "-t", str(max(0.05, duration_s)), bed], check=True)
    inputs = ["-i", bed]
    filters = []
    mix = ["[0:a]"]
    for i, (start, wav) in enumerate(slices, start=1):
        inputs += ["-i", wav]
        delay_ms = max(0, round(start * 1000))
        filters.append(f"[{i}:a]adelay={delay_ms}|{delay_ms}[d{i}]")
        mix.append(f"[d{i}]")
    n = 1 + len(slices)
    filters.append("".join(mix) + f"amix=inputs={n}:dropout_transition=0:normalize=0[aout]")
    mixed = os.path.join(tmp, "mix.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs,
                    "-filter_complex", ";".join(filters), "-map", "[aout]", mixed], check=True)
    return mixed


def _selftest():
    global _CACHE_BUDGET
    ok = []
    def check(name, cond):
        ok.append(cond)
        print(f"  {'PASS' if cond else 'FAIL'}  {name}")

    def rejects(spec):
        try:
            parse_expect([spec])
        except SystemExit:
            return True
        return False

    seg = {
        "target_timerange": {"start": 59_333_000, "duration": 8_634_000},
        "source_timerange": {"start": 1_798_000_000, "duration": 3_801_761},
    }
    # 0.44× usage clip: 3.667s into the slot is still on the 10% page (~1800s),
    # not 1798+3.667 = 1801.7 (the no-speed formula that showed the sidebar).
    got = source_time(seg, 63.0)
    check("speed-aware source time", abs(got - 1799.614) < 0.01)
    check("1x is just an offset", abs(source_time(
        {"target_timerange": {"start": 0, "duration": 5_000_000},
         "source_timerange": {"start": 90_000_000, "duration": 5_000_000}}, 2.0) - 92.0) < 1e-9)

    exp = parse_expect(["9.2=Build|45.5=Publish", "61=10%"])
    check("second SECONDS= starts a new group", sorted(exp) == [9.2, 45.5, 61.0])
    check("phrases stay with their timestamp", exp[9.2] == ["Build"] and exp[45.5] == ["Publish"])
    check("pipe still joins phrases on one timestamp", parse_expect(["18=Read file|tower-defense"])[18.0] == ["Read file", "tower-defense"])
    check("a marker mid-phrase is part of the phrase",
          parse_expect(["5=Claude 3.5=Sonnet"]) == {5.0: ["Claude 3.5=Sonnet"]})
    check("an expectation with no phrase is rejected", rejects("45.5=") and rejects("45.5=|"))
    check("bad timestamps stay rejected",
          all(rejects(x) for x in ("-5=Build", "1e3=Build", "9.2 = Build", "Build")))

    # A null source_timerange is elapsed time, not timeline time.
    check("null source range plays from the material start",
          abs(source_time({"target_timerange": {"start": 40_000_000, "duration": 2_000_000}}, 41.0) - 1.0) < 1e-9)
    # The end-of-source clamp stops a frame short, and never before the segment starts.
    full = {"target_timerange": {"start": 0, "duration": 1_000_000},
            "source_timerange": {"start": 0, "duration": 1_000_000}}
    check("end-of-source clamp backs off a frame", abs(source_time(full, 1.0) - (1.0 - _FRAME_EPS)) < 1e-9)
    tiny = {"target_timerange": {"start": 0, "duration": 500},
            "source_timerange": {"start": 10_000_000, "duration": 500}}
    check("sub-frame segment never seeks before its own start", source_time(tiny, 0.0005) >= 10.0)

    saved, _CACHE_BUDGET = _CACHE_BUDGET, 1 << 20
    _cache_reset()
    for i in range(64):
        _cache_put(("fake", i), Image.new("RGBA", (256, 256)))      # 256KB each, budget is 1MB
    check("the frame cache evicts to stay inside its budget",
          _CACHE_BYTES <= _CACHE_BUDGET and len(_CACHE) == 4)
    _CACHE_BUDGET = saved
    _cache_reset()

    times = preview_times(1.0, fps=6)
    check("preview starts at 0", times[0] == 0.0)
    check("preview has ~6 fps for 1s", 6 <= len(times) <= 8)
    check("1x atempo is a no-op", atempo_chain(1.0) is None)
    check("slow atempo chains below 0.5", atempo_chain(0.44) == "atempo=0.5,atempo=0.880000")
    check("very fast atempo chains", atempo_chain(250).startswith("atempo=100"))

    print("selftest:", "all passed" if all(ok) else "FAILURES")
    return 0 if all(ok) else 1


if __name__ == "__main__":
    main()
