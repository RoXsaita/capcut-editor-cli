#!/usr/bin/env python3
"""
capcutctl find — where does this phrase happen?

Three haystacks, one answer shape:
  --says     the Whisper transcript of a talking-head recording  (what was SAID, and when)
  --shows    the OCR index of a screen recording                 (what was ON SCREEN, and when)
  --moments  the rl2 change signal                               (when did anything HAPPEN)

`--moments` is the cheap one and it reads a take's own sidecars, so it costs no OCR at all
to list what happened, and one frame per moment to search it. See change_index.py. It also
sharpens `--shows`: the 1 fps grid can only report the whole second it sampled, but the
change signal knows which frame inside that second the text actually arrived on.

This exists because doing it by hand got a shot wrong. A coarse OCR search reported
"reading files 168-318"; source 168 is actually the sidebar drawer, and the file list
does not start until 176. The B-roll sat on the wrong content until frames were checked.
Runs are collapsed and reported with their FIRST STABLE second, not the first flicker.
When --strip is used, frames carry requested/delivered PTS evidence from frame_qa's
accuracy-checked extractor before they are put in the contact sheet.
"""
import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from itertools import pairwise
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import change_index
from audio_index import _write_json_atomic, source_token

CACHE = os.path.expanduser("~/Downloads/.video-index")
OCR_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vision", "ocr")
# v4 tags each box with region chat|canvas|toolbar. v3 kept geometry but no region and
# is refused so a --refresh rebuilds rather than searching an untagged index.
OCR_INDEX_VERSION = 4
# 1 fps misses sub-second UI changes. That is still true of this grid and always will be —
# what changed is that an rl2 take no longer has to rely on it: `--moments` indexes the
# frames the recorder already flagged as different, and `--shows` uses the same signal to
# name the frame inside a sampled second where the text actually appeared.
OCR_SAMPLE_INTERVAL = 1.0
# v3 stores {text, boxes} with per-box region; v2 was geometry without region.
MOMENT_INDEX_VERSION = 3
# Verbs that mean "show the thing, not a chat log describing it".
ACTION_VERBS = frozenset({
    "click", "tap", "hit", "press", "open", "run", "type", "select", "submit",
    "drag", "scroll", "hover", "focus",
})
CHAT_APP = re.compile(r"chat|slack|discord|messages|whatsapp|telegram|imessage", re.I)
TOOLBAR_BAND = 0.12
CHAT_X = 0.28
SHORT_H = 0.08
MIN_CHAT_STACK = 3


def canonical_media(media):
    """Resolve the source path used by cache provenance and reject missing media."""
    try:
        path = os.path.realpath(os.path.abspath(os.fspath(media)))
    except TypeError:
        raise SystemExit("--media must name a file") from None
    if not os.path.isfile(path):
        raise SystemExit(f"media file does not exist: {path}")
    return path


def _canonical_stored_path(value):
    try:
        return os.path.realpath(os.path.abspath(os.fspath(value)))
    except TypeError:
        return None


def _ocr_source_path(data):
    path = data.get("media", data.get("source_path"))
    source = data.get("source")
    if path is None and isinstance(source, dict):
        path = source.get("path")
    return _canonical_stored_path(path)


def _ocr_source_token(data):
    token = data.get("source_token", data.get("media_token"))
    source = data.get("source")
    if token is None and isinstance(source, dict):
        token = source.get("token")
    return token if isinstance(token, dict) else None


def _transcript_source_token(data):
    token = data.get("_token", data.get("source_token", data.get("media_token")))
    return token if isinstance(token, dict) else None


def _cache_dir(cache_dir=None):
    return os.path.abspath(os.path.expanduser(cache_dir or CACHE))


def _cache_files(cache_dir, marker):
    try:
        return sorted(
            (path for path in Path(cache_dir).iterdir()
             if path.is_file() and path.suffix == ".json" and marker in path.name),
            key=lambda path: path.name,
        )
    except OSError:
        return []


def _normalise_text(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _probe_duration(media):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", media],
            capture_output=True, text=True,
        )
    except OSError as error:
        raise SystemExit(f"could not run ffprobe for {media}: {error}") from None
    if result.returncode != 0:
        detail = (result.stderr or "").strip() or "ffprobe returned an error"
        raise SystemExit(f"could not read source duration for {media}: {detail}")
    for line in (result.stdout or "").splitlines():
        try:
            duration = float(line.strip())
        except (TypeError, ValueError):
            continue
        if math.isfinite(duration) and duration > 0:
            return duration
    raise SystemExit(f"could not read a positive source duration for {media}")


def _expected_samples(duration, interval=OCR_SAMPLE_INTERVAL):
    return max(1, math.ceil(duration / interval - 1e-9))


def _source_cache_key(media, token):
    value = f"{media}\0{json.dumps(token, sort_keys=True, separators=(',', ':'))}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def ocr_cache_path(media, token=None, cache_dir=None):
    media = canonical_media(media)
    token = token or source_token(media)
    stem = Path(media).stem
    return Path(_cache_dir(cache_dir)) / f"{stem}.ocr-{_source_cache_key(media, token)}.json"


