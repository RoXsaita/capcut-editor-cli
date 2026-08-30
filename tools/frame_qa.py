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
    python3 frame_qa.py --project NAME --at-cuts --at-scenes --at-broll --out qa/
    python3 frame_qa.py --project NAME --preview preview.mp4 [--from 4 --to 20]
    python3 frame_qa.py --project NAME --times 6 --rects-only
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

DRAFTS = os.path.expanduser("~/Movies/CapCut/User Data/Projects/com.lveditor.draft")

# ffmpeg exits 0 and writes NO file when a seek lands past the last frame, so a
# clamp 1ms off the end of a fully-consumed source yields a missing picture, not
# a picture. Back every end-of-media clamp off by about one frame instead.
_FRAME_EPS = 1.0 / 24
_DEFAULT_FRAME_PERIOD = 1.0 / 30.0
_SEEK_PREROLL = 2.0


class FrameExtractionError(SystemExit):
    """A frame could not be extracted with a trustworthy presentation timestamp."""


@dataclass
class FrameSample:
    """One decoded frame and the timing evidence attached to it.

    ``requested_pts`` and ``delivered_pts`` are media timestamps, not timeline
    timestamps.  Keeping them together is important: a compositor can map a
    timeline time to the wrong source frame while still producing a perfectly
    valid PNG.
    """

    image: Image.Image
    requested_pts: float
    delivered_pts: float
    frame_period: float
    method: str
    reextracted: bool = False

    @property
    def drift(self):
        return abs(self.delivered_pts - self.requested_pts)

    @property
    def drift_over_one_frame(self):
        return self.drift > self.frame_period + 1e-6

# grab() memoises decoded frames. Sized for the 3-6 stills a QA run asks for it was
# a plain dict; a default-fps --preview asks for ~1300 distinct stills and the same
# dict grew to ~17GB RSS. Consecutive preview frames reuse the same handful of
# images, so locality — an LRU on a byte budget — is all this ever needed.
_CACHE = OrderedDict()
_CACHE_BUDGET = 512 << 20      # bytes of decoded RGBA
_CACHE_BYTES = 0
_FRAME_INFO = {}


def _cache_put(key, im):
    global _CACHE_BYTES
    n = im.width * im.height * 4
    if n > _CACHE_BUDGET:
        return                                       # one frame over budget: just don't keep it
    old = _CACHE.pop(key, None)
    if old is not None:
        _CACHE_BYTES -= old.width * old.height * 4
    _CACHE[key] = im
    _CACHE_BYTES += n
    while _CACHE_BYTES > _CACHE_BUDGET:
        evicted_key, evicted = _CACHE.popitem(last=False)
        _FRAME_INFO.pop(evicted_key, None)
        _CACHE_BYTES -= evicted.width * evicted.height * 4


def _cache_reset():
    global _CACHE_BYTES
    _CACHE.clear()
    _FRAME_INFO.clear()
    _CACHE_BYTES = 0


def load_project(name):
    proj = name if os.path.isdir(name) else os.path.join(DRAFTS, name)
    meta = os.path.join(proj, "Timelines", "project.json")
    tl_id = None
    if os.path.exists(meta):
        j = json.loads(Path(meta).read_text())
        tl_id = j.get("main_timeline_id") or j.get("active_timeline_id") or j.get("activeTimelineId")
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


_SHOWINFO_TIME = re.compile(
    r"\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(?P<pts>[-+]?"
    r"(?:\d+(?:\.\d*)?|\.\d+))"
)
_SHOWINFO_DURATION = re.compile(
    r"\bduration_time:(?P<duration>[-+]?(?:\d+(?:\.\d*)?|\.\d+))"
)


def _showinfo(stderr):
    """Return the first frame's PTS and duration from ffmpeg's showinfo output."""
    for line in (stderr or "").splitlines():
        match = _SHOWINFO_TIME.search(line)
        if not match:
            continue
        duration = _SHOWINFO_DURATION.search(line)
        try:
            pts = float(match.group("pts"))
            period = float(duration.group("duration")) if duration else None
        except ValueError:
            continue
        return pts, period
    return None, None


