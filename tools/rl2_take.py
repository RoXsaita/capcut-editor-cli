#!/usr/bin/env python3
"""
rl2_take — which video file of an rl2 take holds a moment, and at what file time.

Every rl2 sidecar (trace.ndjson, change.ndjson, frames.ndjson) is stamped on ONE take-wide
`vt` clock. When the recorder's watchdog restarts the video mid-take, the pixels continue in
screen-part02.mp4 (then -part03 ...), each file starting its own clock at its part's
`start_vt`, and the seconds between one part's `end_vt` and the next part's `start_vt` are in
no file at all. session.json lists the parts under `video_segments`.

So a vt is not a seek time. `locate(parts, vt)` is: (file, vt - start_vt), or None when vt
falls in a restart gap. A take with one part is the plain case: its one file, and vt is the
file time. src/rl2-take.mjs is the same reader for the Node side; keep them in step.
"""
import json
import math
import re
from collections import namedtuple
from pathlib import Path

SESSION = "session.json"
DEFAULT_VIDEO = "screen.mp4"
# end_vt is the time of a part's last frame, which is still on screen for one frame period.
END_SLACK = 0.05

Part = namedtuple("Part", "file start_vt end_vt")


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _session(take_dir):
    try:
        value = json.loads((Path(take_dir) / SESSION).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def parts(take_dir, session=None):
    """The take's video files in vt order, each with the [start_vt, end_vt] it covers.

    A restarted take lists two or more parts under `video_segments`; a listed part needs a
    file, a finite start_vt and, when frames is recorded, at least one frame. Anything else is
    the one-file take: session.json `video` (or screen.mp4) from vt 0 with no end.
    """
    session = _session(take_dir) if session is None else session
    listed = []
    for segment in session.get("video_segments") or []:
        if not isinstance(segment, dict):
            continue
        file, start, frames = segment.get("file"), segment.get("start_vt"), segment.get("frames")
        if not isinstance(file, str) or not file or not _finite(start):
            continue
        if frames is not None and not (_finite(frames) and frames > 0):
            continue
        end = segment.get("end_vt")
        listed.append(Part(file, float(start), float(end) if _finite(end) else None))
    if len(listed) > 1:
        listed.sort(key=lambda part: part.start_vt)
        return [part if part.end_vt is not None or index == len(listed) - 1
                else part._replace(end_vt=listed[index + 1].start_vt)
                for index, part in enumerate(listed)]
    video = session.get("video")
    return [Part(video if isinstance(video, str) and video else DEFAULT_VIDEO, 0.0, None)]


def locate(take_parts, vt):
    """(file, file_time) for a take-wide vt, or None when vt is in no file (a restart gap,
    or before the first part)."""
    if not _finite(vt):
        return None
    take_parts = list(take_parts)
    for index, part in enumerate(take_parts):
        end = math.inf if part.end_vt is None else part.end_vt + END_SLACK
        # The slack never reaches into the next part: its first frames are its own (a derived
        # end_vt is exactly the next start, and a restart gap can be shorter than the slack).
        if index + 1 < len(take_parts) and _finite(take_parts[index + 1].start_vt):
            end = min(end, take_parts[index + 1].start_vt - 1e-6)
        if part.start_vt - 1e-6 <= vt <= end:
            return part.file, max(0.0, vt - part.start_vt)
    return None


def _media_stem(name):
    """The take file a (possibly localized) media name stands for: `<take>__screen-part02`
    and `screen-part02__1a2b3c4d` are both screen-part02."""
    stem = re.sub(r"\.[^.]+$", "", Path(str(name)).name)
    stem = re.sub(r"__[0-9a-f]{8}(_\d+)?$", "", stem)
    return stem.rsplit("__", 1)[-1]


def part_for_media(take_parts, media):
    """The part a media file is, or None. A one-part take answers its part for any name, so
    single-file behaviour never depends on how the file was renamed."""
    if len(take_parts) == 1:
        return take_parts[0]
    stem = _media_stem(media)
    for part in take_parts:
        if _media_stem(part.file) == stem:
            return part
    return None


def listing(take_parts):
    """The parts as one human line, the shape rl2 prints."""
    def span(part):
        end = "end" if part.end_vt is None else f"{part.end_vt:.2f}"
        return f"{part.file} {part.start_vt:.2f}-{end}s"
    return "parts: " + ", ".join(span(part) for part in take_parts)