def _ocr_observation(row):
    """One Vision word/line: {text, conf, x, y, w, h}, or None if unusable.

    Origin is top-left, coordinates normalised 0..1 — the same shape tools/vision/ocr.swift
    prints (swift's `confidence` is stored as `conf`).
    """
    if not isinstance(row, dict):
        return None
    text = str(row.get("text") or "").strip()
    if not text:
        return None
    conf_raw = row.get("conf", row.get("confidence"))
    try:
        conf = float(0 if conf_raw is None else conf_raw)
        x = float(row["x"])
        y = float(row["y"])
        w = float(row["w"])
        h = float(row["h"])
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (conf, x, y, w, h)):
        return None
    obs = {"text": text, "conf": conf, "x": x, "y": y, "w": w, "h": h}
    region = row.get("region")
    if region in ("chat", "canvas", "toolbar"):
        obs["region"] = region
    return obs


def _parse_boxes(raw):
    if not isinstance(raw, list):
        return None
    boxes = []
    for row in raw:
        obs = _ocr_observation(row)
        if obs is None:
            return None
        boxes.append(obs)
    return boxes


def _frame_entry(value):
    """Normalise a frame to {text, boxes} for the cache."""
    if isinstance(value, str):
        return {"text": _normalise_text(value), "boxes": []}
    if not isinstance(value, dict):
        return {"text": "", "boxes": []}
    boxes = []
    for row in value.get("boxes") or []:
        obs = _ocr_observation(row)
        if obs is not None:
            boxes.append(obs)
    text = value.get("text")
    if not isinstance(text, str) or not text.strip():
        text = " ".join(box["text"] for box in boxes)
    return {"text": _normalise_text(text), "boxes": boxes}


def _frame_text(entry):
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        return str(entry.get("text") or "")
    return ""


def _frame_boxes(entry):
    if isinstance(entry, dict) and isinstance(entry.get("boxes"), list):
        return entry["boxes"]
    return []


def _print_boxes(boxes, indent="           "):
    print(f"{indent}boxes {json.dumps(boxes, ensure_ascii=False, separators=(',', ':'))}")


def _bit(row, col):
    return row * 8 + col


def _box_blocks(box):
    """8×8 cells overlapping a normalised box. Row 0 is the top, matching OCR origin."""
    x0 = min(7, max(0, int(box["x"] * 8)))
    x1 = min(7, max(0, int((box["x"] + box["w"]) * 8 - 1e-9)))
    y0 = min(7, max(0, int(box["y"] * 8)))
    y1 = min(7, max(0, int((box["y"] + box["h"]) * 8 - 1e-9)))
    if x1 < x0:
        x1 = x0
    if y1 < y0:
        y1 = y0
    return [(row, col) for row in range(y0, y1 + 1) for col in range(x0, x1 + 1)]


def _columnar_change(mask, col_lo, col_hi):
    """Chat panels scroll as a column: many rows, few columns of the 8×8 mask."""
    rows, cols = set(), set()
    for index in range(64):
        if not (mask & (1 << index)):
            continue
        row, col = divmod(index, 8)
        if col_lo <= col <= col_hi:
            rows.add(row)
            cols.add(col)
    return bool(cols) and len(cols) <= 3 and len(rows) >= 4


def _blob_change(mask, blocks):
    """Canvas regions change in two dimensions: multiple rows and columns."""
    lit_rows = {row for row, col in blocks if mask & (1 << _bit(row, col))}
    lit_cols = {col for row, col in blocks if mask & (1 << _bit(row, col))}
    return len(lit_rows) >= 2 and len(lit_cols) >= 2


def _uniform_heights(heights):
    if not heights:
        return False
    mean = sum(heights) / len(heights)
    if mean <= 0:
        return False
    var = sum((height - mean) ** 2 for height in heights) / len(heights)
    return math.sqrt(var) / mean <= 0.35


def tag_regions(boxes, mask=0, focus_app=None):
    """Tag each OCR box as chat, canvas, or toolbar.

    Heuristics, in priority order:
      toolbar — short boxes in the top/bottom 12% (static strips; mask usually dark there)
      chat    — a side column of uniform line-height, often a scrolling mask column,
                stronger when the frontmost app looks like a messenger
      canvas  — the rest, especially boxes sitting on a 2D change blob
    """
    tagged = [dict(box) for box in boxes or []]
    if not tagged:
        return tagged
    try:
        mask = int(mask or 0)
    except (TypeError, ValueError):
        mask = 0
    chatty = bool(focus_app and CHAT_APP.search(str(focus_app)))
    chat_ids = set()
    for _side, inside, col_lo, col_hi in (
        ("left", lambda cx: cx < CHAT_X, 0, 2),
        ("right", lambda cx: cx > 1 - CHAT_X, 5, 7),
    ):
        group = [i for i, box in enumerate(tagged) if inside(box["x"] + box["w"] / 2)]
        columnar = _columnar_change(mask, col_lo, col_hi) if mask else False
        heights = [tagged[i]["h"] for i in group]
        stacked = len(group) >= MIN_CHAT_STACK and _uniform_heights(heights)
        hinted = (chatty or columnar) and len(group) >= 2 and _uniform_heights(heights)
        if stacked or hinted or (columnar and chatty and group):
            chat_ids.update(group)

    for index, box in enumerate(tagged):
        y0, height = box["y"], box["h"]
        y1 = y0 + height
        if height <= SHORT_H and (y0 <= TOOLBAR_BAND or y1 >= 1 - TOOLBAR_BAND):
            box["region"] = "toolbar"
        elif index in chat_ids:
            box["region"] = "chat"
        else:
            box["region"] = "canvas"
            if mask and _blob_change(mask, _box_blocks(box)):
                box["region"] = "canvas"
    return tagged


