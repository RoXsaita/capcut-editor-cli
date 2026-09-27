"""Fast, fail-open caption layout helpers.

The layout pass is a single captioned-grid review after 20/50 scene placement. It is not a second caption product and it does not seed 34%.
"""

from __future__ import annotations

import json
import math
import os
import re
from bisect import bisect_right
from statistics import median
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont, ImageOps

DEFAULT_LAYOUT_POSITION = 34
ALLOWED_LAYOUT_POSITIONS = (5, 10, 20, 28, 34, 42, 50, 55, 60, 85)
MIN_LAYOUT_POSITION = 5
MAX_LAYOUT_POSITION = 85
# Vision timestamps are rounded to storyboard labels; allow a 50 ms tolerance
# around the nominal ~0.75s sustained-interval rule.
MIN_OVERRIDE_DURATION = 0.70
MAX_LAYOUT_OVERRIDES = 8
DEFAULT_GRID_FRAMES = 32
DEFAULT_GRID_COLUMNS = 8
DEFAULT_GRID_TILE_WIDTH = 200
CAPTION_FACE_GUARD_HALF_HEIGHT = 0.035
# Vision's face rectangle excludes much of the forehead/hair. Expand it into a
# conservative head-safety rectangle before accepting a caption anchor.
CAPTION_FACE_GUARD_HEAD_MARGIN = 0.20
# Keep a real chin/neck buffer without treating the subject's entire torso as
# face geometry. A 20% fixed-frame margin forced otherwise-safe captions into
# the bottom 5% social-UI zone.
CAPTION_FACE_GUARD_CHIN_MARGIN = 0.07
FULL_SCREEN_CAPTION_POSITION = 20
SPLIT_SCREEN_CAPTION_POSITION = 50
SPLIT_SCREEN_FACE_BOTTOM_THRESHOLD = 0.15


def choose_face_safe_position(
    faces: list[dict],
    *,
    preferred_position: int = DEFAULT_LAYOUT_POSITION,
    allowed_positions: Iterable[int] | None = None,
    caption_half_height: float = CAPTION_FACE_GUARD_HALF_HEIGHT,
    head_margin: float = CAPTION_FACE_GUARD_HEAD_MARGIN,
    chin_margin: float = CAPTION_FACE_GUARD_CHIN_MARGIN,
) -> int:
    """Choose the nearest vertical anchor whose caption band misses every face."""
    candidates = tuple(sorted({int(item) for item in (allowed_positions or ALLOWED_LAYOUT_POSITIONS)}))
    preferred = min(candidates, key=lambda item: abs(item - int(preferred_position)))
    if not faces:
        return preferred

    face_ranges: list[tuple[float, float]] = []
    for face in faces:
        y = _finite_float(face.get("y"))
        h = _finite_float(face.get("h"))
        if y is None or h is None or h <= 0:
            continue
        face_ranges.append(
            (
                max(0.0, y - chin_margin),
                min(1.0, y + h + head_margin),
            )
        )
    if not face_ranges:
        return preferred

    def caption_range(position: int) -> tuple[float, float]:
        return (
            (position / 100.0) - caption_half_height,
            (position / 100.0) + caption_half_height,
        )

    def is_safe(position: int) -> bool:
        caption_low, caption_high = caption_range(position)
        return all(
            not (caption_high > face_low and caption_low < face_high)
            for face_low, face_high in face_ranges
        )

    safe = [item for item in candidates if is_safe(item)]
    if preferred in safe:
        return preferred
    if safe:
        lowest_face = min(item[0] for item in face_ranges)
        highest_face = max(item[1] for item in face_ranges)
        above = [item for item in safe if caption_range(item)[0] >= highest_face]
        below = [item for item in safe if caption_range(item)[1] <= lowest_face]
        if above and not below:
            return min(above)
        if below and not above:
            return max(below)
        if above and below:
            nearest_edges = (min(above), max(below))
            return min(nearest_edges, key=lambda item: (abs(item - preferred), item))
        return min(safe, key=lambda item: (abs(item - preferred), item < 20, item))
    raw_centers = []
    for face in faces:
        y = _finite_float(face.get("y"))
        h = _finite_float(face.get("h"))
        if y is not None and h is not None and h > 0:
            raw_centers.append(y + (h / 2.0))
    if raw_centers:
        # When the conservative head rectangle spans every anchor, use the edge
        # opposite the face's vertical center instead of falling back onto it.
        return max(candidates) if (sum(raw_centers) / len(raw_centers)) <= 0.35 else min(candidates)
    return preferred


