#!/usr/bin/env python3
"""X-ray: a queryable evidence index over a real export.

Every frame and every audio sample of the export is measured by cheap detectors; only what
they flag, plus an overview and a few blind spot-checks, is put in front of a model's eyes.
The export is the truth (what appeared). The draft is what was configured. Neither proves
intent, so properties this tool cannot see are reported as NOT CHECKED, never as clean.

  xray scan VIDEO [--project NAME] [--out DIR] [--json]
  xray frame VIDEO (--frame N | --t SECONDS) [--crop X,Y,W,H] [--out PNG]
  xray window VIDEO (--frames A-B | --from S --to S) [--crop X,Y,W,H] [--out PNG]
  xray audio VIDEO --from S --to S
  xray selftest

Times are seconds from the first presented frame. Every frame is addressed by its index in
presentation order, and every extraction is checked against the integer PTS in the ledger:
a frame that does not match exactly is an error, never "close enough".

Exit codes for scan: 0 no FAIL verdict, 1 at least one FAIL, 2 the tool could not run.
"""
import argparse
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
from itertools import pairwise
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

LEDGER_VERSION = 1
SCAN_VERSION = 1
SCAN_WIDTH = 270
QUEUE_SHOWN = 20
TILE = 30

# Detector thresholds, in mean absolute difference on a 0..1 luma scale.
POLICY = {
    "black_p99": 0.07,            # a frame whose 99th-percentile luma is below this is black
    "white_p01": 0.93,            # a frame whose 1st-percentile luma is above this is white
    "outlier_tile": 0.08,         # a tile must change at least this much into and out of a frame
    "outlier_return": 0.35,       # ...and its neighbours must agree within this fraction of that change
    "cut_frac": 0.5,              # share of tiles that change for a cut
    "cut_jump": 0.06,             # global change for a cut, above the local median
    "static_d1": 0.004,           # below this the picture is not moving
    "dup_d1": 0.0015,             # below this a frame repeats the previous one
    "dup_motion": 0.005,          # ...while its neighbours move at least this much
    "dup_ratio": 10.0,            # ...and at least this many times more than the repeat
    "loudness_lufs": (-16.0, -12.0),
    "true_peak_dbtp": -1.0,
    "clip_level": 0.999,
    "clip_run": 3,
    "silence_dbfs": -55.0,
    "silence_min_s": 0.30,
    "mono_fail_db": -6.0,
    "overview_gap_s": 1.0,
    "blind_windows": 4,
}

NOT_CHECKED = [
    ("layout.logos", "logo and brand-mark tracking is not built; text, numbers and faces are"),
    ("intent.claims", "phase 4: narrative beats and screen evidence are not built yet"),
    ("sync.lip", "no lip-sync estimator yet"),
    ("video.undeclared_motion", "needs a draft renderer comparison with declared support; not built yet"),
]


class XrayError(SystemExit):
    def __init__(self, message):
        super().__init__(2)
        self.message = message


def fail(message):
    raise XrayError(message)


def need(binary):
    if not shutil.which(binary):
        fail(f"{binary} is not on PATH; install ffmpeg (brew install ffmpeg)")


# ---------------------------------------------------------------- identity and ledger

def file_identity(path, full_hash=True):
    st = os.stat(path)
    ident = {"path": os.path.abspath(path), "bytes": st.st_size, "mtime_ns": st.st_mtime_ns}
    if full_hash:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        ident["sha256"] = h.hexdigest()
    return ident


def probe_streams(video):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", video],
        capture_output=True, text=True)
    if out.returncode:
        fail(f"ffprobe could not read {video}: {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout)
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if v is None:
        fail(f"{video} has no video stream")
    keep = ("codec_name", "width", "height", "time_base", "r_frame_rate", "avg_frame_rate",
            "start_pts", "start_time", "duration", "nb_frames", "pix_fmt", "color_range",
            "color_space", "color_transfer", "color_primaries")
    info = {"video": {k: v.get(k) for k in keep if v.get(k) is not None}}
    if a is not None:
        info["audio"] = {k: a.get(k) for k in ("codec_name", "sample_rate", "channels",
                                               "channel_layout", "time_base", "start_pts",
                                               "start_time", "duration") if a.get(k) is not None}
    info["format"] = {k: data.get("format", {}).get(k) for k in ("format_name", "duration", "bit_rate")}
    return info


def _ratio(text):
    num, _, den = str(text).partition("/")
    return int(num) / int(den or 1)


def build_ledger(video, info=None):
    """Integer PTS of every frame, in presentation order, from a full decode."""
    info = info or probe_streams(video)
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "frame=pts,best_effort_timestamp,key_frame,pict_type", "-of", "json", video],
        capture_output=True, text=True)
    if out.returncode:
        fail(f"ffprobe could not decode {video}: {out.stderr.strip()[-300:]}")
    pts, keys, types = [], [], []
    for fields in json.loads(out.stdout).get("frames", []):
        raw = fields.get("pts", fields.get("best_effort_timestamp"))
        if raw is None:
            fail(f"frame {len(pts)} of {video} has no timestamp")
        pts.append(int(raw))
        keys.append(int(fields.get("key_frame", 0)) == 1)
        types.append(str(fields.get("pict_type", "?")))
    return _ledger_from(info, pts, keys, types)


def _ledger_from(info, pts, keys=None, types=None):
    if not pts:
        fail("the video decoded to zero frames")
    tb = _ratio(info["video"]["time_base"])
    if any(b <= a for a, b in pairwise(pts)):
        bad = next(i for i, (a, b) in enumerate(pairwise(pts), 1) if b <= a)
        fail(f"presentation timestamps are not strictly increasing at frame {bad}")
    steps = np.diff(np.array(pts, dtype=np.int64)) if len(pts) > 1 else np.array([0])
    return {
        "version": LEDGER_VERSION,
        "time_base": info["video"]["time_base"],
        "pts": pts,
        "key": [i for i, k in enumerate(keys or []) if k],
        "types": "".join(t[:1] for t in (types or [])),
        "pts0": pts[0],
        "frames": len(pts),
        "frame_step_pts": {"min": int(steps.min()), "max": int(steps.max()),
                           "median": float(np.median(steps))},
        "constant_rate": bool(steps.max() - steps.min() <= 1),
        "duration_s": (pts[-1] - pts[0]) * tb + float(np.median(steps)) * tb,
        "_tb": tb,
    }


def t_of(ledger, n):
    return (ledger["pts"][n] - ledger["pts0"]) * ledger["_tb"]


def frame_at(ledger, t):
    """Index of the frame presented at time t (seconds from the first frame)."""
    target = ledger["pts0"] + t / ledger["_tb"]
    pts = ledger["pts"]
    lo, hi = 0, len(pts) - 1
    if target < pts[0] - 1e-9:
        fail(f"t={t:.3f}s is before the first frame")
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if pts[mid] <= target + 1e-6:
            lo = mid
        else:
            hi = mid - 1
    return lo


def default_dir(video):
    p = Path(video)
    return p.with_name(p.stem + ".xray")


def load_or_build_ledger(video, xray_dir=None):
    xray_dir = Path(xray_dir or default_dir(video))
    cache = xray_dir / "ledger.json"
    ident = file_identity(video, full_hash=False)
    if cache.exists():
        try:
            data = json.loads(cache.read_text())
            src = data.get("source", {})
            if (data.get("version") == LEDGER_VERSION and src.get("bytes") == ident["bytes"]
                    and src.get("mtime_ns") == ident["mtime_ns"]):
                data["_tb"] = _ratio(data["time_base"])
                return data, data.get("info")
        except (OSError, ValueError, KeyError):
            pass
    info = probe_streams(video)
    ledger = build_ledger(video, info)
    _save_ledger(xray_dir, ledger, info, ident)
    return ledger, info


def _save_ledger(xray_dir, ledger, info, ident):
    xray_dir.mkdir(parents=True, exist_ok=True)
    data = {k: v for k, v in ledger.items() if not k.startswith("_")}
    data["source"] = ident
    data["info"] = info
    _atomic_write(xray_dir / "ledger.json", json.dumps(data))


def _atomic_write(path, text):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# ---------------------------------------------------------------- exact extraction

_SHOWINFO = re.compile(r"\bn:\s*(\d+)\s+pts:\s*(-?\d+)")


def _parse_showinfo(stderr):
    return [int(m.group(2)) for m in _SHOWINFO.finditer(stderr)]