def _mask_at(index, when):
    if index is None:
        return 0, None
    app = index.app_at(when)
    snapped = index.snap(when) if hasattr(index, "snap") else None
    if snapped is not None:
        return snapped.mask, app
    for moment in index.moments:
        if moment.start <= when <= moment.end:
            return moment.mask, app
    return 0, app


def _ocr_frame(path):
    try:
        result = subprocess.run(
            [OCR_BIN, path, "--languages", "en-US,ar"],
            capture_output=True, text=True,
        )
    except OSError as error:
        raise SystemExit(f"could not run the Vision OCR helper: {error}") from None
    if result.returncode != 0:
        detail = (result.stderr or "").strip() or "OCR helper returned an error"
        raise SystemExit(f"OCR failed for {path}: {detail}")
    try:
        rows = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as error:
        raise SystemExit(f"OCR returned invalid JSON for {path}: {error}") from None
    if not isinstance(rows, list):
        raise SystemExit(f"OCR returned an unexpected result for {path}")
    boxes = []
    for row in rows:
        obs = _ocr_observation(row)
        if obs is not None:
            boxes.append(obs)
    return {"text": _normalise_text(" ".join(box["text"] for box in boxes)), "boxes": boxes}


def _ocr_record(media, token, duration, frames):
    times = sorted(frames)
    end = min(duration, times[-1] + OCR_SAMPLE_INTERVAL)
    return {
        "version": OCR_INDEX_VERSION,
        "media": media,
        "source_token": token,
        "source_duration": round(duration, 3),
        "sample_interval": OCR_SAMPLE_INTERVAL,
        "coverage": {
            "start": times[0], "end": round(end, 3), "samples": len(times),
        },
        "frames": {str(second): _frame_entry(value) for second, value in frames.items()},
    }


def _parse_ocr_frames(data):
    frames = data.get("frames")
    if not isinstance(frames, dict) or not frames:
        return None, "incomplete OCR index: frames are missing"
    parsed = {}
    for raw_second, value in frames.items():
        if not isinstance(raw_second, str) or not re.fullmatch(r"\d+", raw_second):
            return None, "incomplete OCR index: frame times are not integer seconds"
        second = int(raw_second)
        if isinstance(value, str):
            return None, "incomplete OCR index: frame text is malformed"
        if not isinstance(value, dict) or not isinstance(value.get("text"), str):
            return None, "incomplete OCR index: frame text is malformed"
        boxes = _parse_boxes(value.get("boxes"))
        if boxes is None:
            return None, "incomplete OCR index: frame boxes are malformed"
        parsed[second] = {"text": _normalise_text(value["text"]), "boxes": boxes}
    if len(parsed) != len(frames):
        return None, "incomplete OCR index: frame times are duplicated"
    return parsed, None


def _validate_ocr_record(data, media, token, duration):
    if not isinstance(data, dict) or data.get("version") != OCR_INDEX_VERSION:
        return None, "untrusted legacy OCR index: verified metadata is missing"
    if _ocr_source_path(data) != media:
        return None, "OCR index source path does not match the requested media"
    if _ocr_source_token(data) != token:
        return None, "stale OCR index: source fingerprint does not match the media"

    try:
        indexed_duration = float(data.get("source_duration"))
        interval = float(data.get("sample_interval"))
    except (TypeError, ValueError):
        return None, "incomplete OCR index: duration or sample interval is missing"
    if (not math.isfinite(indexed_duration) or indexed_duration <= 0
            or not math.isfinite(interval) or interval <= 0):
        return None, "incomplete OCR index: duration or sample interval is invalid"
    if abs(interval - OCR_SAMPLE_INTERVAL) > 1e-9:
        return None, f"unsupported OCR sample interval {interval:g}s; refresh it"
    if abs(indexed_duration - duration) > max(0.5, interval / 2):
        return None, (f"stale OCR index: indexed duration {indexed_duration:.3f}s differs "
                      f"from source duration {duration:.3f}s")

    frames, reason = _parse_ocr_frames(data)
    if reason:
        return None, reason
    times = sorted(frames)
    expected = _expected_samples(duration, interval)
    if times[0] > interval / 2:
        return None, f"incomplete OCR coverage: starts at {times[0]}s instead of 0s"
    if len(times) < expected:
        return None, (f"incomplete OCR coverage: {len(times)} samples for "
                      f"{duration:.3f}s source (expected at least {expected})")
    if any(right - left > interval * 1.5 for left, right in pairwise(times)):
        return None, "incomplete OCR coverage: sampled seconds contain a gap"
    actual_end = min(duration, times[-1] + interval)
    if actual_end < duration - max(0.25, interval / 2):
        return None, (f"incomplete OCR coverage: ends at {actual_end:.3f}s for "
                      f"{duration:.3f}s source")

    coverage = data.get("coverage")
    if not isinstance(coverage, dict):
        return None, "incomplete OCR index: coverage metadata is missing"
    try:
        coverage_start = float(coverage.get("start"))
        coverage_end = float(coverage.get("end"))
        coverage_samples = int(coverage.get("samples"))
    except (TypeError, ValueError):
        return None, "incomplete OCR index: coverage metadata is invalid"
    if (not math.isfinite(coverage_start) or not math.isfinite(coverage_end)
            or coverage_samples != len(times)):
        return None, "incomplete OCR index: coverage metadata does not describe its frames"
    if coverage_start > interval / 2 or coverage_end < actual_end - 0.01:
        return None, "incomplete OCR coverage: metadata does not reach the source end"
    return frames, None


