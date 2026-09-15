#!/usr/bin/env python3
"""
capcutctl change index — where in this take does anything actually happen?

`find --shows` OCRs a blind 1 fps grid over the whole source, and find.py says so at the
top of itself: 1 fps misses sub-second UI changes. For an rl2 take that grid is
unnecessary guesswork, because the recorder already wrote the answer down.

`change.ndjson` carries, per captured frame, a mean absolute luma delta (0..255) against
the previous frame plus a mask of which of the 8x8 blocks moved. `trace.ndjson` carries
every frontmost-app switch. Measured on six real takes, 94% of frames score under 0.01,
and a 22-minute recording collapses to 86 candidate moments covering 4% of its runtime.

This module turns those sidecars into the two things a search actually wants:

  moments — merged runs of real change, with their peak, block count and block mask
  focus   — [start, end) spans naming the frontmost app, for multi-window takes

Nothing here guesses. A sidecar is used only when its own frame clock agrees with the
media's duration, so a trimmed, recut or derived copy is refused outright rather than
reported against a timeline it does not describe. A take whose recorder died mid-write
still indexes: a truncated final line is skipped, not fatal.
"""
import json
import math
from collections import namedtuple
from pathlib import Path

# Mean absolute luma delta a frame must reach to count as "something happened". Measured
# across six takes at 0.25/0.5/1.0/2.0: the moment count stays roughly flat while the
# share of runtime they cover keeps falling, so 0.5 separates events from sensor noise
# without shattering one event into several.
MIN_SCORE = 0.5

# Two bursts closer than this are the same moment. A UI transition is not instantaneous:
# a window swap lands over several frames, a menu paints in two.
MERGE_GAP = 1.0

# How far a whole-second OCR hit may be pulled back to the change that caused it. The OCR
# grid samples at integer seconds, so text first seen at second s actually appeared in
# (s - 1, s]; anything earlier than that is a different event.
SNAP_WINDOW = 1.0

CHANGE = "change.ndjson"
TRACE = "trace.ndjson"
SESSION = "session.json"

Moment = namedtuple("Moment", "start end peak blocks mask")
FocusSpan = namedtuple("FocusSpan", "start end app")


def _read_ndjson(path):
    """Rows of an ndjson file, skipping anything unparseable.

    Deliberately lenient about the last line. A take whose writer died mid-record still
    has a complete index up to that point, and refusing the whole file over a half-written
    final line would throw away the part that is fine.
    """
    rows = []
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
    except OSError:
        return []
    return rows


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def sidecar_dir(media):
    """The rl2 take directory for a media file, or None.

    Two shapes are recognised. A take still in place has its sidecars next to the video.
    A take localized into a project sits at
    `<project>/Resources/CapcutctlMedia/<take>__screen.mp4`, and `capcutctl add` copied its
    sidecars to `<project>/.capcutctl/rl2/<take>__rl2-<hash>/`. The directory is matched on
    the take name rather than by recomputing that hash, because both sides were sanitised
    by the same rule when they were written.
    """
    media = Path(media)
    here = media.parent
    if (here / CHANGE).is_file():
        return here

    marker = "__screen"
    if marker not in media.name:
        return None
    take = media.name.split(marker)[0]
    if not take:
        return None
    root = here.parent.parent / ".capcutctl" / "rl2"
    if not root.is_dir():
        return None
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return None
    for entry in entries:
        if entry.is_dir() and entry.name.startswith(take + "__") and (entry / CHANGE).is_file():
            return entry
    return None


def _mask_of(value):
    if isinstance(value, int):
        return value
    try:
        return int(str(value), 16)
    except (TypeError, ValueError):
        return 0


def _moments_of(rows, min_score, gap):
    marks = []
    for row in rows:
        score, at = row.get("score"), row.get("vt")
        if (not isinstance(score, (int, float)) or not isinstance(at, (int, float))
                or not math.isfinite(score) or not math.isfinite(at)):
            continue
        if score < min_score:
            continue
        blocks = row.get("blocks")
        marks.append((float(at), float(score),
                      blocks if isinstance(blocks, int) else 0,
                      _mask_of(row.get("mask"))))
    # Sorted rather than trusted: rl2 writes in host order, and the last frames of a take
    # can be delivered a hair out of presentation order.
    marks.sort(key=lambda mark: mark[0])

    runs = []
    for at, score, blocks, mask in marks:
        if runs and at - runs[-1][1] <= gap:
            run = runs[-1]
            run[1] = max(run[1], at)
            run[2] = max(run[2], score)
            run[3] = max(run[3], blocks)
            run[4] |= mask
        else:
            runs.append([at, at, score, blocks, mask])
    return [Moment(*run) for run in runs]