def extract(video, ledger, frames, out_dir, crop=None, width=None, force_decode=False, ext="png"):
    """Write exactly these frames as PNGs; every one is verified by its integer PTS.

    Tries a seek first (cheap), then falls back to a full decode selected by index.
    Returns [(frame_index, path)] in ascending order.
    """
    frames = sorted({int(n) for n in frames})
    if not frames:
        return []
    if frames[0] < 0 or frames[-1] >= ledger["frames"]:
        fail(f"frame out of range 0..{ledger['frames'] - 1}")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    want = [ledger["pts"][n] for n in frames]
    post = []
    if crop:
        x, y, w, h = crop
        post.append(f"crop={w}:{h}:{x}:{y}")
    if width:
        post.append(f"scale={int(width)}:-2:flags=lanczos")
    attempts = []
    span = t_of(ledger, frames[-1]) - t_of(ledger, frames[0])
    if span < 20 and not force_decode:
        start = max(0.0, t_of(ledger, frames[0]) + ledger["pts0"] * ledger["_tb"] - 3.0)
        sel = "+".join(f"eq(pts\\,{p})" for p in want)
        attempts.append(("seek", ["-copyts", "-ss", f"{start:.6f}"], sel))
    sel_n = "+".join(f"eq(n\\,{n})" for n in frames)
    attempts.append(("decode", ["-copyts"], sel_n))
    last = ""
    for method, pre, sel in attempts:
        for old in out_dir.glob(f"x_*.{ext}"):
            old.unlink()
        vf = ",".join([f"select='{sel}'", "showinfo", *post])
        cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", *pre, "-i", str(video), "-map", "0:v:0",
               "-vf", vf, "-fps_mode", "passthrough", "-frames:v", str(len(frames)),
               *(["-q:v", "2"] if ext == "jpg" else []), str(out_dir / f"x_%06d.{ext}")]
        r = subprocess.run(cmd, capture_output=True, text=True)
        got = _parse_showinfo(r.stderr)
        if r.returncode == 0 and got == want:
            files = sorted(out_dir.glob(f"x_*.{ext}"))
            if len(files) == len(frames):
                result = []
                for n, f in zip(frames, files, strict=True):
                    dest = out_dir / f"f{n:06d}.{ext}"
                    os.replace(f, dest)
                    result.append((n, dest))
                return result
        last = f"{method}: wanted pts {want[:4]}… got {got[:4]}… rc={r.returncode} {r.stderr.strip()[-200:]}"
    fail(f"could not extract the exact frames {frames[:6]}: {last}")


# ---------------------------------------------------------------- full-stream video scan

def _drain(stream, sink):
    for line in iter(stream.readline, b""):
        sink.append(line.decode("utf-8", "replace"))


def scan_video(video, ledger, info):
    w, h = int(info["video"]["width"]), int(info["video"]["height"])
    sw = min(SCAN_WIDTH, w - w % 2)
    sh = max(2, round(h * sw / w / 2) * 2)
    tx, ty = max(1, sw // TILE), max(1, sh // TILE)
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-copyts", "-i", str(video), "-map", "0:v:0",
           "-vf", f"showinfo,scale={sw}:{sh}:flags=area,format=gray",
           "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    errs = []
    drainer = threading.Thread(target=_drain, args=(proc.stderr, errs), daemon=True)
    drainer.start()
    size = sw * sh
    cols = {k: [] for k in ("mean", "p01", "p99", "d1", "frac", "tile_max", "lap", "top", "bottom")}
    td1, td2, td3 = [], [], []
    hist = []
    band = max(1, sh // 33)
    while True:
        buf = proc.stdout.read(size)
        if not buf:
            break
        if len(buf) < size:
            break
        f = np.frombuffer(buf, np.uint8).reshape(sh, sw).astype(np.float32) / 255.0
        sub = f[::2, ::2].ravel()
        lo, hi = np.percentile(sub, [1, 99])
        cols["mean"].append(float(f.mean()))
        cols["p01"].append(float(lo))
        cols["p99"].append(float(hi))
        cols["top"].append(float(f[:band].max()))
        cols["bottom"].append(float(f[-band:].max()))
        lap = 4 * f[1:-1, 1:-1] - f[:-2, 1:-1] - f[2:, 1:-1] - f[1:-1, :-2] - f[1:-1, 2:]
        cols["lap"].append(float(lap.var()))
        core = f[:ty * TILE, :tx * TILE]

        def tiles(other, core=core):
            return np.abs(core - other).reshape(ty, TILE, tx, TILE).mean(axis=(1, 3)).astype(np.float32)

        if hist:
            t1 = tiles(hist[-1])
            cols["d1"].append(float(t1.mean()))
            cols["frac"].append(float((t1 > 0.10).mean()))
            cols["tile_max"].append(float(t1.max()))
        else:
            t1 = np.zeros((ty, tx), np.float32)
            cols["d1"].append(0.0)
            cols["frac"].append(0.0)
            cols["tile_max"].append(0.0)
        td1.append(t1)
        td2.append(tiles(hist[-2]) if len(hist) >= 2 else np.zeros((ty, tx), np.float32))
        td3.append(tiles(hist[-3]) if len(hist) >= 3 else np.zeros((ty, tx), np.float32))
        hist.append(core.copy())
        if len(hist) > 3:
            hist.pop(0)
    proc.stdout.close()
    rc = proc.wait()
    drainer.join(timeout=5)
    stderr = "".join(errs)
    if rc:
        fail(f"ffmpeg failed while scanning {video}: {stderr.strip()[-300:]}")
    got = _parse_showinfo(stderr)
    n = len(cols["mean"])
    if n != ledger["frames"] or got != ledger["pts"]:
        fail(f"scan decoded {n} frames but the ledger has {ledger['frames']}; "
             "the decode and the ledger disagree, so no frame index can be trusted")
    return {
        "scan_size": [sw, sh], "tiles": [tx, ty], "tile_px": TILE,
        "cols": {k: np.array(v, np.float32) for k, v in cols.items()},
        "td1": np.stack(td1), "td2": np.stack(td2), "td3": np.stack(td3),
    }


def _dilate(m):
    out = m.copy()
    out[1:] |= m[:-1]
    out[:-1] |= m[1:]
    out[:, 1:] |= out[:, :-1].copy()
    out[:, :-1] |= out[:, 1:].copy()
    return out


def _is_dip(mean, a, b, rising=False, k=3):
    """True when the picture fades into the blank frames and back out: a transition."""
    if a - k < 0 or b + k >= len(mean):
        return False
    pre, post = mean[a - k:a], mean[b + 1:b + 1 + k]
    if rising:
        return bool(np.all(np.diff(pre) > 0) and np.all(np.diff(post) < 0))
    return bool(np.all(np.diff(pre) < 0) and np.all(np.diff(post) > 0))


def _runs(mask):
    runs, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        elif not m and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(mask) - 1))
    return runs


def detect_video(scan, ledger):
    c = scan["cols"]
    td1, td2, td3 = scan["td1"], scan["td2"], scan["td3"]
    n = len(c["mean"])
    P = POLICY
    findings = []
    black = c["p99"] < P["black_p99"]
    white = c["p01"] > P["white_p01"]
    blanked = set()
    for kind, mask in (("black", black), ("white", white)):
        for a, b in _runs(mask):
            blanked.update(range(a, b + 1))
            findings.append({"kind": f"{kind}_frames", "frames": [a, b], "count": b - a + 1})

    # Frames that differ from both neighbours while the neighbours agree: flashes and glitches.
    T, R = P["outlier_tile"], P["outlier_return"]
    outliers = []
    for i in range(1, n - 1):
        into, out_, across = td1[i], td1[i + 1], td2[i + 1]
        m = (np.minimum(into, out_) > T) & (across < R * np.minimum(into, out_))
        if m.any():
            outliers.append((i, i, m))
    for i in range(1, n - 2):
        into, mid, out_, across = td1[i], td1[i + 1], td1[i + 2], td3[i + 2]
        lo = np.minimum(into, out_)
        m = (lo > T) & (across < R * lo) & (mid < 0.5 * lo)
        if m.any():
            outliers.append((i, i + 1, m))
    seen = set()
    moving = 0
    for a, b, m in sorted(outliers, key=lambda o: (o[0], -(o[1] - o[0]))):
        frames = set(range(a, b + 1))
        if frames & seen or frames <= blanked:
            continue
        # An object travelling through the frame also changes a tile for a frame or two, but
        # the tiles around it are busy just before or just after. A glitch arrives from nowhere.
        hood = _dilate(_dilate(m))
        size = float(np.minimum(td1[a], td1[b + 1])[m].max())
        before = td1[a - 1][hood].max() if a - 1 >= 1 else 0.0
        after = td1[b + 2][hood].max() if b + 2 < n else 0.0
        ys, xs = np.nonzero(m)
        at_edge = m.sum() == 1 and (ys[0] in (0, m.shape[0] - 1) or xs[0] in (0, m.shape[1] - 1))
        if max(before, after) > 0.3 * size or at_edge:
            moving += 1
            continue
        seen |= frames
        # If the frames either side of the event differ from each other across the picture,
        # the event sits on a change of shot: a one-frame state at a cut, not corruption.
        across = td2[b + 1] if b == a else td3[b + 1]
        at_cut = float((across > 0.10).mean()) > 0.3
        findings.append({"kind": "glitch", "frames": [a, b], "count": b - a + 1, "at_cut": at_cut,
                         "tiles": int(m.sum()), "tile_share": round(float(m.mean()), 3),
                         "box_scan": [int(xs.min()) * TILE, int(ys.min()) * TILE,
                                      int(xs.max() + 1) * TILE, int(ys.max() + 1) * TILE]})

    # Repeated frames while the picture is otherwise moving: a stutter.
    d1 = c["d1"]
    for i in range(2, n - 1):
        if i in blanked or (i - 1) in blanked:
            continue
        floor = max(P["dup_motion"], P["dup_ratio"] * float(d1[i]))
        if d1[i] < P["dup_d1"] and d1[i - 1] > floor and d1[i + 1] > floor:
            findings.append({"kind": "duplicate_in_motion", "frames": [i, i], "count": 1})

    # Cuts: most tiles change at once, well above the local level of motion.
    cuts = []
    outlier_frames = blanked | seen
    for i in range(1, n):
        if i in outlier_frames or (i - 1) in outlier_frames:
            continue
        local = np.concatenate([d1[max(1, i - 6):i], d1[i + 1:i + 7]])
        base = float(np.median(local)) if local.size else 0.0
        if c["frac"][i] > P["cut_frac"] and d1[i] > base + P["cut_jump"]:
            cuts.append(i)
    # Several "cuts" a frame or two apart are one transition (a flash, a whip, a blur).
    spans = []
    for i in cuts:
        if spans and i - spans[-1][1] <= 3:
            spans[-1][1] = i
        else:
            spans.append([i, i])
    cuts = [a for a, _ in spans]
    transitions = [sp for sp in spans if sp[1] > sp[0]]

    for f in findings:
        a, b = f["frames"]
        f["near_cut"] = any(sa - 3 <= b and a <= sb + 3 for sa, sb in spans) or f.get("at_cut", False)
        if f["kind"] in ("black_frames", "white_frames"):
            f["dip"] = _is_dip(c["mean"], a, b, rising=f["kind"] == "white_frames")
    static = [(a, b) for a, b in _runs(d1 < P["static_d1"]) if b - a >= 1]
    longest_static = max(static, key=lambda r: r[1] - r[0], default=None)
    rows_dark = (c["top"] < 0.05).mean() > 0.95 and (c["bottom"] < 0.05).mean() > 0.95
    return {"findings": findings, "cuts": cuts, "transitions": transitions, "static": static,
            "moving_object_outliers": moving,
            "longest_static": longest_static, "letterbox": bool(rows_dark)}