def build_ocr_index(media, cache_dir=None):
    """Build a source-bound 1 fps OCR index with complete duration coverage."""
    media = canonical_media(media)
    token = source_token(media)
    duration = _probe_duration(media)
    expected = _expected_samples(duration)
    if not os.path.isfile(OCR_BIN) or not os.access(OCR_BIN, os.X_OK):
        raise SystemExit(
            "the OCR helper is not built. Run:\n"
            "  swiftc -O -o tools/vision/ocr tools/vision/ocr.swift")

    with tempfile.TemporaryDirectory(prefix="capcutctl-ocr-") as tmp:
        pattern = os.path.join(tmp, "frame-%06d.jpg")
        try:
            result = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", media,
                 "-vf", "fps=1:start_time=0:eof_action=pass,scale=810:-2", "-frames:v", str(expected),
                 "-q:v", "3", pattern],
                capture_output=True, text=True,
            )
        except OSError as error:
            raise SystemExit(f"could not run ffmpeg for the OCR index: {error}") from None
        if result.returncode != 0:
            detail = (result.stderr or "").strip() or "ffmpeg returned an error"
            raise SystemExit(f"could not extract frames for OCR: {detail}")

        frames = {}
        for second in range(expected):
            frame = os.path.join(tmp, f"frame-{second + 1:06d}.jpg")
            if not os.path.isfile(frame):
                raise SystemExit(
                    f"OCR frame extraction stopped at {second}s of {duration:.3f}s; "
                    "rerun with --refresh after checking the source")
            frames[second] = _ocr_frame(frame)

    index, _reason = optional_change_index(media, change_index.MIN_SCORE)
    for second, entry in frames.items():
        mask, app = _mask_at(index, float(second))
        entry["boxes"] = tag_regions(entry.get("boxes") or [], mask=mask, focus_app=app)
        entry["text"] = _normalise_text(
            entry.get("text") or " ".join(box["text"] for box in entry["boxes"]))

    if source_token(media) != token:
        raise SystemExit("media changed while its OCR index was being built; rerun --refresh")
    record = _ocr_record(media, token, duration, frames)
    checked, reason = _validate_ocr_record(record, media, token, duration)
    if reason:
        raise SystemExit(f"new OCR index failed validation: {reason}")
    destination = ocr_cache_path(media, token, cache_dir)
    os.makedirs(destination.parent, exist_ok=True)
    _write_json_atomic(str(destination), record)
    print(f"  OCR index: wrote {destination} ({len(checked)} samples)", file=sys.stderr)
    return record