def build_face_safe_overrides(
    frame_entries: list[dict],
    faces_by_path: dict[str, list[dict]],
    *,
    duration: float,
    preferred_position: int = DEFAULT_LAYOUT_POSITION,
    allowed_positions: Iterable[int] | None = None,
) -> list[dict]:
    """Convert sampled Apple Vision face boxes into sparse scene intervals."""
    entries = sorted(frame_entries, key=lambda item: float(item["timestamp"]))
    if not entries:
        return []
    dur = max(0.0, float(duration))
    timestamps = [max(0.0, min(dur, float(item["timestamp"]))) for item in entries]
    boundaries = [0.0]
    boundaries.extend((timestamps[idx - 1] + timestamps[idx]) / 2.0 for idx in range(1, len(timestamps)))
    boundaries.append(dur)

    targets: list[int | None] = []
    for entry in entries:
        path = str(entry["path"])
        faces = faces_by_path.get(path)
        if faces is None:
            faces = faces_by_path.get(str(Path(path).resolve()))
        if faces is None:
            faces = faces_by_path.get(Path(path).name, [])
        if not faces:
            targets.append(None)
            continue
        target = choose_face_safe_position(
            faces,
            preferred_position=preferred_position,
            allowed_positions=allowed_positions,
        )
        targets.append(None if target == preferred_position else target)

    for idx in range(1, len(targets) - 1):
        if targets[idx] is None and targets[idx - 1] is not None and targets[idx - 1] == targets[idx + 1]:
            targets[idx] = targets[idx - 1]

    intervals: list[dict] = []
    for idx, target in enumerate(targets):
        if target is None:
            continue
        start = round(boundaries[idx], 3)
        end = round(boundaries[idx + 1], 3)
        if intervals and intervals[-1]["position"] == target and abs(intervals[-1]["end"] - start) <= 0.002:
            intervals[-1]["end"] = end
            continue
        intervals.append(
            {
                "start": start,
                "end": end,
                "position": target,
                "reason": "deterministic_face_guard",
                "confidence": 1.0,
                "position_source": "auto",
            }
        )
    return intervals


def _faces_for_entry(entry: dict, faces_by_path: dict[str, list[dict]]) -> list[dict]:
    path = str(entry["path"])
    faces = faces_by_path.get(path)
    if faces is None:
        faces = faces_by_path.get(str(Path(path).resolve()))
    if faces is None:
        faces = faces_by_path.get(Path(path).name, [])
    return faces


def choose_scene_caption_preset(faces: list[dict]) -> int:
    """Map Suheil's two recurring compositions to their approved anchors."""
    if not faces:
        return FULL_SCREEN_CAPTION_POSITION
    primary = max(
        faces,
        key=lambda face: float(face.get("w", 1.0)) * float(face.get("h", 0.0)),
    )
    if float(primary.get("y", 0.0)) <= SPLIT_SCREEN_FACE_BOTTOM_THRESHOLD:
        return SPLIT_SCREEN_CAPTION_POSITION
    return FULL_SCREEN_CAPTION_POSITION


def detect_scene_boundaries(video_path: str | Path) -> list[float]:
    """Find visual cuts independently of face detection and spoken words."""
    result = subprocess.run(
        [_ffmpeg_bin(), "-hide_banner", "-i", str(video_path), "-vf",
         "scale=160:-2,select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"],
        capture_output=True, text=True, timeout=120, check=True,
    )
    cuts: list[float] = []
    for raw in re.findall(r"pts_time:([0-9.]+)", result.stderr):
        value = float(raw)
        # Flashes/fades generate adjacent detections, not new caption scenes.
        if value > 0.25 and (not cuts or value - cuts[-1] >= 0.25):
            cuts.append(value)
    return cuts