# ---------------------------------------------------------------- audio

def decode_audio(video, rate=48000):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", str(video),
                        "-map", "0:a:0", "-ac", "2", "-ar", str(rate), "-f", "f32le", "-"],
                       capture_output=True)
    if r.returncode:
        fail(f"ffmpeg could not decode the audio: {r.stderr.decode()[-300:]}")
    return np.frombuffer(r.stdout, np.float32).reshape(-1, 2), rate


_EBU_LINE = re.compile(r"t:\s*([\d.]+)\s+TARGET.*?M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)")


def loudness(video):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-i", str(video), "-map", "0:a:0",
                        "-af", "ebur128=peak=true:framelog=info", "-f", "null", "-"],
                       capture_output=True, text=True)
    if r.returncode:
        fail(f"ffmpeg ebur128 failed: {r.stderr.strip()[-300:]}")
    text = r.stderr
    summary = text[text.rfind("Summary:"):]
    def grab(pattern):
        m = re.search(pattern, summary, re.S)
        return float(m.group(1)) if m and m.group(1) not in ("-inf", "inf") else None
    series = [(float(t), _num(m), _num(s)) for t, m, s in _EBU_LINE.findall(text)]
    return {
        "integrated_lufs": grab(r"Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)"),
        "lra_lu": grab(r"Loudness range:\s*LRA:\s*(-?[\d.]+)"),
        "true_peak_dbtp": grab(r"True peak:\s*Peak:\s*(-?[\d.]+|-inf)"),
        "momentary": series,
    }


def _num(v):
    return None if v in ("-inf", "inf") else float(v)


def _db(x):
    return 20 * math.log10(x) if x > 0 else float("-inf")


def detect_audio(samples, rate, offset_s=0.0):
    P = POLICY
    out = {"findings": []}
    if samples.size == 0:
        return out
    mono = samples.mean(axis=1)
    peaks = np.abs(samples).max(axis=0)
    out["sample_peak_dbfs"] = [round(_db(float(p)), 2) for p in peaks]
    # clipping: runs of samples at full scale, per channel
    for ch in range(samples.shape[1]):
        hot = np.abs(samples[:, ch]) >= P["clip_level"]
        if hot.any():
            for a, b in _runs_np(hot):
                if b - a + 1 >= P["clip_run"]:
                    out["findings"].append({"kind": "clipping", "t": round(offset_s + a / rate, 4),
                                            "dur_ms": round((b - a + 1) / rate * 1000, 2), "channel": ch})
    # clicks: a sample that jumps off the local curve far beyond the local residual level
    res = np.zeros_like(mono)
    res[1:-1] = mono[1:-1] - 0.5 * (mono[:-2] + mono[2:])
    blk = rate // 100
    nb = len(res) // blk
    if nb >= 5:
        med = np.median(np.abs(res[:nb * blk]).reshape(nb, blk), axis=1)
        local = np.array([np.median(med[max(0, i - 3):i + 4]) for i in range(nb)])
        scale = np.repeat(local, blk)
        r = np.abs(res[:nb * blk])
        hit = (r > 0.08) & (r > 40 * np.maximum(scale, 1e-5))
        last = -1e9
        for i in np.nonzero(hit)[0]:
            t = i / rate
            if t - last > 0.01:
                out["findings"].append({"kind": "click", "t": round(offset_s + t, 4),
                                        "jump": round(float(r[i]), 3)})
            last = t
    # silence gaps
    if nb:
        rms = np.sqrt(np.mean(mono[:nb * blk].reshape(nb, blk) ** 2, axis=1) + 1e-20)
        quiet = 20 * np.log10(rms) < P["silence_dbfs"]
        for a, b in _runs_np(quiet):
            dur = (b - a + 1) / 100
            if dur >= P["silence_min_s"]:
                edge = "start" if a == 0 else ("end" if b == nb - 1 else "inside")
                out["findings"].append({"kind": "silence", "t": round(offset_s + a / 100, 2),
                                        "dur_s": round(dur, 2), "where": edge})
    e_st = float(np.mean(samples.astype(np.float64) ** 2))
    e_mono = float(np.mean(mono.astype(np.float64) ** 2))
    out["mono_ratio_db"] = round(10 * math.log10(e_mono / e_st), 2) if e_st > 0 else None
    return out


def _runs_np(mask):
    if not mask.any():
        return []
    m = np.concatenate([[False], mask, [False]]).astype(np.int8)
    d = np.diff(m)
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0] - 1, strict=True))


# ---------------------------------------------------------------- draft (authored)

def draft_events(project, export_duration):
    sys.path.insert(0, str(Path(__file__).parent))
    import frame_qa as fq  # optional: only --project needs the draft reader
    proj, tl, path = fq.load_project(project)
    start, end = fq.content_edit_range(proj, tl)
    materials = fq._typed_material_index(tl)
    events = []
    for ti, track in enumerate(tl.get("tracks") or []):
        ttype = track.get("type")
        for seg in track.get("segments") or []:
            tt = seg.get("target_timerange") or {}
            t0 = tt.get("start", 0) / 1e6 - start
            t1 = t0 + tt.get("duration", 0) / 1e6
            if t1 <= 0 or t0 >= end - start:
                continue
            kind, mat = materials.get(seg.get("material_id"), (None, {}))
            label = _material_label(kind, mat)
            ev = {"t0": round(t0, 4), "t1": round(t1, 4), "track": ti, "type": ttype, "label": label}
            tname = str(track.get("name") or "")
            if tname:
                ev["track_name"] = tname
            if ttype == "effect" or re.match(r"(mograph|motion|sting|graphic|scene)", tname.lower()) \
                    or re.search(r"(mograph|motion__|sting)", label.lower()):
                ev["graphic"] = True
            clip = seg.get("clip") or {}
            if ttype == "video":
                src0, src_d = fq.source_span(seg)
                tgt_d = tt.get("duration", 0) / 1e6
                if tgt_d > 0 and src_d > 0 and abs(src_d / tgt_d - 1) > 1e-3:
                    ev["speed"] = round(src_d / tgt_d, 3)
                sc = (clip.get("scale") or {}).get("x")
                if sc is not None and abs(sc - 1) > 1e-3:
                    ev["scale"] = round(sc, 3)
                for ref in seg.get("extra_material_refs") or []:
                    rk, rm = materials.get(ref, (None, {}))
                    if rk == "transitions":
                        ev["transition"] = {"name": rm.get("name"), "dur": round((rm.get("duration") or 0) / 1e6, 3)}
                    elif rk == "video_effects":
                        ev.setdefault("effects", []).append(rm.get("name"))
                    elif rk == "material_animations":
                        for an in rm.get("animations") or []:
                            ev.setdefault("animations", []).append(f"{an.get('type', '')}:{an.get('name')}")
                            a0 = t0 + (an.get("start") or 0) / 1e6
                            ev.setdefault("animation_windows", []).append(
                                [round(a0, 3), round(a0 + (an.get("duration") or 0) / 1e6, 3), an.get("name")])
                keys = []
                for block in seg.get("common_keyframes") or []:
                    pts = block.get("keyframe_list") or []
                    if not pts or tgt_d <= 0 or src_d <= 0:
                        continue
                    if len({tuple(k.get("values") or []) for k in pts}) == 1:
                        continue  # a key list that never changes value moves nothing
                    ks = [(t0 + (k["time_offset"] / 1e6 - src0) * tgt_d / src_d, k["values"][0]) for k in pts]
                    keys.append({"property": str(block.get("property_type", "")).replace("KFType", ""),
                                 "from": [round(ks[0][0], 3), round(ks[0][1], 3)],
                                 "to": [round(ks[-1][0], 3), round(ks[-1][1], 3)], "n": len(ks)})
                if keys:
                    ev["keyframes"] = keys
            if ttype == "audio" and seg.get("volume") not in (None, 1, 1.0):
                ev["volume_db"] = round(_db(float(seg["volume"])), 1) if seg["volume"] > 0 else "-inf"
            if ttype == "text":
                ev["text"] = _material_text(mat)
                pos = clip.get("transform") or {}
                ev["pos"] = [round(pos.get("x", 0), 3), round(pos.get("y", 0), 3)]
            events.append(ev)
    events.sort(key=lambda e: (e["t0"], e["track"]))
    draft_ident = file_identity(path)
    return {"project": proj, "draft_path": path, "draft": draft_ident,
            "content_range": [round(start, 4), round(end, 4)],
            "content_duration": round(end - start, 4),
            "duration_matches_export": abs((end - start) - export_duration) <= 0.05,
            "events": events}