def _frame_period(period, fps=None):
    if period and period > 0:
        return period
    try:
        value = float(fps)
    except (TypeError, ValueError):
        value = 0
    return 1.0 / value if value > 0 else _DEFAULT_FRAME_PERIOD


def _extract_path(path, requested, method):
    """Use ffmpeg to write one frame and return ``(image, pts, period)``.

    The accurate path deliberately does not trust ffmpeg's input seek to choose
    the frame.  It seeks near the requested timestamp, then lets the select
    filter choose the first decoded frame whose original PTS is at/after the
    request. ``-copyts`` preserves the source frame clock and ``-start_at_zero``
    normalises a container-level nonzero media start time, so the reported PTS stays
    in the media-relative coordinate system used by CapCut timeranges.
    """
    requested = max(0.0, float(requested))
    # A private 0700 directory makes the output name unguessable across concurrent runs and
    # removes the symlink/write race caused by the old shared /tmp/fqa_<hash>.png path. `-n`
    # refuses an unexpected pre-existing output instead of following an overwrite target.
    with tempfile.TemporaryDirectory(prefix="capcutctl-frame-") as tmp_dir:
        tmp = os.path.join(tmp_dir, "frame.png")
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "info", "-nostdin", "-n",
            "-copyts", "-start_at_zero",
        ]
        if method == "fast-seek":
            command += ["-ss", f"{requested:.9f}", "-i", path, "-vf", "showinfo"]
        elif method == "coarse+timestamp":
            coarse = max(0.0, requested - _SEEK_PREROLL)
            selector = f"select=gte(t\\,{requested:.9f}),showinfo"
            command += ["-ss", f"{coarse:.9f}", "-i", path, "-vf", selector]
        else:
            raise ValueError(f"unknown frame extraction method: {method}")
        command += ["-an", "-sn", "-frames:v", "1", "-fps_mode", "vfr", tmp]
        try:
            result = subprocess.run(command, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or "").strip()
            suffix = f": {detail[-300:]}" if detail else ""
            raise FrameExtractionError(f"ffmpeg could not extract t={requested:.3f}s from {path}{suffix}") from exc
        if not os.path.exists(tmp):
            # ffmpeg can exit 0 and write no image when the seek is past the last frame.
            raise FrameExtractionError(
                f"no frame at t={requested:.3f}s in {path} — seek is past the last frame"
            )
        delivered, period = _showinfo(result.stderr or getattr(result, "stdout", ""))
        if delivered is None:
            raise FrameExtractionError(
                f"ffmpeg returned a frame without a PTS for t={requested:.3f}s in {path}"
            )
        with Image.open(tmp) as opened:
            image = opened.convert("RGBA")
        return image, delivered, period


def extract_frame(path, t, fps=None, force_accurate=False):
    """Extract a frame with timing evidence and an automatic accuracy retry.

    Fast seeking is cheap, but its delivered PTS can be more than one frame
    away from the requested PTS on long-GOP/VFR media.  Such a result is never
    silently accepted: the coarse-seek + timestamp-select path is retried and
    the returned object records that retry in ``reextracted``.
    """
    path = os.fspath(path)
    requested = max(0.0, float(t))
    if not np.isfinite(requested):
        raise FrameExtractionError(f"frame timestamp must be finite, got {t!r}")
    if path.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
        with Image.open(path) as opened:
            image = opened.convert("RGBA")
        return FrameSample(
            image=image,
            requested_pts=requested,
            delivered_pts=requested,
            frame_period=_frame_period(None, fps),
            method="still",
        )

    fast = None
    try:
        if not force_accurate:
            image, delivered, period = _extract_path(path, requested, "fast-seek")
            period = _frame_period(period, fps)
            fast = FrameSample(image, requested, delivered, period, "fast-seek")
            if fast.drift <= period + 1e-6:
                return fast
    except FrameExtractionError:
        # An accurate retry gives a useful error and also handles media where
        # fast input seeking cannot produce a frame at all.
        pass

    image, delivered, period = _extract_path(path, requested, "coarse+timestamp")
    period = _frame_period(period, fps)
    return FrameSample(
        image=image,
        requested_pts=requested,
        delivered_pts=delivered,
        frame_period=period,
        method="coarse+timestamp",
        reextracted=fast is not None,
    )