def build_cue_preset_overrides(
    cues: list[dict],
    frame_entries: list[dict],
    faces_by_path: dict[str, list[dict]],
    *,
    scene_boundaries: list[float] | None = None,
) -> list[dict]:
    """Vote once per visual shot. A missing face is unknown, never split."""
    if len(cues) != len(frame_entries):
        raise ValueError("cue preset layout requires exactly one frame per cue")
    if not cues:
        return []
    primary = []
    for entry in frame_entries:
        faces = _faces_for_entry(entry, faces_by_path)
        primary.append(max(faces, key=lambda f: float(f.get("w", 1)) * float(f.get("h", 0))) if faces else None)
    cuts = sorted(set(scene_boundaries or []))
    if scene_boundaries is None:
        # Compatibility/failure fallback: only a large geometry change opens a
        # new composition. Missing detections and threshold jitter do not.
        previous = None
        for cue, face in zip(cues, primary):
            if face is None:
                continue
            if previous is not None and abs(float(face.get("y", 0)) - float(previous.get("y", 0))) > 0.12:
                cuts.append(float(cue["start"]))
            previous = face
    groups: dict[int, list[int]] = {}
    for idx, cue in enumerate(cues):
        midpoint = (float(cue["start"]) + float(cue["end"])) / 2
        groups.setdefault(bisect_right(cuts, midpoint), []).append(idx)
    intervals = []
    for scene_id, indices in groups.items():
        bottoms = [float(primary[i].get("y", 0)) for i in indices if primary[i] is not None]
        target = (SPLIT_SCREEN_CAPTION_POSITION if bottoms and median(bottoms) <= SPLIT_SCREEN_FACE_BOTTOM_THRESHOLD
                  else FULL_SCREEN_CAPTION_POSITION)
        start = cuts[scene_id - 1] if scene_id else 0.0
        end = cuts[scene_id] if scene_id < len(cuts) else max(float(c["end"]) for c in cues)
        intervals.append(dict(start=start, end=end, position=target,
                              reason="shot_locked_scene_layout", confidence=1.0 if bottoms else 0.0,
                              position_source="auto", scene_id=scene_id,
                              scene_start=start, scene_end=end))
    return intervals


def build_cue_face_safe_overrides(
    cues: list[dict],
    frame_entries: list[dict],
    faces_by_path: dict[str, list[dict]],
    *,
    preferred_position: int = DEFAULT_LAYOUT_POSITION,
    allowed_positions: Iterable[int] | None = None,
) -> list[dict]:
    """Build face-safe overrides from one exact midpoint frame per cue."""
    if len(cues) != len(frame_entries):
        raise ValueError("cue face guard requires exactly one frame per cue")
    targets: list[int | None] = []
    for cue, entry in zip(cues, frame_entries, strict=True):
        faces = _faces_for_entry(entry, faces_by_path)
        if not faces:
            targets.append(None)
            continue
        current_position = int(cue.get("position", preferred_position))
        targets.append(
            choose_face_safe_position(
                faces,
                preferred_position=current_position,
                allowed_positions=allowed_positions,
            )
        )

    # One isolated detector miss inside a stable run should not reopen the face.
    for idx in range(1, len(targets) - 1):
        if targets[idx] is None and targets[idx - 1] is not None and targets[idx - 1] == targets[idx + 1]:
            targets[idx] = targets[idx - 1]

    # Small head motion can alternate between adjacent safe anchors every word.
    # Keep each contiguous side-of-face run at the conservative anchor that was
    # safe for every cue: lowest below the face, highest above it.
    idx = 0
    while idx < len(targets):
        target = targets[idx]
        if target is None or target == preferred_position:
            idx += 1
            continue
        direction = -1 if target < preferred_position else 1
        end_idx = idx + 1
        while end_idx < len(targets):
            candidate = targets[end_idx]
            if candidate is None or candidate == preferred_position:
                break
            candidate_direction = -1 if candidate < preferred_position else 1
            if candidate_direction != direction:
                break
            end_idx += 1
        stable = min(item for item in targets[idx:end_idx] if item is not None) if direction < 0 else max(
            item for item in targets[idx:end_idx] if item is not None
        )
        targets[idx:end_idx] = [stable] * (end_idx - idx)
        idx = end_idx

    intervals: list[dict] = []
    for cue, target in zip(cues, targets, strict=True):
        if target is None or target == int(cue.get("position", preferred_position)):
            continue
        start = round(float(cue["start"]), 3)
        end = round(float(cue["end"]), 3)
        if end <= start:
            continue
        if intervals and intervals[-1]["position"] == target and abs(intervals[-1]["end"] - start) <= 0.002:
            intervals[-1]["end"] = end
            continue
        intervals.append(
            {
                "start": start,
                "end": end,
                "position": target,
                "reason": "deterministic_cue_face_guard",
                "confidence": 1.0,
                "position_source": "auto",
            }
        )
    return intervals


