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
        (a streamed proxy job; do not combine it with targeted selectors or --sheet)
    python3 frame_qa.py --project NAME --times 6 --rects-only
"""
import argparse
import copy
import hashlib
import json
import math
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from collections import OrderedDict
from contextlib import suppress
from dataclasses import dataclass
from itertools import pairwise
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
_PREVIEW_COMPOSITOR_VERSION = "preview-v3"
_DEFAULT_PREVIEW_BOUNDS = (360, 640)
_DEFAULT_CUT_OFFSET = None  # one timeline frame, resolved from the draft FPS
_PREVIEW_HWACCEL = None


class FrameExtractionError(SystemExit):
    """A frame could not be extracted with a trustworthy presentation timestamp."""


class PreviewCancelled(FrameExtractionError):
    """The user interrupted a preview and all of its children were stopped."""


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


class _PreviewRuntime:
    """Own preview children and the exact temporary workspace for cancellation cleanup."""

    def __init__(self):
        self.children = set()
        self.cancelled = False
        self._previous_handlers = {}

    def __enter__(self):
        global _ACTIVE_PREVIEW
        if _ACTIVE_PREVIEW is not None:
            raise RuntimeError("preview runtime cannot be nested")
        _ACTIVE_PREVIEW = self
        for signum in (signal.SIGINT, signal.SIGTERM):
            try:
                self._previous_handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, self._handle_signal)
            except (ValueError, OSError):
                # Signal registration is only legal in the main thread. Tests and library
                # callers may render from a worker, where child tracking still works.
                continue
        return self

    def __exit__(self, exc_type, _exc, _tb):
        global _ACTIVE_PREVIEW
        if exc_type is not None or self.cancelled:
            self.terminate_children()
        for signum, handler in self._previous_handlers.items():
            try:
                signal.signal(signum, handler)
            except (ValueError, OSError):
                continue
        _ACTIVE_PREVIEW = None
        return False

    def _handle_signal(self, signum, _frame):
        self.cancelled = True
        self.terminate_children()

    def add(self, process):
        self.children.add(process)
        return process

    def discard(self, process):
        self.children.discard(process)

    def terminate_children(self):
        for process in tuple(self.children):
            _terminate_process(process)


_ACTIVE_PREVIEW = None


def _terminate_process(process):
    """Terminate a tracked ffmpeg process and its process group, when available."""
    if process is None:
        return
    try:
        if process.poll() is not None:
            return
    except (AttributeError, OSError):
        pass
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except (AttributeError, OSError, ProcessLookupError):
        try:
            process.terminate()
        except (AttributeError, OSError):
            return
    try:
        process.wait(timeout=1)
    except (AttributeError, OSError, subprocess.TimeoutExpired):
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (AttributeError, OSError, ProcessLookupError):
            with suppress(AttributeError, OSError):
                process.kill()


def _start_process(command, **kwargs):
    """Start a child, isolating it into a process group during preview work."""
    if _ACTIVE_PREVIEW is None:
        return subprocess.Popen(command, **kwargs)
    kwargs.setdefault("start_new_session", True)
    return _ACTIVE_PREVIEW.add(subprocess.Popen(command, **kwargs))


def _run_command(command, **kwargs):
    """`subprocess.run` outside previews; tracked Popen inside them."""
    if _ACTIVE_PREVIEW is None:
        return subprocess.run(command, **kwargs)
    check = kwargs.pop("check", False)
    capture_output = kwargs.pop("capture_output", False)
    text = kwargs.pop("text", False)
    if capture_output:
        kwargs.setdefault("stdout", subprocess.PIPE)
        kwargs.setdefault("stderr", subprocess.PIPE)
    process = _start_process(command, **kwargs)
    try:
        stdout, stderr = process.communicate()
    finally:
        _ACTIVE_PREVIEW.discard(process)
    if _ACTIVE_PREVIEW.cancelled:
        raise PreviewCancelled("preview cancelled")
    result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    if check and result.returncode:
        raise subprocess.CalledProcessError(
            result.returncode, command, output=stdout, stderr=stderr
        )
    if text:
        # Popen(text=True) is not used above because raw-video callers share this helper;
        # decode the captured streams only for the small ffprobe/error responses.
        for attr in ("stdout", "stderr"):
            value = getattr(result, attr)
            if isinstance(value, bytes):
                setattr(result, attr, value.decode(errors="replace"))
    return result


def _check_preview_cancelled():
    if _ACTIVE_PREVIEW is not None and _ACTIVE_PREVIEW.cancelled:
        raise PreviewCancelled("preview cancelled")

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
            result = _run_command(command, check=True, capture_output=True, text=True)
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


def grab(path, t, return_info=False, fps=None, size=None):
    """Return a cached image, optionally decoded/resized for a proxy canvas."""
    size_key = tuple(size) if size else None
    key = (path, round(float(t), 6), size_key)
    if key in _CACHE and (not return_info or key in _FRAME_INFO):
        _CACHE.move_to_end(key)
        if return_info:
            return _copy_sample(_FRAME_INFO[key])
        return _CACHE[key].copy()
    sample = extract_frame(path, t, fps=fps)
    if size and sample.image.size != tuple(size):
        sample = _copy_sample(sample, sample.image.resize(tuple(size), Image.LANCZOS))
    _cache_put(key, sample.image)
    _FRAME_INFO[key] = _copy_sample(sample)
    if return_info:
        return _copy_sample(sample)
    return sample.image.copy()


# --- CapCut's Adjust panel, as the compositor sees it -------------------------------------
# `doctor` cannot see the picture and `qa` is the check that can, so `qa` has to render the
# colour too — otherwise a graded project would QA as its ungraded self and the one pass
# whose whole output IS the picture would be the one pass nobody could look at.
#
# This is CapCut's own fragment shader (Cache/effect/7501974767453474064/<hash>/
# AmazingFeature_adjustColor/xshader/colorAdjust.frag), in the shader's own order. It is the
# same model as src/grade.mjs; keep the two in step. Preview only — nothing here is ever
# written back into the project's media.
ADJUST_TYPES = ("brightness", "contrast", "saturation", "highlight", "shadow",
                "white", "black", "temperature", "tone")
_SAT_LUMA = np.array([0.208540, 0.702086, 0.089374], dtype=np.float32)
_REC709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
_CONTRAST_GAIN, _BLACK_REACH, _WHITE_REACH = 2.0, 0.20, 0.30
_TEMP_REACH, _TINT_REACH = 0.22, 0.18


def apply_adjust(rgb, g):
    """rgb: float32 HxWx3 in 0..1. g: {slider: value in -1..1}. Returns a new array."""
    c = np.clip(rgb.astype(np.float32), 0.0, 1.0)

    v = g.get("brightness", 0.0)
    if v:
        if v > 0:
            p = 1.0 + v * 5.0
        else:
            p = 1.0 / (1.0 - v * 2.5)
            c = c - (-v * 0.01)
        c = np.clip(1.0 - np.power(np.clip(1.0 - c, 0.0, 1.0), p), 0.0, 1.0)

    v = g.get("contrast", 0.0)
    if v:
        pivot = 0.5
        if v <= 0:
            c = np.clip((1.0 + v) * (c - pivot) + pivot, 0.0, 1.0)
        else:
            k = 4.0 + v * _CONTRAST_GAIN * 4.0
            def sig(x):
                return 1.0 / (1.0 + np.exp(-k * (x - pivot))) + pivot - 0.5
            lo, hi = sig(np.float32(0.0)), sig(np.float32(1.0))
            c = np.clip((sig(c) - lo) / (hi - lo), 0.0, 1.0)

    v = g.get("saturation", 0.0)
    if v:
        u = 1.0 + v                                   # u=1 identity, u=0 monochrome
        base = _SAT_LUMA * (1.0 - u)
        m = np.tile(base, (3, 1)) + np.eye(3, dtype=np.float32) * u
        c = np.clip(c @ m.T, 0.0, 1.0)

    v = g.get("highlight", 0.0)
    if v:
        p = 1.0 - v * 0.5                             # p=1 identity
        t = 1.0 - c
        c = np.clip(1.0 - np.power(t, p) - (p - 1.0) * (t ** 2 - t ** 3), 0.0, 1.0)

    v = g.get("shadow", 0.0)
    if v:
        p = 1.0 - v * 0.5                             # p=1 identity
        c = np.clip(np.power(c, p) + (p - 1.0) * (c ** 2 - c ** 3), 0.0, 1.0)

    if g.get("black") or g.get("white"):
        lo = -g.get("black", 0.0) * _BLACK_REACH
        hi = 1.0 - g.get("white", 0.0) * _WHITE_REACH
        slope = 1.0 / max(1e-3, hi - lo)
        c = np.clip(slope * c - lo * slope, 0.0, 1.0)

    if g.get("temperature") or g.get("tone"):
        t = g.get("temperature", 0.0) * _TEMP_REACH
        n = g.get("tone", 0.0) * _TINT_REACH
        y0 = c @ _REC709
        out = c * np.array([(1 + t) * (1 + n * 0.5), (1 - n), (1 - t) * (1 + n * 0.5)],
                           dtype=np.float32)
        y1 = out @ _REC709
        k = np.where(y1 > 1e-4, y0 / np.maximum(y1, 1e-4), 1.0)[..., None]
        c = np.clip(out * k, 0.0, 1.0)

    return c


def segment_grade(segment, idx):
    """The Adjust sliders CapCut would apply to this segment, or {} if it carries none."""
    if segment.get("enable_adjust") is False:
        return {}
    g = {}
    for ref in segment.get("extra_material_refs", []) or []:
        kind, m = idx.get(ref, (None, None))
        if kind == "effects" and m and m.get("type") in ADJUST_TYPES:
            value = m.get("value")
            if isinstance(value, (int, float)) and abs(value) > 1e-4:
                g[m["type"]] = float(value)
    return g


def grade_image(im, g):
    """Apply `g` to an RGBA PIL image, leaving alpha untouched."""
    if not g:
        return im
    a = np.asarray(im.convert("RGBA"), dtype=np.uint8)
    rgb = apply_adjust(a[..., :3].astype(np.float32) / 255.0, g)
    a = np.dstack([np.round(rgb * 255.0).astype(np.uint8), a[..., 3:4]])
    return Image.fromarray(a, "RGBA")


# ---------------------------------------------------------------------------
# Keyframes. `place` was always handed segment["clip"] verbatim, so every
# animated property rendered at its BASE value — a logo whose pop keyframes
# take it from 0.15 to 1.0 drew at 0.15, and one that fades in from alpha 0
# drew as nothing at all. The frame was then reported as if it were the
# picture. Anything keyframed (logo pops, face push-ins, `zoom`) was outside
# what qa could see, which is exactly the class of defect it exists to catch.
# ---------------------------------------------------------------------------

_KF_PROPERTIES = {
    "KFTypeScaleX": ("scale", "x"),
    "KFTypeScaleY": ("scale", "y"),
    "KFTypePositionX": ("transform", "x"),
    "KFTypePositionY": ("transform", "y"),
    "KFTypeAlpha": ("alpha", None),
    "KFTypeRotation": ("rotation", None),
}


def _keyframe_value(points, source_us):
    """Interpolate one keyframe_list at an absolute SOURCE position."""
    if not points:
        return None
    if source_us <= points[0]["time_offset"]:
        return points[0]["values"][0]
    if source_us >= points[-1]["time_offset"]:
        return points[-1]["values"][0]
    for a, b in pairwise(points):
        if not (a["time_offset"] <= source_us <= b["time_offset"]):
            continue
        ax, ay = float(a["time_offset"]), float(a["values"][0])
        bx, by = float(b["time_offset"]), float(b["values"][0])
        # Straight line between keys, for BOTH curve types.
        #
        # A FreeCurveInOut key carries left_control/right_control handles, but the convention
        # for their y component is not something this codebase has established — read as an
        # offset from the key's own value, the one real harvested block (Higgsfield Refund)
        # describes a curve that overshoots its endpoint, which may be that shot's actual
        # easing or may be a misreading. CapCut reads its own format correctly either way, so
        # the PROJECT is unaffected; only this preview is. Interpolating straight is honest:
        # it is exact at every key, and it can never invent motion that is not in the file.
        # What qa is for is geometry and placement, not easing character.
        span = bx - ax
        return ay if span <= 0 else ay + (by - ay) * (source_us - ax) / span
    return points[-1]["values"][0]


def effective_clip(segment, source_seconds):
    """segment["clip"] with its keyframed properties resolved at this instant."""
    clip = copy.deepcopy(segment.get("clip") or {})
    blocks = segment.get("common_keyframes") or []
    if not blocks:
        return clip
    source_us = float(source_seconds) * 1e6
    saw_scale_y = False
    for block in blocks:
        target = _KF_PROPERTIES.get(block.get("property_type"))
        if not target:
            continue
        value = _keyframe_value(block.get("keyframe_list") or [], source_us)
        if value is None:
            continue
        group, member = target
        if member is None:
            clip[group] = value
        else:
            clip.setdefault(group, {})[member] = value
            if block.get("property_type") == "KFTypeScaleY":
                saw_scale_y = True
    # CapCut aspect-locks scale by default and writes ScaleX alone (472 blocks
    # against 77 for ScaleY across the drafts here). Mirroring X onto Y is what
    # the app does; not mirroring it renders a logo squashed to its base height.
    if not saw_scale_y and any(b.get("property_type") == "KFTypeScaleX" for b in blocks):
        scale = clip.get("scale")
        if isinstance(scale, dict) and "x" in scale:
            scale["y"] = scale["x"]
    return clip


def place(canvas, im, clip, W, H, blur=False, mask=None):
    sw, sh = im.size
    k0 = min(W / sw, H / sh)
    sc = clip.get("scale", {})
    w = max(1, round(sw * k0 * sc.get("x", 1.0)))
    h = max(1, round(sh * k0 * sc.get("y", 1.0)))
    tf = clip.get("transform", {})
    cx = W / 2 + tf.get("x", 0.0) * (W / 2)
    cy = H / 2 - tf.get("y", 0.0) * (H / 2)          # y positive = UP
    if im.size != (w, h):
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


def render(proj, tl, t, z="track", frame_reports=None, allow_missing=False, no_grade=False,
           output_size=None, frame_provider=None):
    cc = tl.get("canvas_config", {})
    native_w, native_h = cc.get("width", 1080), cc.get("height", 1920)
    W, H = tuple(output_size) if output_size else (native_w, native_h)
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
        sample = (frame_provider(p, st) if frame_provider is not None
                  else grab(p, st, return_info=True, fps=tl.get("fps")))
        image = sample.image if isinstance(sample, FrameSample) else sample
        if frame_reports is not None and isinstance(sample, FrameSample):
            frame_reports.append((p, sample))
        adjust = {} if no_grade else segment_grade(s, idx)
        if adjust:
            image = grade_image(image, adjust)
        rc = place(canvas, image, effective_clip(s, st), W, H, blur, mask)
        label = os.path.basename(p)[:34]
        if adjust:
            label += " +grade(" + ",".join(sorted(adjust)) + ")"
        rows.append((ti, s["id"][:8], label, rc))
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
    sheet.save(out, compress_level=1)
    return out


def write_simple_targeted(proj, tl, times, out_dir, sheet=None, labels=None,
                          guides=None, tile_w=240, z="track"):
    """Export identity, single-source A-roll seam frames and its sheet in one ffmpeg pass."""
    if z != "track":
        return None
    content_start, content_end = content_edit_range(proj, tl)
    segments = simple_aroll_segments(proj, tl, content_start, content_end)
    if not segments:
        return None
    mapped = []
    for timeline_time in times:
        row = next((item for item in segments
                    if item["timeline_start"] <= timeline_time < item["timeline_end"]), None)
        if row is None:
            return None
        mapped.append((timeline_time, row, source_time(row["segment"], timeline_time)))
    paths = {row["path"] for _timeline_time, row, _source_time in mapped}
    source_times = [source_time_ for _timeline_time, _row, source_time_ in mapped]
    if len(paths) != 1 or source_times != sorted(source_times):
        return None

    source = paths.pop()
    info = _probe_video_info(source)
    if not info:
        return None
    try:
        period = 1.0 / float(info.get("fps") or tl.get("fps") or 30)
    except (TypeError, ValueError, ZeroDivisionError):
        period = _DEFAULT_FRAME_PERIOD
    unique = sorted({round(value, 6) for value in source_times})
    half = max(period, 1e-4) * 0.49
    seek_start = max(0.0, unique[0] - _SEEK_PREROLL)
    selector = "+".join(
        f"between(t\\,{max(0.0, value - seek_start - half):.9f}\\,{value - seek_start + half:.9f})"
        for value in unique
    )
    canvas = tl.get("canvas_config") or {}
    width, height = int(canvas.get("width") or 1080), int(canvas.get("height") or 1920)
    filters = [f"select='{selector}'", f"scale={width}:{height}:flags=fast_bilinear"]
    for guide in (guides or [height / 2]):
        filters.append(f"drawbox=x=0:y={max(0, round(float(guide)) - 2)}:w=iw:h=4:color=red:t=fill")

    tmp = tempfile.mkdtemp(prefix="capcutctl-targeted-")
    try:
        pattern = os.path.join(tmp, "%06d.png")
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            *_preview_decode_options(), "-ss", f"{seek_start:.9f}", "-i", source,
            "-t", f"{unique[-1] - seek_start + half + period:.9f}",
        ]
        if sheet:
            filter_graph = ",".join(filters) + (
                f",split=2[full][small];[small]scale={int(tile_w)}:-1:flags=fast_bilinear,"
                f"tile={len(unique)}x1:padding=6:margin=6[sheet]"
            )
            raw_sheet = os.path.join(tmp, "sheet.png")
            command += [
                "-filter_complex", filter_graph,
                "-map", "[full]", "-an", "-fps_mode", "vfr", "-compression_level", "1", pattern,
                "-map", "[sheet]", "-frames:v", "1", "-compression_level", "1", raw_sheet,
            ]
        else:
            raw_sheet = None
            command += ["-vf", ",".join(filters), "-an", "-fps_mode", "vfr",
                        "-compression_level", "1", pattern]
        result = _run_command(command, check=False, capture_output=True, text=True)
        if result.returncode:
            raise FrameExtractionError(f"targeted QA ffmpeg failed: {(result.stderr or '').strip()}")
        generated = sorted(Path(tmp).glob("[0-9]*.png"))
        if len(generated) != len(unique):
            raise FrameExtractionError(
                f"targeted QA decoded {len(generated)} frames for {len(unique)} source requests")
        by_source = dict(zip(unique, generated, strict=True))
        os.makedirs(out_dir, exist_ok=True)
        tiles = []
        labels = labels or []
        for index, (timeline_time, row, source_time_) in enumerate(mapped):
            destination = os.path.join(out_dir, f"t{timeline_time:g}.png")
            shutil.copyfile(by_source[round(source_time_, 6)], destination)
            label = labels[index] if index < len(labels) else f"t={timeline_time:g}"
            tiles.append((destination, label))
            print(f"\n=== t={timeline_time}  z=track  canvas {width}x{height}")
            print(f"  frame requested/delivered PTS {source_time_:.6f}s (targeted-batch)")
            print(f"  trk{row['track_index']:<2} {str(row['segment'].get('id') or '')[:8]} "
                  f"{os.path.basename(source)[:34]} x0..{width} y0..{height}  {width}x{height}")
            print(f"  -> {destination}")
        if sheet and raw_sheet:
            image = Image.open(raw_sheet).convert("RGB")
            draw = ImageDraw.Draw(image)
            stride = int(tile_w) + 6
            for index, (_destination, label) in enumerate(tiles):
                draw.text((6 + index * stride, 5), str(label)[:44], fill=(255, 235, 90))
            image.save(sheet, compress_level=1)
            print(f"\n  -> {sheet}")
        return tiles
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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
                    help="sample one native frame on each side of every visual cut")
    ap.add_argument("--at-scenes", action="store_true",
                    help="sample the midpoint of every principal-track scene")
    ap.add_argument("--at-broll", action="store_true",
                    help="sample the midpoint of every B-roll segment")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--out", default=None,
                    help="targeted QA frame directory (incompatible with --preview)")
    ap.add_argument("--z", choices=["track", "render_index"], default="track")
    ap.add_argument("--guide", type=float, action="append", default=[],
                    help="draw a horizontal guide at this y (repeatable); 960 = the half line")
    ap.add_argument("--rects-only", action="store_true")
    ap.add_argument("--no-grade", action="store_true",
                    help="render each clip ungraded — the before half of a before/after")
    ap.add_argument("--sheet", nargs="?", const="sheet.png", default=None,
                    help="also write a labelled contact sheet of every rendered frame")
    ap.add_argument("--label", action="append", default=[],
                    help="caption for the Nth frame (repeatable); defaults to the timecode")
    ap.add_argument("--expect", action="append", default=[],
                    help="SECONDS=phrase[|phrase] — assert the rendered frame contains it "
                         "(repeatable). Exit 1 if any expectation fails.")
    ap.add_argument("--ocr", action="store_true", help="print the text found in each frame")
    ap.add_argument("--languages", default="en-US,ar")
    ap.add_argument("--width", type=int, default=None, help="tile width in the contact sheet")
    ap.add_argument("--preview", nargs="?", const="preview.mp4", default=None,
                    help="write a streamed watchable proxy (optional path; separate from targeted QA)")
    ap.add_argument("--fps", type=float, default=6, help="preview frame rate (default 6)")
    ap.add_argument("--allow-missing", action="store_true",
                    help="explicitly allow degraded black output for missing video media")
    ap.add_argument("--from", dest="from_time", type=float,
                    help="preview start in timeline seconds (default: content start)")
    ap.add_argument("--to", dest="to_time", type=float,
                     help="preview end in timeline seconds (default: content end)")
    ap.add_argument("--resolution", help="proxy bound such as 360x640 (default; preserves aspect ratio)")
    ap.add_argument("--native", action="store_true",
                    help="opt into native-resolution preview encoding")
    ap.add_argument("--no-cache", action="store_true",
                    help="do not read or write the fingerprinted preview cache")
    ap.add_argument("--cut-window", type=float,
                    help="distance in seconds from each cut for targeted samples (default: one frame)")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(_selftest())
    if a.preview:
        if not a.project:
            ap.error("--project is required")
        conflicts = []
        if a.times:
            conflicts.append("--times")
        if a.at_cuts:
            conflicts.append("--at-cuts")
        if a.at_scenes:
            conflicts.append("--at-scenes")
        if a.at_broll:
            conflicts.append("--at-broll")
        if a.sheet is not None:
            conflicts.append("--sheet")
        if a.expect:
            conflicts.append("--expect")
        if a.out is not None:
            conflicts.append("--out")
        if a.label:
            conflicts.append("--label")
        if a.ocr:
            conflicts.append("--ocr")
        if a.rects_only:
            conflicts.append("--rects-only")
        if a.guide:
            conflicts.append("--guide")
        if a.width is not None:
            conflicts.append("--width")
        if conflicts:
            joined = ", ".join(conflicts)
            ap.error(f"--preview cannot be combined with {joined}; run separate targeted QA and preview commands")
        proj, tl, path = load_project(a.project)
        print(f"timeline: {path}")
        try:
            render_start, render_end = resolve_preview_range(
                proj, tl, start=a.from_time, end=a.to_time
            )
            estimate = preview_estimate(
                proj, tl, fps=a.fps, start=render_start, end=render_end,
                resolution=a.resolution, native=a.native, no_grade=a.no_grade,
                allow_missing=a.allow_missing,
            )
        except (TypeError, ValueError) as exc:
            ap.error(str(exc))
        print(f"rendered range: {render_start:.3f}s -> {render_end:.3f}s")
        print(format_preview_estimate(estimate), end="")
        try:
            out = write_preview(proj, tl, a.preview, fps=a.fps, z=a.z,
                                start=render_start, end=render_end,
                                allow_missing=a.allow_missing, resolution=a.resolution,
                                native=a.native, cache=not a.no_cache, no_grade=a.no_grade,
                                announce=False)
        except PreviewCancelled:
            print("preview cancelled", file=sys.stderr)
            raise SystemExit(130) from None
        except FrameExtractionError as exc:
            ap.error(str(exc))
        print(f"  -> {out}")
        return
    selectors = a.at_cuts or a.at_scenes or a.at_broll
    if not a.project or (not a.times and not selectors):
        ap.error("--project and --times or one of --at-cuts/--at-scenes/--at-broll are required")
    proj, tl, path = load_project(a.project)
    print(f"timeline: {path}")
    qa_out = a.out or "qa"
    os.makedirs(qa_out, exist_ok=True)
    expectations = parse_expect(a.expect)
    try:
        rendered = qa_sample_times(
            tl, proj, times=a.times, at_cuts=a.at_cuts,
            at_scenes=a.at_scenes, at_broll=a.at_broll, cut_window=a.cut_window,
        )
    except (TypeError, ValueError) as exc:
        ap.error(str(exc))
    if not rendered:
        ap.error("no QA sample times found")
    if not (a.rects_only or a.ocr or expectations or a.allow_missing):
        sheet_path = None
        if a.sheet:
            sheet_path = a.sheet if os.path.isabs(a.sheet) else os.path.join(qa_out, a.sheet)
            os.makedirs(os.path.dirname(os.path.abspath(sheet_path)), exist_ok=True)
        with _PreviewRuntime():
            fast = write_simple_targeted(
                proj, tl, rendered, qa_out, sheet=sheet_path, labels=a.label,
                guides=a.guide, tile_w=a.width or 240, z=a.z,
            )
        if fast is not None:
            return
    failures = []
    tiles = []
    # An expectation whose timestamp is never rendered is a different failure from a
    # phrase that was looked for and missing. Printing it as the latter read like an
    # OCR miss and sent the last reader hunting for text that was never searched for.
    unchecked = sorted(t for t in expectations if not any(times_close(t, u) for u in rendered))
    cc = tl.get("canvas_config") or {}
    native_size = (int(cc.get("width") or 1080), int(cc.get("height") or 1920))
    with _PreviewRuntime():
        # Decode the finite set of native seam samples once per source. This keeps the
        # targeted path pixel-accurate at the timeline canvas size without launching one
        # ffmpeg process per cut; stills and unusual/VFR sources fall back to grab().
        print(f"targeted QA: preparing {len(rendered)} native samples; batched source decoding",
              flush=True)
        provider = _PreviewFrameProvider(proj, tl, rendered, native_size)
        content_start, content_end = content_edit_range(proj, tl)
        simple_target = simple_aroll_segments(proj, tl, content_start, content_end)
        simple_target = (simple_target
                         if simple_target and all(
                             any(row["timeline_start"] <= t < row["timeline_end"]
                                 for row in simple_target) for t in rendered)
                         else None)
        simple_target = (simple_target
                         if simple_target and all(row["path"] in provider.batch_paths
                                                  for row in simple_target)
                         else None)
        print(f"targeted QA: {len(rendered)} native samples ready", flush=True)
        for t in rendered:
            frame_reports = []
            if simple_target and a.z == "track":
                img, rows, reports, W, H = _render_simple_aroll_frame(
                    t, simple_target, provider, native_size)
                frame_reports.extend(reports)
            else:
                kwargs = {"frame_reports": frame_reports, "frame_provider": provider,
                          "no_grade": a.no_grade}
                if a.allow_missing:
                    kwargs["allow_missing"] = True
                img, rows, W, H = render(proj, tl, t, a.z, **kwargs)
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
                        img.convert("RGB").save(f, compress_level=1)
                        report_frame(f, t, wanted, a.ocr, a.languages, failures)
                continue
            d = ImageDraw.Draw(img)
            for g in (a.guide or [H / 2]):
                d.line([0, g, W, g], fill=(255, 0, 0, 255), width=4)
                d.text((14, g + 8), f"y={g:g}", fill=(255, 90, 90, 255))
            f = os.path.join(qa_out, f"t{t:g}.png")
            img.convert("RGB").save(f, compress_level=1)
            print(f"  -> {f}")
            if a.ocr or wanted:
                report_frame(f, t, wanted, a.ocr, a.languages, failures)
            tiles.append((f, a.label[len(tiles)] if len(tiles) < len(a.label) else f"t={t:g}"))

    if a.sheet and tiles:
        out = a.sheet if os.path.isabs(a.sheet) else os.path.join(qa_out, a.sheet)
        print(f"\n  -> {contact_sheet(tiles, out, a.width or 240)}")

    if failures or unchecked:
        print(f"\n{len(failures) + len(unchecked)} expectation(s) failed:")
        for t in unchecked:
            print(f"  t={t:g}  NOT CHECKED — no such timestamp in --times")
        for t, phrase in failures:
            print(f"  t={t:g}  {phrase!r} is not on screen")
        sys.exit(1)


def preview_times(duration_s, fps=6):
    """CFR input timestamps that ffmpeg can encode without overrunning the range."""
    if duration_s <= 0 or fps <= 0:
        return []
    count = max(1, math.floor(float(duration_s) * float(fps) + 1e-9))
    return [round(index / float(fps), 6) for index in range(count)]


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


def _typed_material_index(tl):
    """Index material refs with their CapCut collection kind as well as their value."""
    index = {}
    for kind, values in (tl.get("materials") or {}).items():
        if not isinstance(values, list):
            continue
        for material in values:
            if isinstance(material, dict) and material.get("id"):
                index[material["id"]] = (kind, material)
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
                    at_scenes=False, at_broll=False, cut_window=None):
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
        try:
            frame_period = 1.0 / float(tl.get("fps") or 30)
        except (TypeError, ValueError):
            frame_period = _DEFAULT_FRAME_PERIOD
        offset = frame_period if cut_window is None else float(cut_window)
        if not np.isfinite(offset) or offset <= 0:
            raise ValueError("--cut-window must be finite and greater than zero")
        for _index, _track, _segment, start, _end in _content_segments(tl, content_end):
            if start <= _content_start + 1e-6:
                # There is no frame before t=0; retain the opening proof frame and sample
                # the first frame after it below when it is inside the edit.
                derived.append(start)
            else:
                derived.extend((max(_content_start, start - offset),
                                min(content_end - _FRAME_EPS, start + offset)))
    if at_scenes and principal is not None:
        for index, _track, _segment, start, end in _content_segments(tl, content_end):
            if index == principal:
                derived.append(start + (end - start) / 2.0)
    if at_broll:
        for index, track, segment, start, end in _content_segments(tl, content_end):
            if index != principal and _is_broll(track, segment, materials.get(segment.get("material_id"))):
                derived.append(start + (end - start) / 2.0)
    return merge_sample_times(explicit, derived)


def parse_preview_resolution(value):
    """Parse a proxy bound such as ``360x640`` without silently changing aspect ratio."""
    if value is None:
        return None
    text = str(value).strip().lower()
    match = re.fullmatch(r"(\d+)x(\d+)", text)
    if not match:
        raise ValueError(f"preview resolution must be WIDTHxHEIGHT, got {value!r}")
    width, height = (int(part) for part in match.groups())
    if width < 2 or height < 2:
        raise ValueError("preview resolution must be at least 2x2")
    return width, height


def _even(value):
    return max(2, int(value) - (int(value) % 2))


def preview_dimensions(tl, resolution=None, native=False):
    """Return the actual proxy canvas, preserving the timeline's aspect ratio."""
    canvas = tl.get("canvas_config") or {}
    native_width = int(canvas.get("width") or 1080)
    native_height = int(canvas.get("height") or 1920)
    if native:
        return _even(native_width), _even(native_height)
    bounds = parse_preview_resolution(resolution) or _DEFAULT_PREVIEW_BOUNDS
    scale = min(bounds[0] / native_width, bounds[1] / native_height, 1.0)
    return _even(round(native_width * scale)), _even(round(native_height * scale))