def _copy_sample(sample, image=None):
    return FrameSample(
        image=(sample.image if image is None else image).copy(),
        requested_pts=sample.requested_pts,
        delivered_pts=sample.delivered_pts,
        frame_period=sample.frame_period,
        method=sample.method,
        reextracted=sample.reextracted,
    )


def grab(path, t, return_info=False, fps=None):
    """Return a cached image, or a ``FrameSample`` when ``return_info`` is true."""
    key = (path, round(float(t), 6))
    if key in _CACHE and (not return_info or key in _FRAME_INFO):
        _CACHE.move_to_end(key)
        if return_info:
            return _copy_sample(_FRAME_INFO[key])
        return _CACHE[key].copy()
    sample = extract_frame(path, t, fps=fps)
    _cache_put(key, sample.image)
    _FRAME_INFO[key] = _copy_sample(sample)
    if return_info:
        return _copy_sample(sample)
    return sample.image.copy()


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


def _material_path(proj, material):
    """Return ``(resolved_path, error)`` for one material record."""
    if not material:
        return None, "material record is missing"
    raw = material.get("path")
    if not isinstance(raw, str) or not raw.strip():
        return None, "path is empty"
    try:
        resolved = resolve(proj, raw)
    except (IndexError, TypeError, AttributeError):
        return None, f"path {raw!r} is malformed"
    if not os.path.isfile(resolved):
        return resolved, f"path {raw!r} (resolved {resolved!r}) does not exist"
    return resolved, None


def _media_issue(proj, segment, materials):
    """Describe a missing video material with enough identity to fix the draft."""
    sid = str(segment.get("id") or "<unnamed>")
    material_id = segment.get("material_id")
    material = materials.get(material_id)
    if material is None:
        return f"segment {sid} references missing material_id {material_id!r}"
    _path, error = _material_path(proj, material)
    if error:
        return f"segment {sid} material_id {material_id!r}: {error}"
    return None


def _media_segments_in_range(tl, start=None, end=None):
    """Yield video/audio segments whose target range intersects ``[start, end)`` seconds."""
    for track_index, track in enumerate(tl.get("tracks") or []):
        if track.get("type") not in {"video", "audio"}:
            continue
        for segment in track.get("segments") or []:
            timerange = segment.get("target_timerange") or {}
            try:
                seg_start = float(timerange["start"]) / 1e6
                seg_end = seg_start + float(timerange["duration"]) / 1e6
            except (KeyError, TypeError, ValueError):
                continue
            if seg_end <= seg_start:
                continue
            if start is not None and seg_end <= start:
                continue
            if end is not None and seg_start >= end:
                continue
            yield track_index, segment


def _missing_media(proj, tl, materials, start=None, end=None):
    issues = []
    for _track_index, segment in _media_segments_in_range(tl, start, end):
        issue = _media_issue(proj, segment, materials)
        if issue:
            issues.append(issue)
    return issues


def _missing_media_error(context, issues):
    detail = "\n".join(f"  - {issue}" for issue in issues)
    return FrameExtractionError(
        f"{context}: missing media would produce an incomplete/black render. "
        f"Restore the referenced files or pass --allow-missing for an explicit degraded render.\n"
        f"{detail}"
    )


