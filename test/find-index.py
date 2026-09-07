#!/usr/bin/env python3
"""Focused regressions for source-bound OCR and Whisper cache lookup."""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import find  # noqa: E402


def write_ocr(cache, media, frames, duration):
    media = find.canonical_media(media)
    record = find._ocr_record(media, find.source_token(media), duration, frames)
    path = find.ocr_cache_path(media, record["source_token"], cache)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record))
    return path


class FindIndexTests(unittest.TestCase):
    def test_invalid_search_inputs_are_rejected_before_loading_media(self):
        for options in ([" "], ["q", "--settle", "nan"], ["q", "--settle", "-1"],
                        ["q", "--shows", "--says"]):
            with self.subTest(options=options), patch.object(sys, "argv", ["find.py", "--media", "missing", *options]), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                find.main()
            self.assertEqual(raised.exception.code, 2)

    def test_fractional_settling_requires_the_complete_requested_window(self):
        output = io.StringIO()
        with patch.object(sys, "argv", ["find.py", "q", "--media", "unused", "--settle", "1.5"]), \
                patch.object(find, "load_ocr_record", return_value=({0: "q", 1: "other"}, {})), \
                contextlib.redirect_stdout(output):
            find.main()
        self.assertNotIn("held", output.getvalue())

    def test_same_basename_sources_use_their_own_ocr_indexes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "one" / "screen.mp4"
            second = root / "two" / "screen.mp4"
            first.parent.mkdir()
            second.parent.mkdir()
            first.write_bytes(b"first source")
            second.write_bytes(b"second source")
            cache = root / "cache"
            first_cache = write_ocr(cache, first, {0: "alpha", 1: "alpha"}, 2.0)
            second_cache = write_ocr(cache, second, {0: "beta", 1: "beta"}, 2.0)

            self.assertNotEqual(first_cache, second_cache)
            with patch.object(find, "CACHE", str(cache)), \
                    patch.object(find, "_probe_duration", return_value=2.0):
                self.assertEqual(find.load_ocr(first), {0: "alpha", 1: "alpha"})
                self.assertEqual(find.load_ocr(second), {0: "beta", 1: "beta"})

    def test_missing_stale_incomplete_and_legacy_indexes_are_actionable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache = root / "cache"
            cache.mkdir()
            missing = root / "missing.mp4"
            missing.write_bytes(b"missing")
            with patch.object(find, "CACHE", str(cache)), self.assertRaisesRegex(SystemExit, "--refresh"):
                find.load_ocr(missing)

            stale = root / "stale.mp4"
            stale.write_bytes(b"before")
            write_ocr(cache, stale, {0: "old", 1: "old"}, 2.0)
            stale.write_bytes(b"after")
            with patch.object(find, "CACHE", str(cache)), \
                    patch.object(find, "_probe_duration", return_value=2.0), \
                    self.assertRaisesRegex(SystemExit, "stale.*--refresh"):
                find.load_ocr(stale)

            incomplete = root / "incomplete.mp4"
            incomplete.write_bytes(b"incomplete")
            write_ocr(cache, incomplete, {0: "partial", 1: "partial"}, 4.0)
            with patch.object(find, "CACHE", str(cache)), \
                    patch.object(find, "_probe_duration", return_value=4.0), \
                    self.assertRaisesRegex(SystemExit, "incomplete OCR coverage.*--refresh"):
                find.load_ocr(incomplete)

            legacy = root / "legacy.mp4"
            legacy.write_bytes(b"legacy")
            (cache / "legacy.ocr.json").write_text(json.dumps({"0": "unverified"}))
            with patch.object(find, "CACHE", str(cache)), \
                    self.assertRaisesRegex(SystemExit, "untrusted legacy.*--refresh"):
                find.load_ocr(legacy)

    def test_same_basename_whisper_caches_are_selected_by_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "one" / "screen.mp4"
            second = root / "two" / "screen.mp4"
            first.parent.mkdir()
            second.parent.mkdir()
            first.write_bytes(b"first")
            second.write_bytes(b"second")
            cache = root / "cache"
            cache.mkdir()
            for media, text in ((first, "alpha"), (second, "beta")):
                (cache / f"screen.whisper-{text}.json").write_text(json.dumps({
                    "_token": find.source_token(media),
                    "segments": [{"start": 0, "end": 1, "text": text,
                                  "words": [{"start": 0, "end": 1, "word": text}]}],
                }))

            with patch.object(find, "CACHE", str(cache)):
                self.assertEqual(find.load_transcript(first)["segments"][0]["text"], "alpha")
                self.assertEqual(find.load_transcript(second)["segments"][0]["text"], "beta")

    def test_refresh_builds_and_reloads_a_tiny_real_media_index(self):
        if not (shutil.which("ffmpeg") and shutil.which("ffprobe")
                and os.path.isfile(find.OCR_BIN) and os.access(find.OCR_BIN, os.X_OK)):
            self.skipTest("ffmpeg, ffprobe, and the Vision OCR helper are required")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "tiny.mp4"
            result = subprocess.run([
                "ffmpeg", "-v", "error", "-f", "lavfi",
                "-i", "color=c=white:s=640x360:r=30:d=2.1",
                "-vf", "drawtext=text=HELLO:fontcolor=black:fontsize=80:x=(w-text_w)/2:y=(h-text_h)/2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(media),
            ], capture_output=True, text=True)
            if result.returncode != 0:
                self.skipTest(f"ffmpeg cannot create the tiny OCR fixture: {result.stderr[-400:]}")
            cache = root / "cache"
            output = io.StringIO()
            with patch.object(find, "CACHE", str(cache)):
                with patch.object(sys, "argv", [
                    "find.py", "hello", "--media", str(media), "--shows", "--refresh",
                ]), contextlib.redirect_stdout(output):
                    find.main()
                record = json.loads(next(cache.glob("*.ocr-*.json")).read_text())
                loaded = find.load_ocr(media)

            self.assertEqual(record["media"], find.canonical_media(media))
            self.assertEqual(record["source_token"], find.source_token(media))
            self.assertEqual(record["coverage"]["samples"], len(record["frames"]))
            self.assertEqual(record["coverage"]["samples"], len(loaded))
            self.assertEqual(len(loaded), 3, "the partial final second must be indexed")
            self.assertTrue(all(isinstance(text, str) for text in loaded.values()))
            self.assertIn("run(s) on screen", output.getvalue())


if __name__ == "__main__":
    unittest.main()