def load_ocr_record(media, refresh=False, cache_dir=None):
    media = canonical_media(media)
    if refresh:
        record = build_ocr_index(media, cache_dir)
        frames, reason = _parse_ocr_frames(record)
        if reason:
            raise SystemExit(f"new OCR index failed validation: {reason}")
        return frames, record

    token = source_token(media)
    directory = _cache_dir(cache_dir)
    stem = Path(media).stem
    problems = []
    for path in _cache_files(directory, ".ocr"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            if path.name == f"{stem}.ocr.json" or path.name.startswith(f"{stem}.ocr-"):
                problems.append(f"{path.name} is unreadable; refresh it")
            continue
        source_path = _ocr_source_path(data) if isinstance(data, dict) else None
        if source_path is None:
            if path.name == f"{stem}.ocr.json" or path.name.startswith(f"{stem}.ocr-"):
                problems.append(f"{path.name} is an untrusted legacy OCR cache")
            continue
        if source_path != media:
            continue
        stored_token = _ocr_source_token(data)
        if data.get("version") != OCR_INDEX_VERSION or stored_token is None:
            problems.append(f"{path.name} is an untrusted legacy OCR cache")
            continue
        if stored_token != token:
            problems.append(f"{path.name} is stale for this source fingerprint")
            continue
        duration = _probe_duration(media)
        frames, reason = _validate_ocr_record(data, media, token, duration)
        if reason:
            problems.append(f"{path.name}: {reason}")
            continue
        return frames, data

    detail = f" {problems[0]}." if problems else ""
    raise SystemExit(
        f"no verified OCR index for {media}.{detail} "
        "Run `capcutctl find ... --media FILE --shows --refresh`."
    )


def load_ocr(media, refresh=False, cache_dir=None):
    frames, _record = load_ocr_record(media, refresh=refresh, cache_dir=cache_dir)
    return {second: _frame_text(entry) for second, entry in frames.items()}


def ocr_boxes(media, t, refresh=False, cache_dir=None, region=None):
    """Per-word OCR boxes for the 1 fps sample covering source time *t*.

    Origin is top-left, coordinates normalised 0..1, matching tools/vision/ocr.swift.
    ``t=10.7`` looks up the sample at 10s. Returns [] when that second has no boxes.
    ``region`` of chat|canvas|toolbar filters; None/"any" returns every box (F01).
    """
    if not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0:
        return []
    frames, _record = load_ocr_record(media, refresh=refresh, cache_dir=cache_dir)
    boxes = list(_frame_boxes(frames.get(int(t))))
    wanted = None if region in (None, "", "any") else str(region)
    if wanted:
        boxes = [box for box in boxes if box.get("region") == wanted]
    return boxes


def moments_cache_path(media, token=None, cache_dir=None):
    media = canonical_media(media)
    token = token or source_token(media)
    return Path(_cache_dir(cache_dir)) / (
        f"{Path(media).stem}.moments-{_source_cache_key(media, token)}.json")


def _moment_times(index):
    return [round(moment.start, 3) for moment in index.moments]


def _extract_frame_at(media, when, destination):
    """One frame at a source time, scaled the same way the 1 fps grid is.

    Input seeking, so a 40-minute source does not get decoded from the top once per moment.
    ffmpeg still decodes forward from the preceding keyframe, so the frame is the one at the
    requested time and not the keyframe itself.
    """
    try:
        result = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{when:.3f}", "-i", media,
             "-frames:v", "1", "-vf", "scale=810:-2", "-q:v", "3", "-y", destination],
            capture_output=True, text=True,
        )
    except OSError as error:
        raise SystemExit(f"could not run ffmpeg for the moment index: {error}") from None
    if result.returncode != 0 or not os.path.isfile(destination):
        detail = (result.stderr or "").strip() or "ffmpeg returned an error"
        raise SystemExit(f"could not extract the frame at {when:.3f}s: {detail}")


def build_moment_index(media, index, cache_dir=None):
    """OCR exactly one frame at the head of every change moment.

    This is the whole point of the prefilter: a 22-minute take is 1327 samples on the 1 fps
    grid and 86 here, and each of these lands on the frame the change happened rather than
    on whichever whole second the grid happened to tick.
    """
    media = canonical_media(media)
    token = source_token(media)
    if not os.path.isfile(OCR_BIN) or not os.access(OCR_BIN, os.X_OK):
        raise SystemExit(
            "the OCR helper is not built. Run:\n"
            "  swiftc -O -o tools/vision/ocr tools/vision/ocr.swift")

    samples = {}
    with tempfile.TemporaryDirectory(prefix="capcutctl-moments-") as tmp:
        for position, moment in enumerate(index.moments):
            frame = os.path.join(tmp, f"m{position:05d}.jpg")
            _extract_frame_at(media, moment.start, frame)
            entry = _frame_entry(_ocr_frame(frame))
            entry["boxes"] = tag_regions(
                entry.get("boxes") or [], mask=moment.mask, focus_app=index.app_at(moment.start))
            samples[f"{moment.start:.3f}"] = _frame_entry(entry)

    if source_token(media) != token:
        raise SystemExit("media changed while its moment index was being built; rerun --refresh")
    record = {
        "version": MOMENT_INDEX_VERSION,
        "media": media,
        "source_token": token,
        "source_duration": round(index.duration, 3),
        "min_score": index.min_score,
        "merge_gap": index.merge_gap,
        "moments": _moment_times(index),
        "samples": samples,
    }
    destination = moments_cache_path(media, token, cache_dir)
    os.makedirs(destination.parent, exist_ok=True)
    _write_json_atomic(str(destination), record)
    print(f"  moment index: wrote {destination} ({len(samples)} samples)", file=sys.stderr)
    return record