def transition_windows(draft):
    """(start, end, name) around every declared transition, in export seconds."""
    out = []
    for e in draft["events"]:
        tr = e.get("transition")
        if tr:
            half = max(tr["dur"], 0.07)
            out.append((e["t1"] - half, e["t1"] + half, tr["name"]))
    return out


def declared_windows(draft):
    """Every stretch the draft says is meant to move oddly: transitions, effects, graphics, animations."""
    wins = [(a, b, f"transition {name}") for a, b, name in transition_windows(draft)]
    for e in draft["events"]:
        if e.get("graphic"):
            wins.append((e["t0"], e["t1"], f"graphic {e['label'][:40]}"))
        for name in e.get("effects") or []:
            wins.append((e["t0"], e["t1"], f"effect {name}"))
        for a, b, name in e.get("animation_windows") or []:
            if b > a:
                wins.append((a, b, f"animation {name}"))
    return wins


def annotate_declared(vid, draft, ledger):
    wins = declared_windows(draft)
    for f in vid["findings"]:
        a, b = f["frames"]
        ta, tb = t_of(ledger, a), t_of(ledger, b)
        for w0, w1, name in wins:
            if ta <= w1 + 0.07 and tb >= w0 - 0.07:
                f["declared"] = name
                break


def _material_text(mat):
    try:
        return (json.loads(mat.get("content") or "{}").get("text") or "").strip()
    except ValueError:
        return str(mat.get("content") or "").strip()


def _material_label(kind, mat):
    if kind == "texts":
        try:
            content = json.loads(mat.get("content") or "{}")
            text = content.get("text") or ""
        except ValueError:
            text = mat.get("content") or ""
        return f'text "{text.strip()[:60]}"'
    name = mat.get("material_name") or mat.get("name") or os.path.basename(str(mat.get("path") or "")) or kind or "?"
    return f"{(kind or '?').rstrip('s')} {name}"


# ---------------------------------------------------------------- sheets