def _finite_float(value: object) -> float | None:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def uniform_sample_times(
    duration: float,
    *,
    max_frames: int = DEFAULT_GRID_FRAMES,
    opening_offset: float = 0.12,
    tail_offset: float = 0.15,
) -> list[float]:
    """Return evenly distributed storyboard timestamps across the video."""
    dur = _finite_float(duration)
    if dur is None or dur <= 0:
        raise ValueError("duration must be a positive number")
    count = max(1, int(max_frames))
    first = min(max(0.0, float(opening_offset)), max(0.0, dur - 0.02))
    last = max(first, dur - max(0.0, float(tail_offset)))
    if count == 1 or last <= first:
        return [round(first, 3)]
    step = (last - first) / (count - 1)
    return [round(first + (step * idx), 3) for idx in range(count)]


def _ffmpeg_bin() -> str:
    configured = (os.environ.get("FFMPEG_BIN") or "").strip()
    if configured and Path(configured).exists():
        return configured
    return shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def _ffprobe_bin() -> str:
    configured = (os.environ.get("FFPROBE_BIN") or "").strip()
    if configured and Path(configured).exists():
        return configured
    found = shutil.which("ffprobe")
    if found:
        return found
    ffmpeg = _ffmpeg_bin()
    if ffmpeg.endswith("ffmpeg"):
        sibling = ffmpeg[: -len("ffmpeg")] + "ffprobe"
        if Path(sibling).exists():
            return sibling
    return "ffprobe"