def _validate_moment_record(data, media, token, index):
    """Same contract as the OCR index: bound to one source, and complete for it.

    The moment list is part of the fingerprint. Change --min-score and the cached samples
    describe a different set of moments, so they are refused rather than partially reused.
    """
    if not isinstance(data, dict) or data.get("version") != MOMENT_INDEX_VERSION:
        return None, "untrusted legacy moment index"
    if _ocr_source_path(data) != media:
        return None, "moment index source path does not match the requested media"
    if _ocr_source_token(data) != token:
        return None, "stale moment index: source fingerprint does not match the media"
    try:
        if abs(float(data.get("min_score")) - index.min_score) > 1e-9:
            return None, "moment index was built at a different --min-score; refresh it"
        if abs(float(data.get("merge_gap")) - index.merge_gap) > 1e-9:
            return None, "moment index was built at a different merge gap; refresh it"
    except (TypeError, ValueError):
        return None, "incomplete moment index: threshold metadata is missing"
    if data.get("moments") != _moment_times(index):
        return None, "stale moment index: the sidecar now describes different moments"
    samples = data.get("samples")
    if not isinstance(samples, dict):
        return None, "incomplete moment index: samples are missing"
    parsed = {}
    for moment in index.moments:
        key = f"{moment.start:.3f}"
        value = samples.get(key)
        if isinstance(value, str):
            return None, f"incomplete moment index: no sample for {key}s"
        if not isinstance(value, dict) or not isinstance(value.get("text"), str):
            return None, f"incomplete moment index: no sample for {key}s"
        boxes = _parse_boxes(value.get("boxes"))
        if boxes is None:
            return None, f"incomplete moment index: boxes for {key}s are malformed"
        parsed[moment.start] = {"text": _normalise_text(value["text"]), "boxes": boxes}
    return parsed, None


def load_moment_record(media, index, refresh=False, cache_dir=None):
    media = canonical_media(media)
    token = source_token(media)
    if not refresh:
        path = moments_cache_path(media, token, cache_dir)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            data = None
        if data is not None:
            samples, reason = _validate_moment_record(data, media, token, index)
            if samples is not None:
                return samples
            print(f"  moment index: rebuilding — {reason}", file=sys.stderr)
    record = build_moment_index(media, index, cache_dir)
    samples, reason = _validate_moment_record(record, media, token, index)
    if reason:
        raise SystemExit(f"new moment index failed validation: {reason}")
    return samples


def load_transcript(media):
    media = canonical_media(media)
    token = source_token(media)
    stem = Path(media).stem
    problems = []
    for path in _cache_files(_cache_dir(), ".whisper"):
        if not path.name.startswith(stem):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            problems.append(f"{path.name} is unreadable")
            continue
        if not isinstance(data, dict):
            problems.append(f"{path.name} is malformed")
            continue
        stored_path = _ocr_source_path(data)
        if stored_path is not None and stored_path != media:
            continue
        stored_token = _transcript_source_token(data)
        if stored_token is None:
            problems.append(f"{path.name} has no verified source fingerprint")
            continue
        if stored_token == token:
            if not isinstance(data.get("segments"), list):
                problems.append(f"{path.name} has no usable segments")
                continue
            return data
        problems.append(f"{path.name} is stale for this source fingerprint")
    legacy = Path(_cache_dir()) / f"{stem.split('-')[0]}_transcript_ar.json"
    if legacy.exists():
        problems.append(f"{legacy.name} is an untrusted legacy transcript cache")
    detail = f" {problems[0]}." if problems else ""
    raise SystemExit(
        f"no verified transcript for {media}.{detail} "
        f"Run `capcutctl cut {media}` first."
    )


def optional_change_index(media, min_score):
    """(index, reason) for a take that may not be an rl2 take at all.

    Looks for the sidecar directory before probing, so a plain recording — which is most of
    them — costs an `is_file` and not an ffprobe on every `--shows` search.
    """
    if change_index.sidecar_dir(media) is None:
        return None, "no rl2 sidecar next to this media"
    return change_index.load(media, _probe_duration(media), min_score=min_score)


def require_change_index(media, min_score):
    """The take's change index, or a SystemExit naming why there isn't one."""
    index, reason = optional_change_index(media, min_score)
    if index is None:
        raise SystemExit(
            f"no change index for {os.path.basename(media)}: {reason}. "
            "--moments reads an rl2 take's own sidecars; search a plain recording with --shows."
        )
    if not index.moments:
        raise SystemExit(
            f"{os.path.basename(media)} has no moment above --min-score {min_score:g}; "
            "nothing on screen changed that much."
        )
    return index


def _in_focus(index, when, app):
    """Was `app` frontmost at this source time? True for everything when no app is asked for."""
    if not app:
        return True
    front = index.app_at(when)
    return bool(front) and app.lower() in front.lower()


def _contact_sheet(options, picks):
    """Grab a frame per reported hit and tile them, because OCR matches text it cannot see."""
    if not options.strip or not picks:
        return
    from frame_qa import contact_sheet, extract_frame
    out = os.path.abspath(options.strip)
    # Keep every extraction's intermediate images in a private per-invocation directory.
    # The old shared /tmp/capcutctl-find/f{second}.png let concurrent searches overwrite
    # one another and gave a local symlink a predictable write target.
    with tempfile.TemporaryDirectory(prefix="capcutctl-find-") as tmp:
        tiles = []
        for position, (at, label) in enumerate(picks[:12]):
            frame = os.path.join(tmp, f"f{position:03d}.png")
            sample = extract_frame(options.media, at)
            sample.image.convert("RGB").save(frame)
            retry = "  re-extracted accurately" if sample.reextracted else ""
            print(
                f"  frame {at:g}s requested PTS {sample.requested_pts:.6f}s "
                f"delivered PTS {sample.delivered_pts:.6f}s "
                f"drift {sample.drift:.6f}s ({sample.method}){retry}"
            )
            tiles.append((frame, label))
        print(f"\n  -> {contact_sheet(tiles, out)}")
    print("     OCR sees text it cannot see is occluded. Check the frames before you cut.")