def render(proj, tl, t, z="track", frame_reports=None, allow_missing=False):
    cc = tl.get("canvas_config", {})
    W, H = cc.get("width", 1080), cc.get("height", 1920)
    idx = {}
    for k, v in (tl.get("materials") or {}).items():
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
    materials = {material_id: material for material_id, (_kind, material) in idx.items()}
    issues = [_media_issue(proj, segment, materials) for _track, segment in act]
    issues = [issue for issue in issues if issue]
    if issues and not allow_missing:
        raise _missing_media_error(f"render t={float(t):g}s", issues)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    rows = []
    for ti, s in act:
        material_entry = idx.get(s.get("material_id"))
        if not material_entry:
            rows.append((ti, str(s.get("id") or "<unnamed>")[:8],
                         f"MISSING:material_id={s.get('material_id')!r}", None))
            continue
        _kind, m = material_entry
        p, error = _material_path(proj, m)
        if error:
            raw = m.get("path") if isinstance(m, dict) else None
            label = os.path.basename(raw) if isinstance(raw, str) else f"material_id={s.get('material_id')!r}"
            rows.append((ti, str(s.get("id") or "<unnamed>")[:8], "MISSING:" + label, None))
            continue
        st = source_time(s, us / 1e6)
        blur, mask = False, None
        for r in s.get("extra_material_refs", []):
            kk, mm = idx.get(r, (None, None))
            if kk == "video_effects" and mm.get("name") == "Blur":
                blur = True
            if kk in ("masks", "common_mask") and s.get("enable_video_mask", True):
                mask = (mm.get("resource_type"), mm.get("config"))
        sample = grab(p, st, return_info=True, fps=tl.get("fps"))
        image = sample.image if isinstance(sample, FrameSample) else sample
        if frame_reports is not None and isinstance(sample, FrameSample):
            frame_reports.append((p, sample))
        rc = place(canvas, image, s.get("clip") or {}, W, H, blur, mask)
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