def _probe_video_timing(video_path: Path) -> tuple[float, float | None] | None:
    """Return the video stream duration and frame rate for EOF recovery."""
    try:
        completed = subprocess.run(
            [
                _ffprobe_bin(),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=duration,avg_frame_rate,r_frame_rate:format=duration",
                "-of",
                "json",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        payload = json.loads(completed.stdout or "{}")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    streams = payload.get("streams") or []
    stream = streams[0] if streams and isinstance(streams[0], dict) else {}
    fmt = payload.get("format") or {}
    duration = _finite_float(stream.get("duration")) or _finite_float(fmt.get("duration"))
    if duration is None or duration <= 0:
        return None
    frame_rate = None
    raw_rate = stream.get("avg_frame_rate") or stream.get("r_frame_rate")
    if isinstance(raw_rate, str) and "/" in raw_rate:
        numerator, denominator = raw_rate.split("/", 1)
        numerator_value = _finite_float(numerator)
        denominator_value = _finite_float(denominator)
        if numerator_value is not None and denominator_value not in (None, 0):
            frame_rate = numerator_value / denominator_value
    else:
        frame_rate = _finite_float(raw_rate)
    if frame_rate is not None and (not math.isfinite(frame_rate) or frame_rate <= 0):
        frame_rate = None
    return duration, frame_rate


def _is_no_frame_extraction_error(exc: subprocess.CalledProcessError) -> bool:
    stderr = str(getattr(exc, "stderr", "") or "").lower()
    return any(
        marker in stderr
        for marker in (
            "before eof",
            "nothing was written into output file",
            "received no packets",
        )
    )


def _safe_eof_timestamp(duration: float, frame_rate: float | None) -> float:
    """Keep a seek one frame before EOF so FFmpeg can emit a JPEG."""
    frame_step = (1.0 / frame_rate) if frame_rate and frame_rate > 0 else 0.05
    margin = max(0.05, frame_step + 0.01)
    return max(0.0, duration - margin)


def extract_storyboard_frames(
    video_path: str | Path,
    timestamps: Iterable[float],
    output_dir: str | Path,
    *,
    exact: bool = False,
) -> list[dict]:
    """Extract a small set of frames in one FFmpeg pass when possible."""
    source = Path(video_path)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    times = [float(t) for t in timestamps]
    if not times:
        return []
    if not source.exists():
        raise FileNotFoundError(source)

    if exact:
        entries: list[dict] = []
        for idx, timestamp in enumerate(times, 1):
            frame_path = out_dir / f"frame-{idx:03d}.jpg"
            def exact_command(seek_timestamp: float, output_path: Path = frame_path) -> list[str]:
                return [
                    _ffmpeg_bin(),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-ss",
                    f"{seek_timestamp:.3f}",
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=240:-2:flags=lanczos",
                    "-q:v",
                    "5",
                    str(output_path),
                ]

            actual_timestamp = float(timestamp)
            try:
                subprocess.run(
                    exact_command(actual_timestamp),
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=True,
                )
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                if not isinstance(exc, subprocess.CalledProcessError) or not _is_no_frame_extraction_error(exc):
                    stderr = getattr(exc, "stderr", "") or ""
                    raise RuntimeError(f"exact storyboard extraction failed: {stderr[-500:]}") from exc
                timing = _probe_video_timing(source)
                if timing is None:
                    stderr = getattr(exc, "stderr", "") or ""
                    raise RuntimeError(f"exact storyboard extraction failed: {stderr[-500:]}") from exc
                duration, frame_rate = timing
                actual_timestamp = min(actual_timestamp, _safe_eof_timestamp(duration, frame_rate))
                if actual_timestamp >= float(timestamp) - 0.0005:
                    stderr = getattr(exc, "stderr", "") or ""
                    raise RuntimeError(f"exact storyboard extraction failed: {stderr[-500:]}") from exc
                frame_path.unlink(missing_ok=True)
                try:
                    subprocess.run(
                        exact_command(actual_timestamp),
                        capture_output=True,
                        text=True,
                        timeout=30,
                        check=True,
                    )
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as retry_exc:
                    stderr = getattr(retry_exc, "stderr", "") or ""
                    raise RuntimeError(f"exact storyboard extraction failed after EOF recovery: {stderr[-500:]}") from retry_exc
            if frame_path.exists() and frame_path.stat().st_size > 512:
                entry = {"timestamp": round(actual_timestamp, 3), "path": frame_path}
                if abs(actual_timestamp - float(timestamp)) > 0.0005:
                    entry["requested_timestamp"] = round(float(timestamp), 3)
                entries.append(entry)
        if not entries:
            raise RuntimeError("exact storyboard extraction produced no frames")
        return entries

    # Uniform timestamps let one fps filter replace dozens of ffmpeg launches.
    # The labels remain the requested timestamps; exact pixel timing is not needed
    # for layout review, only a representative storyboard of the full video.
    start = times[0]
    interval = (times[-1] - times[0]) / max(1, len(times) - 1)
    fps = 1.0 / interval if interval > 0 else 1.0
    pattern = out_dir / "frame-%03d.jpg"
    cmd = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{start:.3f}",
        "-i",
        str(source),
        "-vf",
        f"fps={fps:.8f},scale=240:-2:flags=lanczos",
        "-frames:v",
        str(len(times)),
        "-q:v",
        "5",
        str(pattern),
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        stderr = getattr(exc, "stderr", "") or ""
        raise RuntimeError(f"storyboard frame extraction failed: {stderr[-500:]}") from exc

    entries: list[dict] = []
    for idx, timestamp in enumerate(times, 1):
        frame_path = out_dir / f"frame-{idx:03d}.jpg"
        if frame_path.exists() and frame_path.stat().st_size > 512:
            entries.append({"timestamp": round(timestamp, 3), "path": frame_path})
    if not entries:
        raise RuntimeError("storyboard extraction produced no frames")
    return entries


def detect_faces_in_frames(frame_entries: list[dict]) -> dict[str, list[dict]]:
    """Detect normalized face rectangles with Apple's local Vision framework."""
    swift = Path("/usr/bin/swift")
    helper = Path(__file__).with_name("apple_face_detect.swift")
    paths = [str(Path(item["path"]).resolve()) for item in frame_entries]
    if not paths or not swift.exists() or not helper.exists():
        return {}
    try:
        completed = subprocess.run(
            [str(swift), str(helper), *paths],
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        payload = json.loads(completed.stdout or "{}")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(path): [face for face in faces if isinstance(face, dict)]
        for path, faces in payload.items()
        if isinstance(faces, list)
    }


def build_video_face_guard_overrides(
    *,
    video_path: str | Path,
    duration: float,
    allowed_positions: Iterable[int] | None = None,
    frame_entries: list[dict] | None = None,
    cues: list[dict] | None = None,
) -> tuple[list[dict], dict]:
    """Build deterministic face-safe intervals from local exact video frames."""
    sampling_mode = "cue_midpoints" if cues else "uniform"
    cuts = None
    cut_error = ""
    if cues:
        try:
            cuts = detect_scene_boundaries(video_path)
        except (OSError, subprocess.SubprocessError) as exc:
            cut_error = str(exc)[:200]

    def build(entries: list[dict]) -> tuple[list[dict], dict]:
        faces = detect_faces_in_frames(entries)
        if cues:
            overrides = build_cue_preset_overrides(
                cues,
                entries,
                faces,
                scene_boundaries=cuts,
            )
        else:
            overrides = build_face_safe_overrides(
                entries,
                faces,
                duration=duration,
                preferred_position=DEFAULT_LAYOUT_POSITION,
                allowed_positions=allowed_positions,
            )
        return overrides, {
            "frame_count": len(entries),
            "frames_with_faces": sum(1 for item in entries if _faces_for_entry(item, faces)),
            "override_count": len(overrides),
            "backend": "apple-vision" if faces else "unavailable",
            "sampling_mode": sampling_mode,
            "placement_mode": "shot_locked" if cuts is not None else "geometry_fallback",
            "scene_boundaries": cuts,
            "scene_detection_error": cut_error,
        }

    if frame_entries:
        normalized = [
            {**item, "path": Path(item["path"]).resolve()}
            for item in frame_entries
        ]
        return build(normalized)
    timestamps = (
        [round((float(cue["start"]) + float(cue["end"])) / 2.0, 3) for cue in cues]
        if cues
        else uniform_sample_times(duration)
    )
    with tempfile.TemporaryDirectory(prefix="caption-face-guard-") as temp_dir:
        entries = extract_storyboard_frames(
            video_path,
            timestamps,
            temp_dir,
            exact=True,
        )
        return build(entries)


def _font(size: int):
    for candidate in (
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size)
            except OSError:
                pass
    return ImageFont.load_default()


def _timestamp_label(value: float) -> str:
    seconds = max(0.0, float(value))
    minutes = int(seconds // 60)
    remainder = seconds - (minutes * 60)
    return f"{minutes:02d}:{remainder:05.2f}"


def build_contact_sheet_from_frames(
    frame_entries: list[dict],
    output_path: str | Path,
    *,
    columns: int = 8,
    tile_width: int = 200,
) -> Path:
    """Build a readable landscape storyboard with timestamp labels."""
    if not frame_entries:
        raise ValueError("frame_entries must not be empty")
    cols = max(1, int(columns))
    width = max(120, int(tile_width))
    label_height = max(24, width // 8)
    tile_height = round(width * 16 / 9)
    cell_height = tile_height + label_height
    rows = math.ceil(len(frame_entries) / cols)
    sheet = Image.new("RGB", (cols * width, rows * cell_height), (10, 12, 20))
    draw = ImageDraw.Draw(sheet)
    label_font = _font(max(11, width // 16))

    for idx, entry in enumerate(frame_entries):
        path = Path(entry["path"])
        with Image.open(path) as raw:
            image = ImageOps.contain(raw.convert("RGB"), (width - 4, tile_height - 4))
        x = (idx % cols) * width
        y = (idx // cols) * cell_height
        paste_x = x + (width - image.width) // 2
        paste_y = y + (tile_height - image.height) // 2
        sheet.paste(image, (paste_x, paste_y))
        draw.rectangle((x, y + tile_height, x + width - 1, y + cell_height - 1), fill=(18, 21, 34))
        label = f"#{idx + 1:02d}  {_timestamp_label(float(entry['timestamp']))}"
        draw.text((x + 6, y + tile_height + 5), label, fill=(235, 240, 255), font=label_font)
        draw.rectangle((x, y, x + width - 1, y + cell_height - 1), outline=(58, 65, 92), width=1)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, format="JPEG", quality=88, optimize=True)
    return out


def build_video_contact_sheet(
    video_path: str | Path,
    output_path: str | Path,
    *,
    duration: float,
    max_frames: int = DEFAULT_GRID_FRAMES,
    columns: int = DEFAULT_GRID_COLUMNS,
    tile_width: int = DEFAULT_GRID_TILE_WIDTH,
) -> dict:
    """Extract and persist a full-video storyboard for the layout agent."""
    timestamps = uniform_sample_times(duration, max_frames=max_frames)
    with tempfile.TemporaryDirectory(prefix="caption-layout-frames-") as temp_dir:
        entries = extract_storyboard_frames(
            video_path,
            timestamps,
            temp_dir,
            exact=True,
        )
        build_contact_sheet_from_frames(
            entries,
            output_path,
            columns=columns,
            tile_width=tile_width,
        )
    return {
        "path": str(Path(output_path)),
        "frame_count": len(entries),
        "timestamps": [entry["timestamp"] for entry in entries],
    }


def parse_layout_agent_output(output: str) -> object:
    """Parse JSON from a bounded Hermes response, tolerating code fences."""
    cleaned = str(output or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].rstrip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        for idx, char in enumerate(cleaned):
            if char not in "[{":
                continue
            try:
                payload, _ = decoder.raw_decode(cleaned[idx:])
            except json.JSONDecodeError:
                continue
            if isinstance(payload, (dict, list)):
                return payload
    raise ValueError("No JSON layout payload found")


def _canonical_position(value: object, *, allowed_positions: Iterable[int] | None = None) -> int | None:
    aliases = {
        "lower": 28,
        "lower_clear": 28,
        "default": 34,
        "lower_mid": 34,
        "mid": 42,
        "middle": 42,
        "split_center": 50,
        "center": 50,
        "upper": 55,
        "upper_clear": 55,
    }
    candidates = tuple(sorted({int(item) for item in (allowed_positions or ALLOWED_LAYOUT_POSITIONS)}))
    if not candidates:
        candidates = ALLOWED_LAYOUT_POSITIONS
    if isinstance(value, str) and value.strip().lower() in aliases:
        numeric = aliases[value.strip().lower()]
        return min(candidates, key=lambda candidate: abs(candidate - numeric))
    numeric = _finite_float(value)
    if numeric is None:
        return None
    bounded = max(MIN_LAYOUT_POSITION, min(MAX_LAYOUT_POSITION, numeric))
    return min(candidates, key=lambda candidate: abs(candidate - bounded))


def normalize_layout_overrides(
    payload: object,
    *,
    duration: float,
    min_confidence: float = 0.70,
    min_duration: float = MIN_OVERRIDE_DURATION,
    max_overrides: int = MAX_LAYOUT_OVERRIDES,
    allowed_positions: Iterable[int] | None = None,
) -> list[dict]:
    """Validate agent output and return sparse, non-overlapping-ish overrides."""
    raw = payload.get("overrides") if isinstance(payload, dict) else payload
    if not isinstance(raw, list):
        return []
    dur = max(0.0, _finite_float(duration) or 0.0)
    candidates: list[dict] = []
    for item in raw[: max(1, int(max_overrides) * 4)]:
        if not isinstance(item, dict):
            continue
        start = _finite_float(item.get("start"))
        end = _finite_float(item.get("end"))
        confidence = _finite_float(item.get("confidence"))
        position = _canonical_position(
            item.get("position", item.get("zone")),
            allowed_positions=allowed_positions,
        )
        if start is None or end is None or position is None:
            continue
        confidence = 0.0 if confidence is None else max(0.0, min(1.0, confidence))
        start = max(0.0, start)
        end = min(dur, end) if dur else end
        if end - start < float(min_duration) or confidence < float(min_confidence):
            continue
        candidates.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "position": position,
                "reason": str(item.get("reason") or "agent_override")[:160],
                "confidence": round(confidence, 3),
                "position_source": "auto",
            }
        )

    candidates.sort(key=lambda item: (-item["confidence"], item["start"], item["end"]))
    accepted: list[dict] = []
    for candidate in candidates:
        overlaps = any(
            candidate["start"] < existing["end"] and candidate["end"] > existing["start"]
            for existing in accepted
        )
        if overlaps:
            continue
        accepted.append(candidate)
        if len(accepted) >= max(1, int(max_overrides)):
            break
    accepted.sort(key=lambda item: (item["start"], item["end"]))
    return accepted


def apply_layout_overrides(
    cues: list[dict],
    overrides: list[dict],
    *,
    default_position: int = DEFAULT_LAYOUT_POSITION,
) -> list[dict]:
    """Apply auto positions by cue midpoint without overwriting manual edits."""
    fallback = max(MIN_LAYOUT_POSITION, min(MAX_LAYOUT_POSITION, int(default_position)))
    output: list[dict] = []
    for cue in cues:
        updated = dict(cue)
        updated.setdefault("position", fallback)
        source = str(updated.get("position_source") or "").lower()
        if source != "manual":
            start = _finite_float(updated.get("start")) or 0.0
            end = _finite_float(updated.get("end")) or start
            midpoint = (start + max(start, end)) / 2.0
            matching = [
                override
                for override in overrides
                if (float(override["start"]) <= midpoint < float(override["end"]))
                or ("scene_id" in updated and "scene_id" not in override
                    and float(override["start"]) < float(updated["scene_end"])
                    and float(override["end"]) > float(updated["scene_start"]))
            ]
            if matching:
                selected = max(matching, key=lambda item: float(item.get("confidence", 0)))
                updated["position"] = int(selected["position"])
                updated["position_source"] = "auto"
                updated["position_confidence"] = float(selected.get("confidence", 0))
                updated["position_reason"] = str(selected.get("reason") or "agent_override")
                for key in ("scene_id", "scene_start", "scene_end"):
                    if key in selected:
                        updated[key] = selected[key]
        output.append(updated)
    return output


def apply_reference_positions(
    cues: list[dict],
    reference_cues: list[dict],
    *,
    timing_tolerance: float = 0.25,
    minimum_match_ratio: float = 0.80,
) -> tuple[list[dict], bool]:
    """Seed a fresh cue track from a trusted same-source position map.

    Text remains from the fresh ASR track. Only positions are borrowed, and the
    source is marked ``reference`` so the visual pass may improve it while UI
    edits marked ``manual`` remain protected.
    """
    if not cues or not reference_cues or len(cues) != len(reference_cues):
        return [dict(cue) for cue in cues], False
    seeded = [dict(cue) for cue in cues]
    matches = 0
    for cue, reference in zip(seeded, reference_cues):
        start = _finite_float(cue.get("start"))
        end = _finite_float(cue.get("end"))
        ref_start = _finite_float(reference.get("start"))
        ref_end = _finite_float(reference.get("end"))
        ref_position = _finite_float(reference.get("position"))
        if any(value is None for value in (start, end, ref_start, ref_end, ref_position)):
            continue
        assert start is not None and end is not None and ref_start is not None and ref_end is not None and ref_position is not None
        if abs(start - ref_start) > timing_tolerance or abs(end - ref_end) > timing_tolerance:
            continue
        position = int(round(max(MIN_LAYOUT_POSITION, min(MAX_LAYOUT_POSITION, ref_position))))
        cue["position"] = position
        cue["position_source"] = "reference"
        cue.pop("position_confidence", None)
        cue.pop("position_reason", None)
        matches += 1
    matched = matches >= max(1, math.ceil(len(cues) * float(minimum_match_ratio)))
    return (seeded if matched else [dict(cue) for cue in cues]), matched


def build_reference_position_ranges(cues: list[dict]) -> list[dict]:
    """Compress contiguous cue positions into a prompt-sized reference map."""
    ranges: list[dict] = []
    current: dict | None = None
    for cue in cues:
        start = _finite_float(cue.get("start"))
        end = _finite_float(cue.get("end"))
        position = _finite_float(cue.get("position"))
        if any(value is None for value in (start, end, position)):
            continue
        assert start is not None and end is not None and position is not None
        normalized_position = int(round(max(MIN_LAYOUT_POSITION, min(MAX_LAYOUT_POSITION, position))))
        if current and current["position"] == normalized_position and start <= current["end"] + 0.05:
            current["end"] = round(max(current["end"], end), 3)
            continue
        if current:
            ranges.append(current)
        current = {
            "start": round(max(0.0, start), 3),
            "end": round(max(start, end), 3),
            "position": normalized_position,
        }
    if current:
        ranges.append(current)
    return ranges


def normalize_layout_qa(
    payload: object,
    *,
    duration: float,
    min_confidence: float = 0.70,
    max_overrides: int = MAX_LAYOUT_OVERRIDES,
    allowed_positions: Iterable[int] | None = None,
) -> dict:
    """Validate the captioned-grid QA contract and its sparse corrections."""
    data = payload if isinstance(payload, dict) else {}
    approved = data.get("approved") is True
    face_clear = data.get("face_clear") is True
    overrides = normalize_layout_overrides(
        data,
        duration=duration,
        min_confidence=min_confidence,
        max_overrides=max_overrides,
        allowed_positions=allowed_positions,
    )
    return {
        "approved": approved,
        "face_clear": face_clear,
        "accepted": approved and face_clear,
        "overrides": overrides,
        "reason": str(data.get("reason") or "")[:300],
    }