def _focus_of(rows, session, duration):
    clock = session.get("clock")
    origin = (clock or {}).get("first_frame_host") if isinstance(clock, dict) else None
    if not isinstance(origin, (int, float)) or not math.isfinite(origin):
        origin = session.get("start_host")
    if not isinstance(origin, (int, float)) or not math.isfinite(origin):
        return []
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
        return []

    marks = []
    for row in rows:
        if row.get("type") != "focus_change":
            continue
        host, app = row.get("host"), row.get("app")
        if not isinstance(host, (int, float)) or not math.isfinite(host) or not app:
            continue
        marks.append((min(max(float(host) - float(origin), 0.0), duration), str(app)))
    marks.sort(key=lambda mark: mark[0])

    spans = []
    for index, (at, app) in enumerate(marks):
        end = marks[index + 1][0] if index + 1 < len(marks) else duration
        if end <= at:
            # A switch superseded within the same instant names nothing; the next one wins.
            continue
        if spans and spans[-1].app == app and abs(spans[-1].end - at) < 1e-9:
            spans[-1] = FocusSpan(spans[-1].start, end, app)
        else:
            spans.append(FocusSpan(at, end, app))
    return spans


class ChangeIndex:
    """A take's change moments and focus spans, bound to one media duration."""

    def __init__(self, directory, duration, moments, focus, frames,
                 min_score=MIN_SCORE, merge_gap=MERGE_GAP):
        self.directory = Path(directory)
        self.duration = duration
        self.moments = moments
        self.focus = focus
        self.frames = frames
        # Carried so a cached OCR-per-moment index can refuse to be reused at a different
        # threshold: different settings describe a different set of moments.
        self.min_score = min_score
        self.merge_gap = merge_gap

    @property
    def covered(self):
        """Seconds of runtime the moments account for."""
        return sum(moment.end - moment.start for moment in self.moments)

    def app_at(self, when):
        """The frontmost app at a source time, or None when the take has no focus trace."""
        for span in self.focus:
            if span.start <= when < span.end:
                return span.app
        return self.focus[-1].app if self.focus and when >= self.focus[-1].end else None

    def apps(self):
        seen = []
        for span in self.focus:
            if span.app not in seen:
                seen.append(span.app)
        return seen

    def snap(self, second, window=SNAP_WINDOW):
        """The real start of the change behind a whole-second OCR hit, or None.

        The grid samples integer seconds, so text first read at second s appeared in
        (s - window, s]. The latest moment starting inside that window is the cause. When
        no moment falls there the change was below threshold — a slow fade, a few characters
        — and the honest answer is to leave the reported second alone.
        """
        best = None
        for moment in self.moments:
            if second - window < moment.start <= second:
                best = moment
            elif moment.start > second:
                break
        return best


def load(media, duration, min_score=MIN_SCORE, gap=MERGE_GAP):
    """(index, reason). One of the two is always None.

    `reason` is a sentence for a human: no sidecar, or a sidecar that cannot be trusted for
    this media. Callers treat it as "carry on without the index", never as a failure.
    """
    directory = sidecar_dir(media)
    if directory is None:
        return None, "no rl2 sidecar next to this media"
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        return None, "media duration is missing or invalid"

    rows = _read_ndjson(directory / CHANGE)
    frames = [row for row in rows
              if isinstance(row.get("vt"), (int, float)) and math.isfinite(row["vt"])]
    if not frames:
        return None, f"{directory.name}/{CHANGE} holds no usable frames"

    last = max(float(row["vt"]) for row in frames)
    if abs(last - duration) > max(1.0, duration * 0.01):
        return None, (f"{directory.name} describes {last:.1f}s of frames but the media runs "
                      f"{duration:.1f}s — a trimmed or derived copy, not this take")

    moments = _moments_of(rows, min_score, gap)
    focus = _focus_of(_read_ndjson(directory / TRACE), _read_json(directory / SESSION), duration)
    return ChangeIndex(directory, duration, moments, focus, len(frames),
                       min_score=min_score, merge_gap=gap), None