def _json_fingerprint(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def _media_fingerprint(project_dir, tl):
    rows = []
    seen = set()
    for values in (tl.get("materials") or {}).values():
        if not isinstance(values, list):
            continue
        for material in values:
            if not isinstance(material, dict):
                continue
            raw = material.get("path")
            if not isinstance(raw, str) or raw in seen:
                continue
            seen.add(raw)
            resolved = resolve(project_dir, raw)
            try:
                stat = os.stat(resolved)
                rows.append({"path": raw, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
            except OSError:
                rows.append({"path": raw, "missing": True})
    return rows


def content_fingerprint(project_dir, tl):
    """Fingerprint draft JSON plus media identity, without hashing multi-GB recordings."""
    return _json_fingerprint({"timeline": tl, "media": _media_fingerprint(project_dir, tl)})


def preview_cache_key(project_dir, tl, start, end, fps, resolution, native=False, z="track",
                      no_grade=False, allow_missing=False, mode=None):
    """Stable cache key for one rendered preview request."""
    width, height = preview_dimensions(tl, resolution, native)
    return _json_fingerprint({
        "compositor": _PREVIEW_COMPOSITOR_VERSION,
        "content": content_fingerprint(project_dir, tl),
        "range": [round(float(start), 6), round(float(end), 6)],
        "fps": round(float(fps), 6),
        "resolution": [width, height],
        "z": z,
        "no_grade": bool(no_grade),
        "allow_missing": bool(allow_missing),
        "mode": mode,
    })


def preview_cache_path(project_dir, key):
    return os.path.join(project_dir, ".capcutctl", "preview-cache", f"{key}.mp4")


def _identity_clip(segment, materials=None, typed_materials=None):
    clip = segment.get("clip") or {}
    scale = clip.get("scale") or {}
    transform = clip.get("transform") or {}
    def close(value, target):
        return abs(float(value) - target) <= 1e-6
    try:
        refs = segment.get("extra_material_refs") or []
        visual_refs = []
        for ref in refs:
            kind, material = ((typed_materials or {}).get(ref, (None, (materials or {}).get(ref, {}))))
            material = material or {}
            material_type = material.get("type")
            # CapCut attaches several no-op bookkeeping records to every clip. The
            # compositor only changes pixels for the visual collections below; retaining
            # those records would incorrectly disable the fast A-roll path on real drafts.
            if kind in {"speeds", "audio_fades", "placeholder_infos", "canvases",
                        "sound_channel_mappings", "material_colors", "loudnesses",
                        "vocal_separations"} or material_type in {
                            "audio_fade", "speed", "placeholder_info", "canvas_color",
                            "none", "vocal_separation",
                        }:
                continue
            if (kind in {"video_effects", "masks", "common_mask", "effects"}
                    or material.get("name") == "Blur" or material_type in ADJUST_TYPES):
                visual_refs.append(ref)
        return (close(scale.get("x", 1), 1) and close(scale.get("y", 1), 1)
                and close(transform.get("x", 0), 0) and close(transform.get("y", 0), 0)
                and close(clip.get("rotation", 0), 0)
                and close(segment.get("alpha", clip.get("alpha", 1)), 1)
                and not any((clip.get("flip") or {}).values())
                and not segment.get("reverse", False)
                and not visual_refs
                and not segment.get("enable_video_mask", False)
                and not segment.get("common_keyframes")
                and not segment.get("keyframe_refs"))
    except (TypeError, ValueError):
        return False


def simple_aroll_segments(project_dir, tl, start, end):
    """Return a concat-safe A-roll EDL, or ``None`` for a composited timeline."""
    _content_start, content_end = content_edit_range(project_dir, tl)
    principal = _content_track_index(tl, content_end)
    if principal is None:
        return None
    entries = list(_content_segments(tl, content_end))
    principal_entries = [entry for entry in entries
                         if entry[0] == principal and entry[4] > start and entry[3] < end]
    other_video = [entry for entry in entries
                   if entry[0] != principal and entry[4] > start and entry[3] < end]
    if not principal_entries or other_video:
        return None
    if any(track.get("type") == "audio" and track.get("segments")
           for track in tl.get("tracks") or []):
        return None
    materials = _material_index(tl)
    typed_materials = _typed_material_index(tl)
    selected = []
    cursor = start
    for _index, _track, segment, seg_start, seg_end in sorted(principal_entries, key=lambda row: row[3]):
        overlap_start = max(start, seg_start)
        overlap_end = min(end, seg_end)
        if overlap_end <= overlap_start:
            continue
        if overlap_start > cursor + 1e-4 or not _identity_clip(segment, materials, typed_materials):
            return None
        material = materials.get(segment.get("material_id"))
        media_path, error = _material_path(project_dir, material)
        if error or not media_path or media_path.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            return None
        src_start, src_duration = source_span(segment)
        target_duration = seg_end - seg_start
        if src_duration <= 0 or target_duration <= 0:
            return None
        speed = src_duration / target_duration
        selected.append({
            "segment": segment,
            "path": media_path,
                "timeline_start": overlap_start,
                "timeline_end": overlap_end,
                "track_index": principal,
                "source_start": src_start + (overlap_start - seg_start) * speed,
            "source_duration": (overlap_end - overlap_start) * speed,
            "target_duration": overlap_end - overlap_start,
            "speed": speed,
        })
        cursor = overlap_end
    if not selected or cursor < end - 1e-4:
        return None
    return selected


def preview_mode(project_dir, tl, start, end):
    return "a-roll-concat" if simple_aroll_segments(project_dir, tl, start, end) else "compositor-stream"


def preview_estimate(project_dir, tl, fps=6, start=None, end=None, resolution=None, native=False,
                     z="track", no_grade=False, allow_missing=False):
    """Describe the bounded work before any decoder or encoder starts."""
    try:
        fps = float(fps)
    except (TypeError, ValueError) as exc:
        raise ValueError("preview FPS must be finite and greater than zero") from exc
    if not np.isfinite(fps) or fps <= 0:
        raise ValueError("preview FPS must be finite and greater than zero")
    render_start, render_end = resolve_preview_range(project_dir, tl, start, end)
    width, height = preview_dimensions(tl, resolution, native)
    duration = render_end - render_start
    frames = len(preview_times(duration, fps))
    mode = preview_mode(project_dir, tl, render_start, render_end)
    return {
        "range": {"start": render_start, "end": render_end, "duration": duration},
        "fps": fps,
        "frames": frames,
        "frameCount": frames,
        "resolution": {"width": width, "height": height},
        "mode": mode,
        "temporary": "streamed rawvideo; no per-frame PNGs; bounded audio workspace",
        "cache": "fingerprinted project preview cache" if not allow_missing else "disabled for degraded media",
        "z": z,
        "graded": not no_grade,
    }


def format_preview_estimate(estimate):
    r = estimate["range"]
    size = estimate["resolution"]
    return ("preview preflight:\n"
            f"  range: {r['start']:.3f}s -> {r['end']:.3f}s ({r['duration']:.3f}s)\n"
            f"  output: {size['width']}x{size['height']} @ {estimate['fps']:g}fps\n"
            f"  frames: {estimate['frames']} CFR frames\n"
            f"  mode: {estimate['mode']}\n"
            f"  temp: {estimate['temporary']}\n")


def _emit_preview_progress(callback, completed, total, started):
    elapsed = max(0.0, time.monotonic() - started)
    eta = (elapsed * (total - completed) / completed) if completed else None
    if callback is not None:
        callback(completed, total, elapsed, eta)
        return
    percent = 100 if total <= 0 else round(completed * 100 / total)
    eta_text = "--" if eta is None else f"{eta:.1f}s"
    print(f"preview {completed}/{total} ({percent}%) elapsed {elapsed:.1f}s ETA {eta_text}", flush=True)


def _atomic_copy(source, destination):
    destination = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination) or ".", exist_ok=True)
    if os.path.abspath(source) == destination:
        return destination
    temporary = f"{destination}.tmp-{os.getpid()}"
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        with suppress(FileNotFoundError):
            os.unlink(temporary)
    return destination


def _probe_video_info(path):
    """Return source dimensions/fps/audio presence, or ``None`` when probing fails."""
    try:
        result = _run_command([
            "ffprobe", "-v", "error", "-show_streams", "-of", "json", path,
        ], check=False, capture_output=True, text=True)
        if result.returncode:
            return None
        data = json.loads(result.stdout or "{}")
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None
    streams = data.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video:
        return None
    try:
        width = int(video["width"])
        height = int(video["height"])
    except (KeyError, TypeError, ValueError):
        return None
    fps = None
    rate = str(video.get("avg_frame_rate") or video.get("r_frame_rate") or "")
    if "/" in rate:
        numerator, denominator = rate.split("/", 1)
        try:
            fps = float(numerator) / float(denominator)
        except (TypeError, ValueError, ZeroDivisionError):
            fps = None
    return {"width": width, "height": height, "fps": fps, "audio": any(
        stream.get("codec_type") == "audio" for stream in streams
    )}


def _preview_decode_options():
    """Use Apple's decoder when this ffmpeg build exposes it; return [] elsewhere."""
    global _PREVIEW_HWACCEL
    if _PREVIEW_HWACCEL is not None:
        return _PREVIEW_HWACCEL
    _PREVIEW_HWACCEL = []
    if sys.platform != "darwin":
        return _PREVIEW_HWACCEL
    try:
        result = _run_command(
            ["ffmpeg", "-hide_banner", "-hwaccels"],
            check=False, capture_output=True, text=True,
        )
        available = f"{result.stdout or ''}\n{result.stderr or ''}"
        if "videotoolbox" in available:
            _PREVIEW_HWACCEL = ["-hwaccel", "videotoolbox"]
    except OSError:
        pass
    return _PREVIEW_HWACCEL


def _source_preview_dimensions(info, output_size):
    """Keep batch-decoded source frames small while retaining their original aspect ratio."""
    if not info or not info.get("width") or not info.get("height"):
        return None
    width, height = info["width"], info["height"]
    max_width, max_height = output_size
    scale = min(max_width / width, max_height / height, 1.0)
    return _even(round(width * scale)), _even(round(height * scale))


def _preview_requests(project_dir, tl, times):
    """Collect unique source timestamps needed by a compositor preview."""
    materials = _material_index(tl)
    requests = OrderedDict()
    for timeline_time in times:
        us = int(float(timeline_time) * 1e6)
        for track in tl.get("tracks") or []:
            if track.get("type") != "video":
                continue
            for segment in track.get("segments") or []:
                timerange = segment.get("target_timerange") or {}
                try:
                    seg_start = int(timerange["start"])
                    seg_end = seg_start + int(timerange["duration"])
                except (KeyError, TypeError, ValueError):
                    continue
                if not seg_start <= us < seg_end:
                    continue
                media, error = _material_path(project_dir, materials.get(segment.get("material_id")))
                if error or not media or media.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    continue
                requested = round(source_time(segment, float(timeline_time)), 6)
                requests.setdefault(media, [])
                if requested not in requests[media]:
                    requests[media].append(requested)
    return requests


def _decode_batch(path, requests, output_size, timeline_fps):
    """Decode requested source frames through one ffmpeg process and no frame files."""
    if not requests:
        return {}
    ordered = sorted({float(value) for value in requests})
    info = _probe_video_info(path)
    source_size = _source_preview_dimensions(info, output_size)
    if source_size is None:
        return {}
    source_fps = info.get("fps") or timeline_fps or 30
    try:
        period = 1.0 / float(source_fps)
    except (TypeError, ValueError, ZeroDivisionError):
        period = _DEFAULT_FRAME_PERIOD
    period = max(period, 1e-4)
    # The windows are half-open and narrower than one source frame. For ordinary CFR media
    # that yields exactly one output per requested timestamp while still tolerating a request
    # between two source frames. If a VFR source violates that contract, the caller falls back
    # to the accurate single-frame path rather than silently shifting all later requests.
    seek_start = max(0.0, ordered[0] - _SEEK_PREROLL)
    windows = []
    half = period * 0.49
    for requested in ordered:
        lo = max(0.0, requested - seek_start - half)
        hi = requested - seek_start + half
        windows.append(f"between(t\\,{lo:.9f}\\,{hi:.9f})")
    selector = "+".join(windows)
    vf = f"select='{selector}',scale={source_size[0]}:{source_size[1]}:flags=fast_bilinear"
    decode_options = _preview_decode_options()
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", *decode_options,
        "-ss", f"{seek_start:.9f}", "-i", path, "-t",
        f"{ordered[-1] - seek_start + half + period:.9f}",
        "-vf", vf, "-an", "-sn", "-fps_mode", "vfr", "-f", "rawvideo",
        "-pix_fmt", "rgb24", "-",
    ]
    process = _start_process(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_bytes = source_size[0] * source_size[1] * 3
    images = []
    try:
        while True:
            _check_preview_cancelled()
            data = process.stdout.read(frame_bytes)
            if not data:
                break
            while len(data) < frame_bytes:
                rest = process.stdout.read(frame_bytes - len(data))
                if not rest:
                    break
                data += rest
            if len(data) != frame_bytes:
                break
            images.append(Image.frombytes("RGB", source_size, data).convert("RGBA"))
        return_code = process.wait()
    finally:
        if process.stdout is not None:
            process.stdout.close()
        if _ACTIVE_PREVIEW is not None:
            _ACTIVE_PREVIEW.discard(process)
    _check_preview_cancelled()
    if return_code != 0 or len(images) != len(ordered):
        if decode_options:
            # VideoToolbox can legally drop a frame at a seek boundary on some HEVC
            # builds. Retry the same bounded window in software rather than falling all
            # the way back to one ffmpeg process per sample.
            global _PREVIEW_HWACCEL
            _PREVIEW_HWACCEL = []
            return _decode_batch(path, requests, output_size, timeline_fps)
        return {}
    return {
        (path, round(requested, 6)): FrameSample(
            image=image,
            requested_pts=requested,
            delivered_pts=requested,
            frame_period=period,
            method="preview-batch",
        )
        for requested, image in zip(ordered, images, strict=True)
    }


class _PreviewFrameProvider:
    """Serve low-resolution batch frames to the compositor, with an accurate fallback."""

    def __init__(self, project_dir, tl, times, output_size):
        self.project_dir = project_dir
        self.tl = tl
        self.output_size = output_size
        self.frames = {}
        self.source_sizes = {}
        self.batch_paths = set()
        for path, requests in _preview_requests(project_dir, tl, times).items():
            info = _probe_video_info(path)
            self.source_sizes[path] = _source_preview_dimensions(info, output_size)
            decoded = _decode_batch(path, requests, output_size, tl.get("fps"))
            if decoded:
                self.frames.update(decoded)
                self.batch_paths.add(path)

    def __call__(self, path, timeline_time):
        key = (path, round(float(timeline_time), 6))
        sample = self.frames.get(key)
        if sample is not None:
            return _copy_sample(sample)
        size = self.source_sizes.get(path)
        return grab(path, timeline_time, return_info=True, fps=self.tl.get("fps"), size=size)


def _render_simple_aroll_frame(t, segments, provider, output_size):
    """Render an identity A-roll sample without rescanning the whole timeline."""
    row = next((item for item in segments
                if item["timeline_start"] <= t < item["timeline_end"]), None)
    if row is None:
        raise FrameExtractionError(f"render t={float(t):g}s: no A-roll segment covers the sample")
    sample = provider(row["path"], source_time(row["segment"], t))
    image = sample.image if isinstance(sample, FrameSample) else sample
    report = [(row["path"], sample)] if isinstance(sample, FrameSample) else []
    width, height = output_size
    clip = row["segment"].get("clip") or {}
    if image.size == output_size:
        canvas = image.copy().convert("RGBA")
        rect = (0, 0, width, height)
    else:
        canvas = Image.new("RGBA", output_size, (0, 0, 0, 255))
        rect = place(canvas, image, clip, width, height)
    segment_id = str(row["segment"].get("id") or "<unnamed>")[:8]
    label = os.path.basename(row["path"])[:34]
    return canvas, [(row["track_index"], segment_id, label, rect)], report, width, height


def _run_progress_encoder(command, total_frames, fps, started, callback):
    """Run a filter-graph encoder while translating ffmpeg progress into preview progress."""
    process = _start_process(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    last = 0
    heartbeat = time.monotonic()
    try:
        while True:
            _check_preview_cancelled()
            ready = []
            if process.stderr is not None:
                try:
                    ready, _writeable, _exceptional = select.select([process.stderr], [], [], 0.5)
                except (OSError, ValueError):
                    ready = [process.stderr]
            if ready:
                raw_line = process.stderr.readline()
                if raw_line:
                    line = raw_line.decode(errors="replace") if isinstance(raw_line, bytes) else raw_line
                    if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                        try:
                            value = float(line.split("=", 1)[1])
                            seconds = value / (1e6 if line.startswith("out_time_us=") else 1e3)
                            completed = min(total_frames, max(last, math.floor(seconds * float(fps) + 1e-6)))
                            if completed > last:
                                last = completed
                                _emit_preview_progress(callback, completed, total_frames, started)
                        except (TypeError, ValueError):
                            pass
            now = time.monotonic()
            if now - heartbeat >= 1.0 and process.poll() is None:
                _emit_preview_progress(callback, last, total_frames, started)
                heartbeat = now
            if process.poll() is not None:
                break
        if process.stderr is not None:
            for raw_line in process.stderr:
                line = raw_line.decode(errors="replace") if isinstance(raw_line, bytes) else raw_line
                if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                    try:
                        value = float(line.split("=", 1)[1])
                        seconds = value / (1e6 if line.startswith("out_time_us=") else 1e3)
                        completed = min(total_frames, max(last, math.floor(seconds * float(fps) + 1e-6)))
                        if completed > last:
                            last = completed
                            _emit_preview_progress(callback, completed, total_frames, started)
                    except (TypeError, ValueError):
                        pass
        if process.stderr is not None:
            process.stderr.close()
        return_code = process.wait()
    finally:
        if _ACTIVE_PREVIEW is not None:
            _ACTIVE_PREVIEW.discard(process)
    _check_preview_cancelled()
    if return_code != 0:
        raise subprocess.CalledProcessError(return_code, command)
    _emit_preview_progress(callback, total_frames, total_frames, started)


def _write_simple_preview(project_dir, tl, segments, output, fps, duration, output_size,
                          total_frames, started, callback):
    """Encode a plain A-roll from one filter graph, including its original speech audio."""
    infos = {row["path"]: _probe_video_info(row["path"]) for row in segments}
    filters = []
    video_labels = []
    audio_labels = []
    for index, row in enumerate(segments):
        source_duration = max(0.001, row["source_duration"])
        speed = max(1e-6, row["speed"])
        video_label = f"v{index}"
        video_filter = (
            f"[{index}:v]trim=duration={source_duration:.9f},"
            f"setpts=PTS-STARTPTS/{speed:.9f}[{video_label}]"
        )
        filters.append(video_filter)
        video_labels.append(f"[{video_label}]")
        audio_label = f"a{index}"
        if (infos.get(row["path"]) or {}).get("audio", True):
            audio_filter = (
                f"[{index}:a]atrim=duration={source_duration:.9f},"
                f"asetpts=PTS-STARTPTS"
            )
            tempo = atempo_chain(speed)
            if tempo:
                audio_filter += f",{tempo}"
            volume = row["segment"].get("volume")
            if volume is not None:
                audio_filter += f",volume={float(volume):.6f}"
            audio_filter += f"[{audio_label}]"
        else:
            audio_filter = (
                f"anullsrc=r=44100:cl=stereo,atrim=duration={row['target_duration']:.9f},"
                f"asetpts=PTS-STARTPTS[{audio_label}]"
            )
        filters.append(audio_filter)
        audio_labels.append(f"[{audio_label}]")
    count = len(segments)
    filters.append("".join(video_labels) + f"concat=n={count}:v=1:a=0[vcat]")
    filters.append("".join(audio_labels) + f"concat=n={count}:v=0:a=1[acat]")
    filters.append(
        f"[vcat]fps={float(fps):.9f},scale={output_size[0]}:{output_size[1]}:"
        f"force_original_aspect_ratio=decrease,pad={output_size[0]}:{output_size[1]}:"
        f"(ow-iw)/2:(oh-ih)/2:color=black,trim=end_frame={total_frames}[vout]"
    )
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    # Open one bounded input per edit. A single full-source input makes every atrim branch
    # wait while ffmpeg decodes the entire 225s take, even though the EDL keeps only 67.8s.
    for row in segments:
        command += ["-ss", f"{max(0.0, row['source_start']):.9f}",
                    "-t", f"{max(0.001, row['source_duration']):.9f}", "-i", row["path"]]
    command += [
        "-filter_complex", ";".join(filters), "-map", "[vout]", "-map", "[acat]",
        "-t", f"{duration:.9f}", "-r", f"{float(fps):.9f}", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-crf", "23", "-c:a", "aac", "-ar", "44100",
        "-movflags", "+faststart", "-progress", "pipe:2", "-stats_period", "0.5", output,
    ]
    return _run_progress_encoder(command, total_frames, fps, started, callback)


def _encode_compositor_stream(project_dir, tl, times, output, fps, z, output_size, provider,
                              allow_missing, no_grade, audio, duration, started, callback):
    """Render compositor frames into one long-lived ffmpeg rawvideo encoder."""
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{output_size[0]}x{output_size[1]}",
        "-framerate", f"{float(fps):.9f}", "-i", "-",
    ]
    if audio:
        command += ["-i", audio, "-map", "0:v:0", "-map", "1:a:0"]
    else:
        command += ["-map", "0:v:0"]
    command += [
        "-t", f"{duration:.9f}", "-r", f"{float(fps):.9f}", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-crf", "23",
    ]
    if audio:
        command += ["-c:a", "aac", "-shortest"]
    command += ["-movflags", "+faststart", output]
    process = _start_process(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             stderr=subprocess.PIPE)
    rendered_at_low_resolution = provider is not None and bool(provider.batch_paths)
    try:
        for index, timeline_time in enumerate(times, start=1):
            _check_preview_cancelled()
            kwargs = {}
            if allow_missing:
                kwargs["allow_missing"] = True
            if no_grade:
                kwargs["no_grade"] = True
            if rendered_at_low_resolution:
                kwargs.update({"output_size": output_size, "frame_provider": provider})
            image, _rows, _width, _height = render(project_dir, tl, timeline_time, z, **kwargs)
            if image.size != output_size:
                image = image.resize(output_size, Image.LANCZOS)
            process.stdin.write(image.convert("RGB").tobytes())
            _emit_preview_progress(callback, index, len(times), started)
        process.stdin.close()
        stderr = process.stderr.read() if process.stderr is not None else b""
        if process.stderr is not None:
            process.stderr.close()
        return_code = process.wait()
    except BaseException:
        _terminate_process(process)
        raise
    finally:
        if _ACTIVE_PREVIEW is not None:
            _ACTIVE_PREVIEW.discard(process)
    _check_preview_cancelled()
    if return_code != 0:
        detail = stderr.decode(errors="replace") if isinstance(stderr, bytes) else str(stderr or "")
        raise subprocess.CalledProcessError(return_code, command, stderr=detail)


def write_preview(proj, tl, out_path, fps=6, z="track", start=None, end=None,
                  allow_missing=False, resolution=None, native=False, cache=True,
                  no_grade=False, progress=None, announce=True):
    """Write a bounded preview without materialising full-resolution frame files."""
    try:
        estimate = preview_estimate(
            proj, tl, fps=fps, start=start, end=end, resolution=resolution, native=native,
            z=z, no_grade=no_grade, allow_missing=allow_missing,
        )
    except (TypeError, ValueError) as exc:
        raise FrameExtractionError(str(exc)) from exc
    render_start = estimate["range"]["start"]
    render_end = estimate["range"]["end"]
    duration_s = estimate["range"]["duration"]
    total_frames = estimate["frames"]
    if total_frames <= 0:
        raise FrameExtractionError("preview: rendered range is empty")
    output_size = (estimate["resolution"]["width"], estimate["resolution"]["height"])
    mode = estimate["mode"]
    if announce:
        print(format_preview_estimate(estimate), end="")
    materials = _material_index(tl)
    issues = _missing_media(proj, tl, materials, render_start, render_end)
    if issues and not allow_missing:
        raise _missing_media_error(
            f"preview {render_start:g}-{render_end:g}s", issues)
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    cache_enabled = bool(cache and not allow_missing)
    key = preview_cache_key(
        proj, tl, render_start, render_end, fps, resolution, native=native, z=z,
        no_grade=no_grade, allow_missing=allow_missing, mode=mode,
    )
    cached = preview_cache_path(proj, key)
    if cache_enabled and os.path.isfile(cached) and os.path.getsize(cached) > 0:
        _atomic_copy(cached, out_path)
        print(f"preview cache hit: {cached}")
        return out_path

    times = [round(render_start + offset, 6) for offset in preview_times(duration_s, fps)]
    started = time.monotonic()
    tmp = tempfile.mkdtemp(prefix="capcutctl-preview-")
    encoded = os.path.join(tmp, "preview.mp4")
    try:
        with _PreviewRuntime():
            _emit_preview_progress(progress, 0, total_frames, started)
            if mode == "a-roll-concat":
                segments = simple_aroll_segments(proj, tl, render_start, render_end)
                _write_simple_preview(
                    proj, tl, segments, encoded, fps, duration_s, output_size,
                    total_frames, started, progress,
                )
            else:
                provider = None if native else _PreviewFrameProvider(proj, tl, times, output_size)
                audio = _timeline_audio(proj, tl, tmp, duration_s, render_start)
                _encode_compositor_stream(
                    proj, tl, times, encoded, fps, z, output_size, provider,
                    allow_missing, no_grade, audio, duration_s, started, progress,
                )
            if not os.path.isfile(encoded) or os.path.getsize(encoded) <= 0:
                raise FrameExtractionError("preview encoder produced no output")
            if cache_enabled:
                try:
                    os.makedirs(os.path.dirname(cached), exist_ok=True)
                    _atomic_copy(encoded, cached)
                except OSError as exc:
                    print(f"note: preview cache unavailable: {exc}", file=sys.stderr)
            _atomic_copy(encoded, out_path)
    except PreviewCancelled:
        raise
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
            _run_command(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            slices.append((overlap_start - range_start, wav))
        except subprocess.CalledProcessError:
            continue
    if not slices:
        return None
    # Mix onto a silent bed so gaps stay gaps.
    bed = os.path.join(tmp, "bed.wav")
    _run_command(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
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
    _run_command(["ffmpeg", "-y", "-loglevel", "error", *inputs,
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