def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def grid_sheet(items, out, cols=6, tile_w=180, label_h=40):
    """items: [(image_path, line1, line2)] -> one labelled grid; labels sit under the image."""
    ims = []
    for p, l1, l2 in items:
        im = Image.open(p).convert("RGB")
        h = max(1, round(im.height * tile_w / im.width))
        ims.append((im.resize((tile_w, h), Image.LANCZOS), l1, l2))
    rows = math.ceil(len(ims) / cols)
    cell_h = max(i.height for i, _, _ in ims) + label_h
    pad = 6
    sheet = Image.new("RGB", (cols * (tile_w + pad) + pad, rows * (cell_h + pad) + pad), (16, 16, 16))
    d = ImageDraw.Draw(sheet)
    f1, f2 = _font(14), _font(12)
    for k, (im, l1, l2) in enumerate(ims):
        x = pad + (k % cols) * (tile_w + pad)
        y = pad + (k // cols) * (cell_h + pad)
        sheet.paste(im, (x, y))
        d.text((x + 2, y + im.height + 4), l1, fill=(245, 245, 245), font=f1)
        d.text((x + 2, y + im.height + 22), l2, fill=(190, 190, 190), font=f2)
    sheet.save(out, optimize=False, compress_level=3)
    return out


def fmt_t(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


# ---------------------------------------------------------------- scan command

def cmd_scan(args):
    need("ffmpeg")
    need("ffprobe")
    video = args.video
    out = Path(args.out or default_dir(video))
    out.mkdir(parents=True, exist_ok=True)
    ident = file_identity(video)
    info = probe_streams(video)
    ledger = build_ledger(video, info)
    _save_ledger(out, ledger, info, {k: ident[k] for k in ("path", "bytes", "mtime_ns", "sha256")})
    scan = scan_video(video, ledger, info)
    vid = detect_video(scan, ledger)
    fps = 1 / (ledger["frame_step_pts"]["median"] * ledger["_tb"])
    sx = int(info["video"]["width"]) / scan["scan_size"][0]

    audio = {"present": "audio" in info}
    if audio["present"]:
        samples, rate = decode_audio(video)
        audio.update(detect_audio(samples, rate))
        audio["loudness"] = loudness(video)
        audio["samples"] = int(samples.shape[0])
        audio["rate"] = rate

    draft = None
    if args.project:
        draft = draft_events(args.project, ledger["duration_s"])
        if draft["draft"]["mtime_ns"] > ident["mtime_ns"]:
            draft["changed_after_export"] = True

    if draft:
        annotate_declared(vid, draft, ledger)
    text = text_pass(args, video, ledger, info, out, draft)
    verdicts = build_verdicts(vid, audio, draft, ledger, sx)
    verdicts[-len(NOT_CHECKED):-len(NOT_CHECKED)] = text["verdicts"]
    queue, overview = build_queue(vid, ledger, ident, audio, text)
    sheets = []
    if overview:
        tiles_dir = out / "tiles"
        if tiles_dir.exists():
            shutil.rmtree(tiles_dir)
        got = dict(extract(video, ledger, overview, tiles_dir, width=360))
        shots = _shot_of(vid["cuts"], ledger["frames"])
        per = 12
        for s in range(0, len(overview), per):
            chunk = overview[s:s + per]
            items = [(got[n], f"T{s + k + 1:02d}  f{n:05d}", f"{fmt_t(t_of(ledger, n))}  shot {shots[n] + 1}")
                     for k, n in enumerate(chunk)]
            path = out / f"sheet-{s // per + 1}.png"
            grid_sheet(items, path)
            sheets.append(str(path))

    doc = {
        "version": SCAN_VERSION, "export": ident, "info": info,
        "ledger": {k: ledger[k] for k in ("frames", "time_base", "pts0", "frame_step_pts", "constant_rate", "duration_s")},
        "fps": round(fps, 4), "policy": POLICY,
        "coverage": {"video_frames_scanned": ledger["frames"], "video_frames_total": ledger["frames"],
                     "scan_size": scan["scan_size"], "tile_px_scan": TILE,
                     "audio_samples": audio.get("samples"), "audio_rate": audio.get("rate")},
        "verdicts": verdicts, "video": _jsonable(vid), "audio": _jsonable(audio), "draft": draft,
        "text": {k: v for k, v in text.items() if k not in ("samples", "verdicts")},
        "queue": queue, "overview_frames": overview, "sheets": sheets,
        "per_frame": {k: [round(float(x), 4) for x in v] for k, v in scan["cols"].items()},
    }
    _atomic_write(out / "xray.json", json.dumps(doc))
    score = render_score(doc, ledger, video, sx)
    _atomic_write(out / "score.txt", score)
    fails = [v for v in verdicts if v["verdict"] == "FAIL"]
    if args.json:
        print(json.dumps({"out": str(out), "score": str(out / "score.txt"), "sheets": sheets,
                          "verdicts": verdicts}, indent=2))
    else:
        print(score)
        print(f"\nwrote {out / 'score.txt'}, {out / 'xray.json'} and {len(sheets)} sheet(s)")
    return 1 if fails else 0


def text_pass(args, video, ledger, info, out, draft):
    """Phase 3: captions, screen text, faces, and speech if asked. Never fatal to the scan."""
    import xray_text as xt
    if getattr(args, "no_text", False):
        return {"verdicts": [{"property": "captions", "verdict": "NOT CHECKED", "origin": "-",
                              "detail": "--no-text"}], "captions": []}
    authored = None
    if draft is not None:
        authored = [{"t0": e["t0"], "t1": e["t1"], "text": e["text"], "track": e["track"]}
                    for e in draft["events"] if e["type"] == "text" and e.get("text")]
    speech = None
    try:
        if getattr(args, "speech", False):
            speech = xt.transcribe_export(video, out / "speech", lang=getattr(args, "lang", None))
            _atomic_write(out / "speech.json", json.dumps(speech, ensure_ascii=False))
        return xt.scan_text(video, ledger, info, extract, t_of, frame_at, out,
                            authored=authored, speech=speech)
    except xt.TextUnavailable as e:
        return {"verdicts": [{"property": "captions", "verdict": "NOT CHECKED", "origin": "-",
                              "detail": str(e)}], "captions": []}


def _jsonable(x):
    if isinstance(x, dict):
        return {k: _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonable(v) for v in x]
    if isinstance(x, np.generic):
        return x.item()
    return x


def _shot_of(cuts, n):
    shots, k, cs = [], 0, set(cuts)
    for i in range(n):
        if i in cs:
            k += 1
        shots.append(k)
    return shots


def build_verdicts(vid, audio, draft, ledger, sx):
    P = POLICY
    v = []

    def add(prop, verdict, detail, origin="M", where=None):
        item = {"property": prop, "verdict": verdict, "detail": detail, "origin": origin}
        if where:
            item["where"] = where
        v.append(item)

    v.append({"property": "export.ledger", "verdict": "PASS", "origin": "M",
              "detail": f"{ledger['frames']} frames, strictly increasing PTS, "
                        f"{'constant' if ledger['constant_rate'] else 'variable'} frame step; scan decode matched every PTS"})
    by = {}
    for f in vid["findings"]:
        by.setdefault(f["kind"], []).append(f)
    for kind, prop, bad in (("black_frames", "video.black_frames", "FAIL"),
                            ("white_frames", "video.white_flash", "FAIL"),
                            ("glitch", "video.one_or_two_frame_glitch", "FAIL"),
                            ("duplicate_in_motion", "video.stutter", "UNKNOWN")):
        hits = by.get(kind, [])
        if not hits:
            extra = ""
            if kind == "glitch" and vid.get("moving_object_outliers"):
                extra = f"; {vid['moving_object_outliers']} one-frame changes set aside as moving objects"
            add(prop, "PASS", "none in any frame" + extra)
            continue
        if kind in ("black_frames", "white_frames"):
            hard = [h for h in hits if h["count"] <= 3 and not h.get("dip") and not h["near_cut"] and not h.get("declared")]
            verdict = "FAIL" if hard else "UNKNOWN"
            note = "" if hard else "; each sits inside a fade or at a cut (transition?), check it reads as intended"
        elif kind == "glitch":
            hard = [h for h in hits if not h["near_cut"] and not h.get("declared")]
            verdict = "FAIL" if hard else "UNKNOWN"
            note = "" if hard else "; each is a one-frame state at a change of shot (transition or a 1-frame clip sliver?)"
            if vid.get("moving_object_outliers"):
                note += f"; {vid['moving_object_outliers']} more set aside as moving objects"
        else:
            verdict, note = bad, ""
        where = [f"f{h['frames'][0]:05d}" + (f"-f{h['frames'][1]:05d}" if h["frames"][1] != h["frames"][0] else "")
                 for h in hits]
        declared = [h for h in hits if h.get("declared")]
        if declared:
            note += f"; {len(declared)} inside a declared transition ({', '.join(sorted({h['declared'] for h in declared}))})"
        add(prop, verdict, f"{len(hits)} event(s): " + ", ".join(where[:6]) + (" …" if len(hits) > 6 else "") + note,
            where=[h["frames"] for h in hits])
    add("video.letterbox", "UNKNOWN" if vid["letterbox"] else "PASS",
        "dark bands at top and bottom in >95% of frames" if vid["letterbox"] else "no persistent bands")

    if not audio.get("present"):
        for prop in ("audio.loudness", "audio.true_peak", "audio.clipping", "audio.clicks",
                     "audio.silence", "audio.mono"):
            add(prop, "NOT CHECKED", "no audio stream")
    else:
        L = audio["loudness"]
        lo, hi = P["loudness_lufs"]
        il = L.get("integrated_lufs")
        add("audio.loudness", "UNKNOWN" if il is None else ("PASS" if lo <= il <= hi else "FAIL"),
            f"{il} LUFS integrated (policy {lo}..{hi}), LRA {L.get('lra_lu')} LU")
        tp = L.get("true_peak_dbtp")
        add("audio.true_peak", "UNKNOWN" if tp is None else ("PASS" if tp <= P["true_peak_dbtp"] else "FAIL"),
            f"{tp} dBTP (policy ≤ {P['true_peak_dbtp']})")
        kinds = {}
        for f in audio["findings"]:
            kinds.setdefault(f["kind"], []).append(f)
        clips = kinds.get("clipping", [])
        add("audio.clipping", "FAIL" if clips else "PASS",
            (f"{len(clips)} run(s) of ≥{P['clip_run']} samples at full scale, first at "
             + ", ".join(fmt_t(c["t"]) for c in clips[:5])) if clips else "no full-scale runs in any sample")
        clicks = kinds.get("click", [])
        add("audio.clicks", "UNKNOWN" if clicks else "PASS",
            (f"{len(clicks)} candidate(s) at " + ", ".join(fmt_t(c["t"]) for c in clicks[:6])
             + (" …" if len(clicks) > 6 else "") + "; may be intended transients, listen") if clicks
            else "no sample jumps off the local curve")
        sil = [s for s in kinds.get("silence", []) if s["where"] == "inside"]
        add("audio.silence", "UNKNOWN" if sil else "PASS",
            (f"{len(sil)} gap(s) ≥{P['silence_min_s']}s below {P['silence_dbfs']} dBFS: "
             + ", ".join(f"{fmt_t(s['t'])} ({s['dur_s']}s)" for s in sil[:5])) if sil else "no dead air inside the video")
        mr = audio.get("mono_ratio_db")
        add("audio.mono", "UNKNOWN" if mr is None else ("FAIL" if mr < P["mono_fail_db"] else "PASS"),
            f"mono downmix keeps {mr} dB of stereo energy (fail below {P['mono_fail_db']})")

    if draft is None:
        add("draft.match", "NOT CHECKED", "no --project given", origin="A")
    else:
        notes = []
        verdict = "PASS"
        if not draft["duration_matches_export"]:
            verdict = "UNKNOWN"
            notes.append(f"draft content is {draft['content_duration']}s, export is {ledger['duration_s']:.3f}s")
        if draft.get("changed_after_export"):
            verdict = "UNKNOWN"
            notes.append("draft was saved after this export")
        add("draft.match", verdict, "; ".join(notes) or "draft content length matches the export", origin="A")
        declared = sorted({round(e["t0"], 4) for e in draft["events"] if e["type"] in ("video",)} |
                          {round(e["t1"], 4) for e in draft["events"] if e["type"] in ("video",)})
        dframes = {frame_at(ledger, max(0.0, t)) for t in declared if t < ledger["duration_s"]}
        wins = transition_windows(draft)
        unmatched = [c for c in vid["cuts"] if not any(abs(c - d) <= 1 for d in dframes)
                     and not any(w0 - 0.07 <= t_of(ledger, c) <= w1 + 0.07 for w0, w1, _ in wins)]
        add("draft.visible_cuts", "UNKNOWN" if unmatched else "PASS",
            (f"{len(unmatched)} visible cut(s) with no video boundary in the draft (baked into source?): "
             + ", ".join(f"f{c:05d}" for c in unmatched[:8])) if unmatched
            else f"all {len(vid['cuts'])} visible cuts sit on a draft boundary (±1 frame)")
    if draft is not None:
        fps = 1 / (ledger["frame_step_pts"]["median"] * ledger["_tb"])
        short = [e for e in draft["events"] if e["type"] == "video" and 0 < e["t1"] - e["t0"] < 0.25
                 and e["t0"] < ledger["duration_s"]]
        add("draft.short_clips", "UNKNOWN" if short else "PASS",
            (f"{len(short)} video clip(s) under 0.25s: "
             + ", ".join(f"{fmt_t(max(0.0, e['t0']))} t{e['track']} ({round((e['t1'] - e['t0']) * fps)} frames)" for e in short[:6]))
            if short else "no video clip shorter than 0.25s", origin="A")
    for prop, why in NOT_CHECKED:
        add(prop, "NOT CHECKED", why, origin="-")
    return v


def build_queue(vid, ledger, ident, audio, text=None):
    n = ledger["frames"]
    queue = []
    busy = set()

    def window(a, b, why, rank):
        a, b = max(0, a), min(n - 1, b)
        queue.append({"frames": [a, b], "why": why, "rank": rank})
        busy.update(range(a, b + 1))

    for f in vid["findings"]:
        a, b = f["frames"]
        label = f"{f['kind']} f{a:05d}" + (f"-f{b:05d}" if b != a else "")
        if f.get("dip"):
            label += " (inside a fade)"
        hard = not f.get("declared") and (
            (f["kind"] in ("black_frames", "white_frames") and not f.get("dip") and not f.get("near_cut")) or
            (f["kind"] == "glitch" and not f.get("near_cut")))
        if f.get("declared"):
            label += f" (declared transition: {f['declared']})"
        if f.get("at_cut"):
            label += " (one-frame state at a cut)"
        size = f.get("tile_share", 1.0)
        window(a - 2, b + 2, label, (0 if hard else 1, -size))
    for f in (audio.get("findings") or []):
        if f["kind"] in ("clipping", "click"):
            k = frame_at(ledger, min(f["t"], ledger["duration_s"] - 1e-6))
            window(k - 2, k + 2, f"audio {f['kind']} {fmt_t(f['t'])}", (0 if f["kind"] == "clipping" else 2, 0))
    spans = dict(vid.get("transitions", []))
    for kind, items in ((text or {}).get("issues") or {}).items():
        for it in items:
            a, b = it["frames"]
            # Speech mismatches are noisy (dialect vs Whisper's spelling): look at them last.
            rank = 0 if it["verdict"] == "FAIL" else (2.7 if kind == "speech" else 1)
            window(a - 2, min(b + 2, a + 30), f"caption {kind}: {it['detail'][:60]}", (rank, 0))
    for c in vid["cuts"]:
        e = spans.get(c, c)
        window(c - 2, e + 2, (f"transition f{c:05d}-f{e:05d}" if e != c else f"cut f{c:05d}"), (3, 0))
    # blind spot-checks: windows chosen independently of every detector, seeded by the export
    rng = np.random.default_rng(int(ident["sha256"][:12], 16))
    tries = 0
    blind = 0
    while blind < POLICY["blind_windows"] and tries < 200 and n > 10:
        tries += 1
        a = int(rng.integers(0, max(1, n - 5)))
        if any(i in busy for i in range(a, a + 5)):
            continue
        window(a, a + 4, "blind spot-check", (2.5, 0))
        blind += 1
    queue = _merge_windows(queue)
    # overview: one frame per shot, then fill so no gap is longer than the policy
    fps = 1 / (ledger["frame_step_pts"]["median"] * ledger["_tb"])
    gap = max(1, round(POLICY["overview_gap_s"] * fps))
    bounds = [0] + vid["cuts"] + [n]
    pick = set()
    for a, b in pairwise(bounds):
        if b > a:
            pick.add((a + b - 1) // 2)
    pick.add(0)
    pick.add(n - 1)
    ordered = sorted(pick)
    filled = []
    for a, b in zip(ordered, [*ordered[1:], None], strict=True):
        filled.append(a)
        if b is not None:
            k = a + gap
            while k < b - gap // 3:
                filled.append(k)
                k += gap
    return queue, sorted(set(filled))


def _merge_windows(queue):
    """Overlapping windows become one, keeping every reason and the most urgent rank."""
    merged = []
    for q in sorted(queue, key=lambda q: q["frames"][0]):
        if merged and q["frames"][0] <= merged[-1]["frames"][1] + 1 and \
                q["frames"][1] - merged[-1]["frames"][0] < 36:
            m = merged[-1]
            m["frames"][1] = max(m["frames"][1], q["frames"][1])
            m["why"] += "; " + q["why"]
            m["rank"] = min(m["rank"], q["rank"])
        else:
            merged.append({"frames": list(q["frames"]), "why": q["why"], "rank": q["rank"]})
    merged.sort(key=lambda q: (q["rank"], q["frames"][0]))
    for q in merged:
        q["rank"] = list(q["rank"])
    return merged


def render_score(doc, ledger, video, sx):
    L = []
    inf = doc["info"]["video"]
    ex = doc["export"]
    L.append(f"XRAY  {os.path.basename(video)}  sha256 {ex['sha256'][:12]}  {inf['width']}x{inf['height']}  "
             f"{doc['fps']:g} fps ({'constant' if doc['ledger']['constant_rate'] else 'variable'})  "
             f"{doc['ledger']['frames']} frames  {doc['ledger']['duration_s']:.3f}s")
    cov = doc["coverage"]
    a = doc["audio"]
    L.append(f"coverage  video {cov['video_frames_scanned']}/{cov['video_frames_total']} frames at "
             f"{cov['scan_size'][0]}x{cov['scan_size'][1]} luma, {TILE}px tiles"
             + (f"   audio {a['samples']}/{a['samples']} samples at {a['rate']} Hz stereo" if a.get("present") else "   audio: none"))
    if doc["draft"]:
        d = doc["draft"]
        L.append(f"draft  {os.path.basename(d['project'])}  sha256 {d['draft']['sha256'][:12]}  "
                 f"content {d['content_range'][0]:.3f}-{d['content_range'][1]:.3f}s")
    L.append("origin tags: A = authored in the draft, M = measured on the export, E = estimated")
    L.append("")
    L.append("VERDICTS")
    for v in doc["verdicts"]:
        L.append(f"  {v['verdict']:<11} {v['property']:<30} [{v['origin']}] {v['detail']}")
    L.append("")
    L.append("EVENTS")
    lines = []
    for f in doc["video"]["findings"]:
        a0, b0 = f["frames"]
        extra = ""
        if f["kind"] == "glitch":
            bx = [round(x * sx) for x in f["box_scan"]]
            extra = f"  region ({bx[0]},{bx[1]})-({bx[2]},{bx[3]})  {f['tiles']} tiles"
        lines.append((t_of(ledger, a0), f"f{a0:05d} {fmt_t(t_of(ledger, a0))} M {f['kind'].upper():<20} "
                                          f"{f['count']} frame(s){extra}"))
    spans = dict(doc["video"].get("transitions", []))
    for c in doc["video"]["cuts"]:
        pf = doc["per_frame"]
        if c in spans:
            lines.append((t_of(ledger, c), f"f{c:05d} {fmt_t(t_of(ledger, c))} M TRANSITION           "
                                             f"to f{spans[c]:05d} ({(spans[c] - c + 1) / doc['fps']:.2f}s of full-frame change)"))
        else:
            lines.append((t_of(ledger, c), f"f{c:05d} {fmt_t(t_of(ledger, c))} M CUT                  "
                                             f"{pf['frac'][c] * 100:.0f}% of tiles changed, Δ{pf['d1'][c]:.3f}"))
    for f in doc["audio"].get("findings") or []:
        desc = {"clipping": f"{f.get('dur_ms')} ms at full scale, ch{f.get('channel')}",
                "click": f"jump {f.get('jump')}",
                "silence": f"{f.get('dur_s')}s below {POLICY['silence_dbfs']} dBFS ({f.get('where')})"}[f["kind"]]
        t = f["t"]
        k = frame_at(ledger, min(t, ledger["duration_s"] - 1e-6))
        lines.append((t, f"f{k:05d} {fmt_t(t)} M AUDIO {f['kind'].upper():<14} {desc}"))
    captions_listed = bool((doc.get("text") or {}).get("captions"))
    if doc["draft"]:
        for e in doc["draft"]["events"]:
            if captions_listed and e["type"] == "text":
                continue  # the CAPTIONS section lists what was read; xray.json keeps the authored text
            t0 = max(0.0, e["t0"])
            if t0 >= ledger["duration_s"]:
                continue
            k = frame_at(ledger, t0)
            extra = ""
            for key in ("speed", "scale", "volume_db", "pos"):
                if key in e:
                    extra += f"  {key} {e[key]}"
            if e.get("transition"):
                extra += f"  →{e['transition']['name']} {e['transition']['dur']}s at end"
            if e.get("effects"):
                extra += "  fx " + ",".join(map(str, e["effects"]))
            if e.get("animations"):
                extra += "  anim " + ",".join(e["animations"])
            for kf in e.get("keyframes", []):
                extra += f"  KF {kf['property']} {kf['from'][1]}→{kf['to'][1]} @{kf['from'][0]:.2f}-{kf['to'][0]:.2f}s"
            lines.append((t0 + 1e-6, f"f{k:05d} {fmt_t(t0)} A {e['type'].upper():<6} t{e['track']:<2} "
                                      f"{e['label'][:48]}  until {fmt_t(e['t1'])}{extra}"))
    for _, line in sorted(lines, key=lambda x: x[0]):
        L.append("  " + line)
    caps = (doc.get("text") or {}).get("captions") or []
    if caps:
        L.append("")
        L.append(f"CAPTIONS  ({len(caps)} states read on exact frames; dwell is a range because frames "
                 f"are read every {doc['text'].get('stride_frames')} frames)")
        for c in caps:
            flags = []
            if c.get("face_cover", 0) >= 0.10:
                flags.append(f"face {c['face_cover']:.0%}")
            if c.get("unspoken_words"):
                flags.append("unheard " + ",".join(c["unspoken_words"][:3]))
            if c.get("draft_match") is not None and c["draft_match"] < 0.8:
                flags.append(f"draft match {c['draft_match']}")
            bx = c["box"]
            L.append(f"  f{c['frames'][0]:05d} {fmt_t(c['t'][0])} M \"{c['text'][:28]}\"  "
                     f"{c['height_px_1920']:.0f}px  {c['dwell_s'][0]:.2f}-{c['dwell_s'][1]:.2f}s  "
                     f"contrast {c['contrast']}:1  box ({bx[0]:.0f},{bx[1]:.0f},{bx[2]:.0f}x{bx[3]:.0f})"
                     + (f"  [{'; '.join(flags)}]" if flags else ""))
    L.append("")
    L.append(lanes(doc, ledger))
    L.append("")
    L.append("QUEUE  (look closer; every frame is exact and verified by PTS)")
    # Quoted for a POSIX shell: a filename must never be able to end the command.
    rel = shlex.quote(os.path.basename(video))
    shown = doc["queue"][:QUEUE_SHOWN]
    for q in shown:
        a0, b0 = q["frames"]
        L.append(f"  capcutctl xray window {rel} --frames {a0}-{b0}   # {q['why'][:110]}")
    if len(doc["queue"]) > len(shown):
        L.append(f"  … {len(doc['queue']) - len(shown)} more, lower priority, in xray.json \"queue\"")
    if doc["sheets"]:
        L.append("")
        L.append("SHEETS  " + "  ".join(os.path.basename(s) for s in doc["sheets"])
                 + f"   ({len(doc['overview_frames'])} overview frames, max gap {POLICY['overview_gap_s']}s)")
    st = doc["video"]["longest_static"]
    if st:
        L.append(f"PACING  longest still stretch f{st[0]:05d}-f{st[1]:05d} "
                 f"({(st[1] - st[0] + 1) / doc['fps']:.2f}s); {len(doc['video']['cuts'])} visible cuts")
    return "\n".join(L) + "\n"


def lanes(doc, ledger):
    dur = ledger["duration_s"]
    secs = math.ceil(dur)
    fps = doc["fps"]
    cut_secs = {int(t_of(ledger, c)) for c in doc["video"]["cuts"]}
    flag_secs = set()
    for f in doc["video"]["findings"]:
        flag_secs.add(int(t_of(ledger, f["frames"][0])))
    for f in doc["audio"].get("findings") or []:
        if f["kind"] in ("clipping", "click"):
            flag_secs.add(int(f["t"]))
    motion = doc["per_frame"]["d1"]
    bars = " ▁▂▃▄▅▆▇█"
    mot = []
    for s in range(secs):
        a, b = int(s * fps), min(len(motion), int((s + 1) * fps))
        m = float(np.mean(motion[a:b])) if b > a else 0.0
        mot.append(bars[min(8, int(m / 0.01))])
    loud = []
    series = (doc["audio"].get("loudness") or {}).get("momentary") or []
    for s in range(secs):
        vals = [x[1] for x in series if x[1] is not None and s <= x[0] - 0.4 < s + 1]
        if not vals:
            loud.append(" ")
            continue
        m = max(vals)
        loud.append(bars[max(0, min(8, int((m + 40) / 4)))])
    ruler = "".join(str(s // 10) if s % 10 == 0 else "·" for s in range(secs))
    out = ["LANES  (1 column = 1 s)",
           f"  sec    {ruler}",
           f"  CUT    {''.join('|' if s in cut_secs else '·' for s in range(secs))}",
           f"  FLAG   {''.join('!' if s in flag_secs else '·' for s in range(secs))}",
           f"  MOTION {''.join(mot)}   (mean frame change; █ ≥ 0.08)"]
    if doc["audio"].get("present"):
        out.append(f"  LOUD   {''.join(loud)}   (max momentary loudness; ▁ -40 … █ ≥ -8 LUFS)")
    return "\n".join(out)


# ---------------------------------------------------------------- queries

def parse_crop(text):
    if not text:
        return None
    try:
        parts = [int(x) for x in text.split(",")]
    except ValueError:
        fail("--crop takes four whole numbers X,Y,W,H in export pixels")
    if len(parts) != 4 or min(parts) < 0 or parts[2] == 0 or parts[3] == 0:
        fail("--crop takes X,Y,W,H in export pixels, all non-negative, W and H above zero")
    return parts


def cmd_frame(args):
    need("ffmpeg")
    ledger, _ = load_or_build_ledger(args.video, args.xray)
    if args.frame is None and args.t is None:
        fail("give --frame N or --t SECONDS")
    n = args.frame if args.frame is not None else frame_at(ledger, args.t)
    out = Path(args.out or (Path(args.xray or default_dir(args.video)) / "q" / f"f{n:06d}.png"))
    with tempfile.TemporaryDirectory() as td:
        [(_, p)] = extract(args.video, ledger, [n], td, crop=parse_crop(args.crop))
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), out)
    print(json.dumps({"frame": n, "pts": ledger["pts"][n], "time_base": ledger["time_base"],
                      "t": round(t_of(ledger, n), 6), "requested_t": args.t,
                      "key_frame": n in set(ledger.get("key", [])), "crop": parse_crop(args.crop),
                      "out": str(out)}))
    return 0


def cmd_window(args):
    need("ffmpeg")
    ledger, _ = load_or_build_ledger(args.video, args.xray)
    if args.frames:
        a, _, b = args.frames.partition("-")
        a, b = int(a), int(b or a)
    elif args.start is not None and args.end is not None:
        a, b = frame_at(ledger, args.start), frame_at(ledger, args.end)
    else:
        fail("give --frames A-B or --from S --to S")
    if b < a:
        a, b = b, a
    if b - a + 1 > 36:
        fail(f"a window holds at most 36 frames; asked for {b - a + 1}")
    crop = parse_crop(args.crop)
    out = Path(args.out or (Path(args.xray or default_dir(args.video)) / "q" / f"w{a:06d}-{b:06d}.png"))
    with tempfile.TemporaryDirectory() as td:
        got = extract(args.video, ledger, range(a, b + 1), td, crop=crop,
                      width=None if crop and crop[2] <= 360 else 240)
        t0 = t_of(ledger, a)
        items = [(p, f"f{n:05d}  {fmt_t(t_of(ledger, n))}", f"+{t_of(ledger, n) - t0:.3f}s")
                 for n, p in got]
        out.parent.mkdir(parents=True, exist_ok=True)
        tile_w = min(360, Image.open(got[0][1]).width)
        grid_sheet(items, out, cols=min(6, len(items)), tile_w=tile_w)
    print(json.dumps({"frames": [a, b], "count": b - a + 1,
                      "pts": [ledger["pts"][a], ledger["pts"][b]], "time_base": ledger["time_base"],
                      "t": [round(t_of(ledger, a), 6), round(t_of(ledger, b), 6)],
                      "crop": crop, "out": str(out)}))
    return 0


def cmd_audio(args):
    need("ffmpeg")
    samples, rate = decode_audio(args.video)
    a, b = int(max(0, args.start) * rate), int(args.end * rate)
    seg = samples[a:b]
    res = detect_audio(seg, rate, offset_s=a / rate)
    blk = rate // 100
    nb = len(seg) // blk
    rms = []
    if nb:
        mono = seg[:nb * blk].mean(axis=1).reshape(nb, blk)
        rms = [round(_db(float(np.sqrt(np.mean(x ** 2)))), 1) for x in mono]
    res.update({"from": args.start, "to": args.end, "rate": rate,
                "rms_dbfs_10ms": rms})
    print(json.dumps(_jsonable(res)))
    return 0


# ---------------------------------------------------------------- selftest

def _barcode(n, bits=12):
    return [(n >> i) & 1 for i in range(bits)]


def _fixture(path, frames=180, w=270, h=480, fps=30):
    """Moving picture with a frame-index barcode and known injected defects."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    raw = []
    for n in range(frames):
        k = min(n, 150)  # frames 150.. hold still (only the barcode changes)
        if n == 110:
            k = 109       # an exact repeat while everything else moves
        if k < 60:
            img = 0.5 + 0.3 * np.sin(2 * np.pi * (xx / 90 + k / 30)) * np.cos(2 * np.pi * yy / 160)
        else:             # a hard cut at frame 60
            img = 0.35 + 0.25 * np.sin(2 * np.pi * (yy / 70 - k / 40)) * np.cos(2 * np.pi * xx / 120)
        img[:28] = 0.5
        for i, bit in enumerate(_barcode(109 if n == 110 else n)):
            img[6:22, 8 + i * 21:24 + i * 21] = 0.60 if bit else 0.40
        if 115 <= n <= 119:  # a small object crossing the frame fast: motion, not a glitch
            x0 = (n - 115) * 60
            img[330:354, x0 + 3:x0 + 27] = 1.0
        if 86 <= n <= 94:    # a fade through black: a transition, not a glitch
            img *= abs(n - 90) / 4
        if n == 40:
            img[:] = 0.0
        if n in (75, 76):
            img[:] = 1.0
        if n == 140:
            img[200:260, 90:150] = 1.0 - img[200:260, 90:150]
        raw.append((np.clip(img, 0, 1) * 255).astype(np.uint8))
    rate = 48000
    t = np.arange(int(frames / fps * rate)) / rate
    tone = 0.1 * np.sin(2 * np.pi * 440 * t)
    tone[int(2.0 * rate)] += 0.6
    a, b = int(3.0 * rate), int(3.02 * rate)
    tone[a:b] = np.sign(np.sin(2 * np.pi * 220 * t[a:b])) * 1.0
    tone[int(4.0 * rate):int(4.5 * rate)] = 0.0
    pcm = (np.clip(np.stack([tone, tone], axis=1), -1, 32767 / 32768) * 32768).astype("<i2")
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "a.raw"
        wav.write_bytes(pcm.tobytes())
        cmd = ["ffmpeg", "-hide_banner", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
               "-f", "s16le", "-ar", str(rate), "-ac", "2", "-i", str(wav),
               "-c:v", "libx264", "-crf", "8", "-g", "48", "-bf", "2", "-pix_fmt", "yuv420p",
               "-c:a", "pcm_s16le", "-output_ts_offset", "0.25", str(path)]
        p = subprocess.run(cmd, input=b"".join(f.tobytes() for f in raw), capture_output=True)
        if p.returncode:
            fail(f"could not build the fixture: {p.stderr.decode()[-300:]}")


def _read_barcode(png, bits=12):
    im = np.asarray(Image.open(png).convert("L"), np.float32) / 255
    return sum((1 << i) for i in range(bits) if im[10:18, 12 + i * 21:20 + i * 21].mean() > 0.5)


def _selftest_text(check):
    import xray_text as xt
    black_white = Image.new("L", (40, 20), 0)
    black_white.paste(255, (0, 0, 10, 20))
    check("contrast: white text on black is 21:1", xt.contrast_ratio(black_white) == 21.0,
          f"{xt.contrast_ratio(black_white)}")
    check("contrast: flat grey is 1:1", xt.contrast_ratio(Image.new("L", (40, 20), 128)) == 1.0)
    check("Arabic normalisation folds alef forms and tashkeel", xt.norm("أَنا") == xt.norm("انا"))
    check("a one-letter misread is not the same caption", not xt.matches("حظ", "حط"))
    check("a short word is not 'inside' a URL", not xt.matches("chatgpt.com/c/6ac108a1q", "ChatGPT"))
    check("a close misread of a caption still matches", xt.matches("وعفل", "وعمل"))
    if sys.platform != "darwin" or not shutil.which("swiftc"):
        check("Vision read (skipped: needs macOS and swiftc)", True)
        return
    with tempfile.TemporaryDirectory() as td:
        im = Image.new("RGB", (1080, 1920), (40, 40, 40))
        ImageDraw.Draw(im).text((200, 1200), "READ THIS CAPTION", fill=(255, 255, 255), font=_font(90))
        path = Path(td) / "cap.png"
        im.save(path)
        try:
            rec = xt.run_vision(xt.vision_helper(), [path])[str(path)]
        except xt.TextUnavailable as e:
            check("Vision helper builds and runs", False, str(e))
            return
        lines = xt.merge_reads(rec)
        hit = [ln for ln in lines if "caption" in ln["text"].lower()]
        check("Vision reads a drawn caption with both language orders", bool(hit),
              f"{[ln['text'] for ln in lines]}")
        if hit:
            y, h = hit[0]["y"] * 1920, hit[0]["h"] * 1920
            check("its box sits where it was drawn", 1180 <= y <= 1230 and 50 <= h <= 130, f"y={y:.0f} h={h:.0f}")


def cmd_selftest(_args):
    need("ffmpeg")
    checks = []

    def check(name, ok, detail=""):
        checks.append((name, bool(ok), detail))
        print(f"  {'ok  ' if ok else 'FAIL'} {name}{('  ' + detail) if detail else ''}")

    with tempfile.TemporaryDirectory() as td:
        video = str(Path(td) / "fixture.mkv")
        _fixture(video)
        info = probe_streams(video)
        ledger = build_ledger(video, info)
        check("ledger has every frame", ledger["frames"] == 180, f"{ledger['frames']}")
        check("ledger keeps the nonzero start", ledger["pts0"] > 0, f"pts0={ledger['pts0']} tb={ledger['time_base']}")
        probe = [0, 1, 2, 47, 48, 49, 95, 96, 97, 139, 141, 179]
        got = extract(video, ledger, probe, Path(td) / "q")
        bad = [(n, _read_barcode(p)) for n, p in got if _read_barcode(p) != n]
        check("seek extraction returns the exact frame", not bad, f"{len(probe)} frames, wrong: {bad}")
        far = extract(video, ledger, [3, 170], Path(td) / "q2", force_decode=True)
        check("far-apart frames by full decode", all(_read_barcode(p) == n for n, p in far))
        for n in (0, 59, 61, 179):
            k = frame_at(ledger, n / 30 + 0.001)
            check(f"time {n / 30 + 0.001:.3f}s maps to frame {n}", k == n, f"got {k}")
        scan = scan_video(video, ledger, info)
        vid = detect_video(scan, ledger)
        kinds = {(f["kind"], tuple(f["frames"])) for f in vid["findings"]}
        check("black frame at 40", ("black_frames", (40, 40)) in kinds)
        dips = [f for f in vid["findings"] if f["kind"] == "black_frames" and f.get("dip")]
        check("fade through black at 90 is a dip, the frame at 40 is not",
              [d["frames"] for d in dips] == [[90, 90]], f"{[d['frames'] for d in dips]}")
        check("white flash at 75-76", ("white_frames", (75, 76)) in kinds)
        check("stutter at 110", ("duplicate_in_motion", (110, 110)) in kinds)
        glitch = [f for f in vid["findings"] if f["kind"] == "glitch"]
        check("local one-frame glitch at 140", [g["frames"] for g in glitch] == [[140, 140]],
              f"glitches {[g['frames'] for g in glitch]}")
        if glitch:
            bx = glitch[0]["box_scan"]
            ix = max(0, min(bx[2], 150) - max(bx[0], 90)) * max(0, min(bx[3], 260) - max(bx[1], 200))
            check("glitch region covers most of the corrupted square", ix / 3600 >= 0.75, f"{bx}, {ix / 3600:.0%}")
        check("one cut, at 60", vid["cuts"] == [60], f"cuts {vid['cuts']}")
        check("the crossing object was seen and set aside as motion", vid["moving_object_outliers"] >= 1,
              f"{vid['moving_object_outliers']}")
        check("still stretch from 150", vid["longest_static"] and vid["longest_static"][0] in (150, 151)
              and vid["longest_static"][1] == 179, f"{vid['longest_static']}")
        check("no other findings (the crossing object is not a glitch)", len(vid["findings"]) == 5,
              f"{[(f['kind'], f['frames']) for f in vid['findings']]}")
        samples, rate = decode_audio(video)
        au = detect_audio(samples, rate)
        ak = au["findings"]
        clicks = [f["t"] for f in ak if f["kind"] == "click"]
        check("click near 2.000s", any(abs(t - 2.0) < 0.003 for t in clicks), f"{clicks[:5]}")
        check("clipping near 3.000s", any(f["kind"] == "clipping" and abs(f["t"] - 3.0) < 0.02 for f in ak))
        check("silence 4.0-4.5s", any(f["kind"] == "silence" and abs(f["t"] - 4.0) < 0.02 and abs(f["dur_s"] - 0.5) < 0.03 for f in ak))
        check("no clicks away from the defects", all(abs(t - 2.0) < 0.01 or 2.99 < t < 3.03 or 3.99 < t < 4.01 or 4.49 < t < 4.51 for t in clicks),
              f"{clicks}")
        check("mono downmix of identical channels keeps 0 dB", abs(au["mono_ratio_db"]) < 0.1, f"{au['mono_ratio_db']}")
        lo = loudness(video)
        hostile = '$(touch pwned)"; echo x.mp4'
        check("queue commands quote hostile filenames",
              shlex.split(f"capcutctl xray window {shlex.quote(hostile)} --frames 1-2")[3] == hostile)
        check("true peak measured", lo["true_peak_dbtp"] is not None and lo["true_peak_dbtp"] > -1.0, f"{lo['true_peak_dbtp']}")
    _selftest_text(check)
    failed = [c for c in checks if not c[1]]
    print(f"xray selftest: {len(checks) - len(failed)}/{len(checks)} passed")
    return 1 if failed else 0


# ---------------------------------------------------------------- main

def main(argv=None):
    p = argparse.ArgumentParser(prog="capcutctl xray", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan", help="measure every frame and sample; write score, json and sheets")
    s.add_argument("video")
    s.add_argument("--project", help="CapCut project name or folder, to add authored events")
    s.add_argument("--out", help="output folder (default: VIDEO.xray next to the video)")
    s.add_argument("--json", action="store_true", help="print verdicts as JSON instead of the score")
    s.add_argument("--no-text", action="store_true", help="skip captions, screen text and faces")
    s.add_argument("--speech", action="store_true", help="transcribe the export and check captions against it")
    s.add_argument("--lang", help="speech language for --speech (e.g. ar); default auto")
    f = sub.add_parser("frame", help="one exact frame at native resolution")
    f.add_argument("video")
    f.add_argument("--frame", type=int)
    f.add_argument("--t", type=float, help="seconds from the first frame")
    f.add_argument("--crop", help="X,Y,W,H in export pixels")
    f.add_argument("--out")
    f.add_argument("--xray", help="X-ray folder holding the ledger")
    w = sub.add_parser("window", help="consecutive exact frames as one labelled strip")
    w.add_argument("video")
    w.add_argument("--frames", help="A-B, inclusive frame indices")
    w.add_argument("--from", dest="start", type=float)
    w.add_argument("--to", dest="end", type=float)
    w.add_argument("--crop", help="X,Y,W,H in export pixels")
    w.add_argument("--out")
    w.add_argument("--xray")
    a = sub.add_parser("audio", help="audio measurements for a time window")
    a.add_argument("video")
    a.add_argument("--from", dest="start", type=float, required=True)
    a.add_argument("--to", dest="end", type=float, required=True)
    sub.add_parser("selftest", help="build a fixture with known defects and check every detector")
    args = p.parse_args(argv)
    try:
        return {"scan": cmd_scan, "frame": cmd_frame, "window": cmd_window,
                "audio": cmd_audio, "selftest": cmd_selftest}[args.cmd](args)
    except XrayError as e:
        print(f"xray: {e.message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