def report_extractions(timeline_time, frame_reports):
    """Print the requested/delivered media PTS for frames used in one QA render."""
    seen = set()
    for media, sample in frame_reports:
        key = (media, sample.requested_pts, sample.delivered_pts, sample.method)
        if key in seen:
            continue
        seen.add(key)
        retry = "  re-extracted accurately" if sample.reextracted else ""
        warning = "  DRIFT>1FRAME" if sample.drift_over_one_frame else ""
        print(
            f"  frame t={timeline_time:g}s {os.path.basename(media)} "
            f"requested PTS {sample.requested_pts:.6f}s "
            f"delivered PTS {sample.delivered_pts:.6f}s "
            f"drift {sample.drift:.6f}s ({sample.method}){retry}{warning}"
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project")
    ap.add_argument("--times", help="comma-separated seconds")
    ap.add_argument("--at-cuts", action="store_true",
                    help="sample every visual segment boundary")
    ap.add_argument("--at-scenes", action="store_true",
                    help="sample the midpoint of every principal-track scene")
    ap.add_argument("--at-broll", action="store_true",
                    help="sample the midpoint of every B-roll segment")
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
    ap.add_argument("--allow-missing", action="store_true",
                    help="explicitly allow degraded black output for missing video media")
    ap.add_argument("--from", dest="from_time", type=float,
                    help="preview start in timeline seconds (default: content start)")
    ap.add_argument("--to", dest="to_time", type=float,
                    help="preview end in timeline seconds (default: content end)")
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
        try:
            render_start, render_end = resolve_preview_range(
                proj, tl, start=a.from_time, end=a.to_time
            )
        except (TypeError, ValueError) as exc:
            ap.error(str(exc))
        print(f"rendered range: {render_start:.3f}s -> {render_end:.3f}s")
        out = write_preview(proj, tl, a.preview, fps=a.fps, z=a.z,
                            start=render_start, end=render_end,
                            allow_missing=a.allow_missing)
        print(f"  -> {out}")
        return
    selectors = a.at_cuts or a.at_scenes or a.at_broll
    if not a.project or (not a.times and not selectors):
        ap.error("--project and --times or one of --at-cuts/--at-scenes/--at-broll are required")
    proj, tl, path = load_project(a.project)
    print(f"timeline: {path}")
    os.makedirs(a.out, exist_ok=True)
    expectations = parse_expect(a.expect)
    try:
        rendered = qa_sample_times(
            tl, proj, times=a.times, at_cuts=a.at_cuts,
            at_scenes=a.at_scenes, at_broll=a.at_broll,
        )
    except (TypeError, ValueError) as exc:
        ap.error(str(exc))
    if not rendered:
        ap.error("no QA sample times found")
    failures = []
    tiles = []
    # An expectation whose timestamp is never rendered is a different failure from a
    # phrase that was looked for and missing. Printing it as the latter read like an
    # OCR miss and sent the last reader hunting for text that was never searched for.
    unchecked = sorted(t for t in expectations if not any(times_close(t, u) for u in rendered))
    for t in rendered:
        frame_reports = []
        if a.allow_missing:
            img, rows, W, H = render(proj, tl, t, a.z, frame_reports=frame_reports,
                                     allow_missing=True)
        else:
            img, rows, W, H = render(proj, tl, t, a.z, frame_reports=frame_reports)
        print(f"\n=== t={t}  z={a.z}  canvas {W}x{H}")
        report_extractions(t, frame_reports)
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


def _read_created(project_dir):
    if not project_dir:
        return {}
    path = os.path.join(os.fspath(project_dir), ".capcutctl", "created.json")
    try:
        with open(path) as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _draft_seconds(value):
    """Convert a CapCut microsecond timestamp to seconds."""
    return float(value or 0) / 1e6


def _segment_seconds(segment):
    timerange = segment.get("target_timerange") or {}
    start = _draft_seconds(timerange.get("start"))
    duration = _draft_seconds(timerange.get("duration"))
    return start, max(0.0, duration), start + max(0.0, duration)


def content_edit_range(project_dir, tl):
    """Return the real ``(start, end)`` edit range, excluding parked template clips.

    ``new`` records both ``contentEnd`` and the parked parts-bin window in
    ``.capcutctl/created.json``.  The sidecar is authoritative because
    ``draft.duration`` intentionally includes the parked template. For older
    projects without ``contentEnd``, the maximum eligible segment end before the
    parked start is used as the fallback.
    """
    created = _read_created(project_dir)
    preserved = created.get("preserved") or {}
    parked_start = None
    if preserved.get("start") is not None:
        parked_start = _draft_seconds(preserved.get("start"))
        if parked_start <= 0:
            parked_start = None

    recorded_end = created.get("contentEnd")
    end = _draft_seconds(recorded_end) if recorded_end is not None else 0.0
    eligible_ends = []
    starts = []
    for track in tl.get("tracks") or []:
        if track.get("type") != "video":
            continue
        for segment in track.get("segments") or []:
            start, _duration, segment_end = _segment_seconds(segment)
            if parked_start is not None and start >= parked_start - 1e-6:
                continue
            if segment_end > start:
                starts.append(max(0.0, start))
                eligible_ends.append(min(segment_end, parked_start)
                                     if parked_start is not None else segment_end)

    # The first eligible segment is often a short intro or an overlay. Do not let its end
    # truncate a legacy project; calculate the maximum first, then apply the parked and draft
    # clamps below.
    if recorded_end is None or end <= 0:
        end = max(eligible_ends, default=0.0)

    draft_end = _draft_seconds(tl.get("duration"))
    if parked_start is not None:
        end = min(end, parked_start)
    if end <= 0:
        end = min(draft_end, parked_start) if parked_start is not None else draft_end
    if draft_end > 0:
        end = min(end, draft_end)
    recorded_start = created.get("contentStart")
    start = _draft_seconds(recorded_start) if recorded_start is not None else (min(starts) if starts else 0.0)
    if parked_start is not None:
        start = min(start, parked_start)
    return max(0.0, start), max(0.0, end)


def resolve_preview_range(project_dir, tl, start=None, end=None):
    """Resolve optional preview bounds against the content range and validate them."""
    content_start, content_end = content_edit_range(project_dir, tl)
    start = content_start if start is None else float(start)
    end = content_end if end is None else float(end)
    if not np.isfinite(start) or not np.isfinite(end) or start < 0 or end < 0:
        raise ValueError("preview range must be finite and nonnegative")
    draft_end = _draft_seconds(tl.get("duration"))
    if draft_end > 0 and end > draft_end + 1e-6:
        raise ValueError(f"preview --to {end:g}s exceeds draft duration {draft_end:g}s")
    if end <= start:
        raise ValueError(f"preview range must have --to greater than --from ({start:g}..{end:g})")
    return start, end


def _content_segments(tl, content_end):
    """Yield ``(track_index, track, segment, start, end)`` before the parts bin."""
    for track_index, track in enumerate(tl.get("tracks") or []):
        if track.get("type") != "video":
            continue
        segments = sorted(track.get("segments") or [],
                          key=lambda s: (_segment_seconds(s)[0], str(s.get("id", ""))))
        for segment in segments:
            start, duration, segment_end = _segment_seconds(segment)
            if duration <= 0 or start >= content_end - 1e-6 or segment_end <= 0:
                continue
            yield track_index, track, segment, max(0.0, start), min(content_end, segment_end)


def _content_track_index(tl, content_end):
    """Choose the principal visual track using only the actual content range."""
    candidates = []
    entries = {}
    for index, track, segment, start, end in _content_segments(tl, content_end):
        entries.setdefault(index, []).append((track, segment, start, end))
    for index, values in entries.items():
        track = values[0][0]
        covered = sum(max(0.0, end - start) for _track, _segment, start, end in values)
        segments = [segment for _track, segment, _start, _end in values]
        if not segments:
            continue
        name = str(track.get("name") or "").lower()
        hint = int(any(word in name for word in ("content", "principal", "talk", "face", "a-roll", "aroll")))
        candidates.append((covered, hint, -index, index))
    if not candidates:
        return None
    return max(candidates)[-1]


def _material_index(tl):
    index = {}
    for values in (tl.get("materials") or {}).values():
        if not isinstance(values, list):
            continue
        for material in values:
            if isinstance(material, dict) and material.get("id"):
                index[material["id"]] = material
    return index


def _is_broll(track, segment, material):
    """Recognise B-roll while ignoring generated plates, rings, and endcards."""
    track_name = str(track.get("name") or "").lower()
    desc = str(segment.get("desc") or "").lower()
    path = str((material or {}).get("path") or "").lower()
    # `layout.screen` makes the recording itself a visible B-roll layer. Its frame, pip,
    # ring, and blur plates use the same layout namespace but are compositor helpers.
    if desc == "layout:screen-recording":
        return True
    helper = ("layout:" in desc or "endcard" in desc or "signature" in desc
              or "polish" in desc or "background" in desc or "ring" in desc
              or "seam" in desc)
    if helper:
        return False
    if "broll" in track_name or "b-roll" in track_name:
        return True
    if desc.startswith(("broll:", "b-roll:", "screen:")):
        return True
    return any(token in path for token in ("screen_recording", "screen-recording", "gameplay"))


def parse_times(value):
    """Parse the existing comma-separated ``--times`` form."""
    if value is None:
        return []
    times = []
    for raw in str(value).split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            time = float(raw)
        except ValueError as exc:
            raise ValueError(f"bad QA timestamp {raw!r}") from exc
        if not np.isfinite(time) or time < 0:
            raise ValueError(f"bad QA timestamp {raw!r}")
        times.append(time)
    return times


def merge_sample_times(*groups):
    """Merge sample sources, sort them, and remove only exact-time duplicates."""
    values = []
    for group in groups:
        if group is None:
            continue
        values.extend(float(value) for value in group)
    result = []
    for value in sorted(values):
        value = round(value, 6)
        if not result or abs(value - result[-1]) > 1e-6:
            result.append(value)
    return result


def qa_sample_times(tl, project_dir=None, times=None, at_cuts=False,
                    at_scenes=False, at_broll=False):
    """Build deterministic QA samples from explicit times and semantic selectors.

    Cuts are every visual segment start, scenes are the midpoint of principal
    track segments, and B-roll samples are the midpoint of each B-roll segment.
    All derived samples stop at the recorded content end, so the parked template
    never appears unless a caller explicitly supplies it via ``--times`` or
    ``--to``.
    """
    explicit = parse_times(times) if isinstance(times, str) else list(times or [])
    if not (at_cuts or at_scenes or at_broll):
        return merge_sample_times(explicit)
    _content_start, content_end = content_edit_range(project_dir, tl)
    derived = []
    principal = _content_track_index(tl, content_end)
    materials = _material_index(tl)
    if at_cuts:
        for _index, _track, _segment, start, _end in _content_segments(tl, content_end):
            derived.append(start)
    if at_scenes and principal is not None:
        for index, _track, _segment, start, end in _content_segments(tl, content_end):
            if index == principal:
                derived.append(start + (end - start) / 2.0)
    if at_broll:
        for index, track, segment, start, end in _content_segments(tl, content_end):
            if index != principal and _is_broll(track, segment, materials.get(segment.get("material_id"))):
                derived.append(start + (end - start) / 2.0)
    return merge_sample_times(explicit, derived)


def write_preview(proj, tl, out_path, fps=6, z="track", start=None, end=None,
                  allow_missing=False):
    """6fps compositor stills + timeline audio over the requested content range."""
    try:
        render_start, render_end = resolve_preview_range(proj, tl, start, end)
    except ValueError as exc:
        raise FrameExtractionError(str(exc)) from exc
    duration_s = render_end - render_start
    offsets = preview_times(duration_s, fps)
    times = [round(render_start + offset, 6) for offset in offsets]
    if not times:
        raise FrameExtractionError("preview: rendered range is empty")
    materials = _material_index(tl)
    issues = _missing_media(proj, tl, materials, render_start, render_end)
    if issues and not allow_missing:
        raise _missing_media_error(
            f"preview {render_start:g}-{render_end:g}s", issues)
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    # A default --fps 6 pass over a content range writes full-size PNGs plus the wavs.
    # Leaking that per invocation (>1GB) is what the finally is for.
    tmp = tempfile.mkdtemp(prefix="capcutctl-preview-")
    try:
        frames_dir = os.path.join(tmp, "frames")
        os.makedirs(frames_dir)
        for i, t in enumerate(times):
            if allow_missing:
                img, _, _, _ = render(proj, tl, t, z, allow_missing=True)
            else:
                img, _, _, _ = render(proj, tl, t, z)
            img.convert("RGB").save(os.path.join(frames_dir, f"f{i:06d}.png"))
        video = os.path.join(tmp, "video.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps),
             "-i", os.path.join(frames_dir, "f%06d.png"),
             "-t", f"{duration_s:.9f}",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", video],
            check=True)
        audio = _timeline_audio(proj, tl, tmp, duration_s, render_start)
        if audio:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-i", audio,
                 "-t", f"{duration_s:.9f}",
                 "-c:v", "copy", "-c:a", "aac", "-shortest", out_path],
                check=True)
        else:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                            "-t", f"{duration_s:.9f}", "-c", "copy", out_path],
                           check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out_path


