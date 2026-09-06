#!/usr/bin/env python3
"""
capcutctl find — where does this phrase happen?

Two haystacks, one answer shape:
  --says   the Whisper transcript of a talking-head recording  (what was SAID, and when)
  --shows  the OCR index of a screen recording                 (what was ON SCREEN, and when)

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
from audio_index import _write_json_atomic, source_token

CACHE = os.path.expanduser("~/Downloads/.video-index")
OCR_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vision", "ocr")
OCR_INDEX_VERSION = 2
# ponytail: 1 fps misses sub-second UI changes; event-level indexing is outside this bounded repair.
OCR_SAMPLE_INTERVAL = 1.0


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
    return _normalise_text(" ".join(
        str(row.get("text", "")) for row in rows if isinstance(row, dict)
    ))


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
        "frames": {str(second): _normalise_text(text) for second, text in frames.items()},
    }


def _parse_ocr_frames(data):
    frames = data.get("frames")
    if not isinstance(frames, dict) or not frames:
        return None, "incomplete OCR index: frames are missing"
    parsed = {}
    for raw_second, text in frames.items():
        if not isinstance(raw_second, str) or not re.fullmatch(r"\d+", raw_second):
            return None, "incomplete OCR index: frame times are not integer seconds"
        second = int(raw_second)
        if not isinstance(text, str):
            return None, "incomplete OCR index: frame text is malformed"
        parsed[second] = _normalise_text(text)
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
    return load_ocr_record(media, refresh=refresh, cache_dir=cache_dir)[0]


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


def collapse(hits, gap=3):
    runs = []
    for t in sorted(hits):
        if runs and t - runs[-1][1] <= gap:
            runs[-1][1] = t
        else:
            runs.append([t, t])
    return runs


def main():
    ap = argparse.ArgumentParser(prog="capcutctl find")
    ap.add_argument("query", help="text to look for (case-insensitive, all words must appear)")
    ap.add_argument("--media", required=True)
    ap.add_argument("--shows", action="store_true", help="search the OCR index (screen recording)")
    ap.add_argument("--says", action="store_true", help="search the transcript (talking head)")
    ap.add_argument("--refresh", action="store_true",
                    help="build or replace a verified OCR index before a --shows search")
    ap.add_argument("--settle", type=float, default=2.0,
                    help="seconds a run must persist before its start is reported as stable")
    ap.add_argument("--context", action="store_true", help="print the matching line(s)")
    ap.add_argument("--strip", nargs="?", const="find-strip.png", default=None,
                    help="grab a frame at each run and write a contact sheet — OCR matches text "
                         "that can be occluded or scrolled off, so LOOK before you cut")
    a = ap.parse_args()
    if not (a.shows or a.says):
        a.shows = True
    if a.refresh and a.says:
        raise SystemExit("--refresh only applies to --shows; run `capcutctl cut` to refresh a transcript")
    terms = [w for w in a.query.lower().split() if w]

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

    idx, _record = load_ocr_record(a.media, refresh=a.refresh)
    hits = [t for t in idx if all(x in idx[t] for x in terms)]
    runs = collapse(hits)
    picks = []
    print(f"{len(runs)} run(s) on screen in {os.path.basename(a.media)}  "
          f"(index {min(idx)}-{max(idx)}s)")
    for lo, hi in runs[:25]:
        stable = next((t for t in range(lo, hi + 1)
                       if all(all(x in idx.get(t + k, "") for x in terms)
                              for k in range(int(a.settle)))), None)
        if stable is None:
            continue
        held = hi - lo + 1
        mark = "" if stable == lo else f"  (flickers from {lo}s)"
        print(f"  {stable:6d}s -> {hi:6d}s   held {held:4d}s{mark}")
        if a.context:
            line = re.sub(r"\s+", " ", idx.get(stable, ""))
            print(f"           {line[:100]}")
        picks.append((stable, f"{stable}s ({held}s)"))

    if a.strip and picks:
        from frame_qa import contact_sheet, extract_frame
        out = os.path.abspath(a.strip)
        # Keep every extraction's intermediate images in a private per-invocation directory.
        # The old shared /tmp/capcutctl-find/f{second}.png let concurrent searches overwrite
        # one another and gave a local symlink a predictable write target.
        with tempfile.TemporaryDirectory(prefix="capcutctl-find-") as tmp:
            tiles = []
            for i, (t, label) in enumerate(picks[:12]):
                f = os.path.join(tmp, f"f{i:03d}.png")
                sample = extract_frame(a.media, t)
                sample.image.convert("RGB").save(f)
                retry = "  re-extracted accurately" if sample.reextracted else ""
                print(
                    f"  frame {t:g}s requested PTS {sample.requested_pts:.6f}s "
                    f"delivered PTS {sample.delivered_pts:.6f}s "
                    f"drift {sample.drift:.6f}s ({sample.method}){retry}"
                )
                tiles.append((f, label))
            print(f"\n  -> {contact_sheet(tiles, out)}")
        print("     OCR sees text it cannot see is occluded. Check the frames before you cut.")


if __name__ == "__main__":
    main()