def collapse(hits, gap=3):
    runs = []
    for t in sorted(hits):
        if runs and t - runs[-1][1] <= gap:
            runs[-1][1] = t
        else:
            runs.append([t, t])
    return runs


def _query_is_action(terms, kind):
    if kind == "action":
        return True
    return any(term in ACTION_VERBS for term in terms)


def _boxes_for_terms(boxes, terms):
    matched = [box for box in boxes or []
               if any(term in (box.get("text") or "").lower() for term in terms)]
    return matched or list(boxes or [])


def _region_ok(entry, terms, region="any", action=False):
    """True when this frame's OCR should count as a hit under region/action filters.

    Default region=any and action=False keep the joined-text --shows behaviour.
    """
    if not all(term in _frame_text(entry) for term in terms):
        return False
    boxes = _frame_boxes(entry)
    matching = _boxes_for_terms(boxes, terms)
    if region not in (None, "", "any"):
        matching = [box for box in matching if box.get("region") == region]
        if not matching:
            return False
    if action:
        regions = {box.get("region") for box in matching}
        if regions and regions <= {"chat"}:
            return False
    return True


def main():
    ap = argparse.ArgumentParser(prog="capcutctl find")
    ap.add_argument("query", nargs="?",
                    help="text to look for (case-insensitive, all words must appear); "
                         "optional with --moments, which lists them all when it is omitted")
    ap.add_argument("--media", required=True)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--shows", action="store_true", help="search the OCR index (screen recording)")
    mode.add_argument("--says", action="store_true", help="search the transcript (talking head)")
    mode.add_argument("--moments", action="store_true",
                      help="use the rl2 change signal: list what happened, or OCR one frame "
                           "per moment to search only those")
    ap.add_argument("--focus", metavar="APP",
                    help="only report while APP was frontmost (multi-window takes; "
                         "needs the rl2 trace sidecar)")
    ap.add_argument("--min-score", type=float, default=change_index.MIN_SCORE,
                    help="mean absolute luma delta a frame must reach to be a moment "
                         f"(default {change_index.MIN_SCORE})")
    ap.add_argument("--refresh", action="store_true",
                    help="build or replace a verified OCR index before a --shows search")
    ap.add_argument("--boxes", action="store_true",
                    help="print per-word OCR geometry (top-left, normalised 0..1) for each hit")
    ap.add_argument("--region", choices=["chat", "canvas", "toolbar", "any"], default="any",
                    help="restrict --shows/--moments to boxes in that region (default any, "
                         "output unchanged). toolbar = static top/bottom strips; chat = a side "
                         "column of uniform line-height (often a scrolling mask column); "
                         "canvas = the changing 2D app surface. Uses box clusters, the 8x8 "
                         "change-mask, and the frontmost app when an rl2 trace is present.")
    ap.add_argument("--kind", choices=["action", "any"], default="any",
                    help="action queries prefer canvas/toolbar hits (the thing on screen) over "
                         "chat that only describes it. Implied when the query contains a verb "
                         "like click/tap/hit/open.")
    ap.add_argument("--settle", type=float, default=2.0,
                    help="seconds a run must persist before its start is reported as stable")
    ap.add_argument("--context", action="store_true", help="print the matching line(s)")
    ap.add_argument("--strip", nargs="?", const="find-strip.png", default=None,
                    help="grab a frame at each run and write a contact sheet — OCR matches text "
                         "that can be occluded or scrolled off, so LOOK before you cut")
    a = ap.parse_args()
    if not (a.shows or a.says or a.moments):
        a.shows = True
    if a.refresh and a.says:
        raise SystemExit("--refresh only applies to --shows; run `capcutctl cut` to refresh a transcript")
    if a.focus and a.says:
        raise SystemExit("--focus reads the rl2 window trace, which a transcript search has no use for")
    if a.boxes and a.says:
        raise SystemExit("--boxes reads the OCR index; it does not apply to --says")
    if a.says and (a.region != "any" or a.kind != "any"):
        raise SystemExit("--region and --kind read the OCR index; they do not apply to --says")
    terms = [w for w in (a.query or "").lower().split() if w]
    if not terms and not a.moments:
        ap.error("query must contain at least one word")
    if not math.isfinite(a.settle) or a.settle < 0:
        ap.error("--settle must be finite and nonnegative")
    if not math.isfinite(a.min_score) or a.min_score < 0:
        ap.error("--min-score must be finite and nonnegative")
    action = _query_is_action(terms, a.kind)

    if a.says:
        tr = load_transcript(a.media)
        rows = []
        for seg in tr.get("segments", []):
            words = seg.get("words") or []
            texts = [(w.get("word") or w.get("text") or "").strip() for w in words]
            lowers = [t.lower() for t in texts]
            n = len(terms)
            for i in range(len(lowers)):
                window = " ".join(lowers[i:i + n])
                if window == " ".join(terms) or (n == 1 and terms[0] in lowers[i]):
                    rows.append((round(words[i]["start"], 2), " ".join(texts[i:i + n]), seg["text"].strip()))
                    break
            else:
                if not words and all(t in (seg.get("text") or "").lower() for t in terms):
                    rows.append((round(seg.get("start") or 0, 2), "(segment)", (seg.get("text") or "").strip()))
        print(f"{len(rows)} spoken match(es) in {os.path.basename(a.media)}")
        for t, word, line in rows[:40]:
            print(f"  {t:8.2f}s  {word}" + (f"   — {line[:70]}" if a.context else ""))
        return

    if a.moments:
        index = require_change_index(a.media, a.min_score)
        chosen = [m for m in index.moments if _in_focus(index, m.start, a.focus)]
        where = f" while {a.focus} was frontmost" if a.focus else ""
        picks = []
        samples = None
        if terms or a.boxes:
            samples = load_moment_record(a.media, index, refresh=a.refresh)
        if terms:
            chosen = [m for m in chosen
                      if _region_ok(samples.get(m.start), terms, region=a.region, action=action)]
            print(f"{len(chosen)} moment(s) showing it in {os.path.basename(a.media)}{where}")
        else:
            covered = sum(m.end - m.start for m in chosen)
            print(f"{len(chosen)} moment(s) in {os.path.basename(a.media)}{where}  "
                  f"({covered:.0f}s of {index.duration:.0f}s, "
                  f"{index.frames} frames indexed)")
        if not chosen and a.focus:
            # The app name has to match what the trace recorded, which is the process name
            # and not always what the Dock calls it. Say what is actually in there.
            known = ", ".join(index.apps()) or "nothing — this take has no window trace"
            print(f"  frontmost in this take: {known}")
        for moment in chosen[:40]:
            app = index.app_at(moment.start)
            held = moment.end - moment.start
            tail = f"  [{app}]" if app and not a.focus else ""
            print(f"  {moment.start:8.2f}s -> {moment.end:8.2f}s   held {held:5.2f}s  "
                  f"peak {moment.peak:6.1f}  blocks {moment.blocks:2d}{tail}")
            if a.context and terms:
                line = re.sub(r"\s+", " ", _frame_text(samples.get(moment.start)))
                print(f"           {line[:100]}")
            if a.boxes:
                printed = _frame_boxes(samples.get(moment.start) if samples else None)
                if a.region not in (None, "", "any"):
                    printed = [box for box in printed if box.get("region") == a.region]
                _print_boxes(printed)
            picks.append((moment.start, f"{moment.start:.2f}s"))
        if len(chosen) > 40:
            print(f"  ... {len(chosen) - 40} more")
        _contact_sheet(a, picks)
        return

    idx, _record = load_ocr_record(a.media, refresh=a.refresh)
    index, reason = optional_change_index(a.media, a.min_score)
    if a.focus and index is None:
        raise SystemExit(f"--focus needs the rl2 trace for {os.path.basename(a.media)}: {reason}")
    hits = [t for t in idx if _region_ok(idx[t], terms, region=a.region, action=action)]
    runs = collapse(hits)
    picks = []
    print(f"{len(runs)} run(s) on screen in {os.path.basename(a.media)}  "
          f"(index {min(idx)}-{max(idx)}s)")
    for lo, hi in runs[:25]:
        stable = next((t for t in range(lo, hi + 1)
                       if all(_region_ok(idx.get(t + k), terms, region=a.region, action=action)
                              for k in range(math.ceil(a.settle)))), None)
        if stable is None:
            continue
        if index is not None and not _in_focus(index, stable, a.focus):
            continue
        held = hi - lo + 1
        mark = "" if stable == lo else f"  (flickers from {lo}s)"
        # The grid can only ever name the second it sampled. When the sidecar has a moment
        # inside that second, that frame is when the text actually arrived, and cutting to
        # the rounded second lands early on a screen that has not painted yet.
        edge = index.snap(stable) if index is not None else None
        at = edge.start if edge is not None else float(stable)
        mark += f"  (changed at {edge.start:.2f}s)" if edge is not None else ""
        print(f"  {stable:6d}s -> {hi:6d}s   held {held:4d}s{mark}")
        if a.context:
            line = re.sub(r"\s+", " ", _frame_text(idx.get(stable, "")))
            print(f"           {line[:100]}")
        if a.boxes:
            _print_boxes(ocr_boxes(a.media, stable, region=None if a.region == "any" else a.region))
        picks.append((at, f"{stable}s ({held}s)"))

    _contact_sheet(a, picks)

if __name__ == "__main__":
    main()