def _timeline_audio(proj, tl, tmp, duration_s, range_start=0.0):
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
    _content_start, content_end = content_edit_range(proj, tl)
    principal_index = _content_track_index(tl, content_end)
    if principal_index is not None:
        sources = list((tl.get("tracks") or [])[principal_index].get("segments") or [])
    else:
        _, _track, segs = principal_video_track(tl)
        sources = list(segs)
    for tr in tl.get("tracks") or []:
        if tr.get("type") == "audio":
            sources += tr.get("segments") or []
    if not sources:
        return None
    slices = []
    range_end = range_start + duration_s
    for n, s in enumerate(sources):
        mat = idx.get(s.get("material_id"))
        if not mat:
            continue
        p = resolve(proj, mat.get("path", ""))
        if not p or not os.path.exists(p):
            continue
        tt = s["target_timerange"]
        target_start = tt["start"] / 1e6
        target_duration = tt["duration"] / 1e6
        target_end = target_start + target_duration
        overlap_start = max(target_start, range_start)
        overlap_end = min(target_end, range_end)
        if overlap_end <= overlap_start:
            continue
        # Same span/speed math as source_time — a second copy of it is how the
        # original speed bug survived, and how the null fallback drifted apart.
        src0, src_d = source_span(s)
        speed = src_d / target_duration if target_duration > 0 else 1.0
        source_start = src0 + (overlap_start - target_start) * speed
        source_duration = (overlap_end - overlap_start) * speed
        vol = s.get("volume")
        vol = 1.0 if vol is None else float(vol)      # a muted segment is not a silent slice, it is no slice
        if speed <= 0 or source_duration <= 0 or vol <= 0:
            continue
        wav = os.path.join(tmp, f"a{n:03d}.wav")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(max(0, source_start)),
               "-t", str(max(0.01, source_duration)),
               "-i", p]
        af = [x for x in (atempo_chain(speed),) if x]
        if abs(vol - 1.0) > 1e-3:
            af.append(f"volume={vol:.6f}")
        if af:
            cmd += ["-af", ",".join(af)]
        cmd += ["-ac", "1", "-ar", "44100", wav]
        try:
            subprocess.run(cmd, check=True)
            slices.append((overlap_start - range_start, wav))
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
