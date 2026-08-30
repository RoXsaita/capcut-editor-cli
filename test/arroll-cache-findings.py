#!/usr/bin/env python3
"""Regression coverage for A-roll cache identity, duplicate safety, and FPS contracts."""
import json
import os
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from aroll import (
    AROLL_INDEX_VERSION,
    cmd_cut,
    first_word_in,
    group_duplicates,
    index_is_current,
    media_token,
    repair,
    suggested_keep,
    trustworthy_word_start,
)
from audio_index import AudioIndex, lint


def beat(identifier, text, take, start, end, **extra):
    return {
        "id": identifier,
        "text": text,
        "take": take,
        "src_in": start,
        "src_out": end,
        "dur": end - start,
        "defects": [],
        **extra,
    }


class ArollCacheFindingsTest(unittest.TestCase):
    def test_same_path_same_size_fast_overwrite_invalidates_aroll_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "take.mp4"
            media.write_bytes(b"A" * 8192)
            before_stat = media.stat()
            before = media_token(media)
            index = Path(tmp) / "take.aroll.json"
            index.write_text(json.dumps({
                "version": AROLL_INDEX_VERSION,
                "media": str(media),
                "source_token": before,
            }))
            self.assertTrue(index_is_current(index, media))

            # Preserve inode, size, and nanosecond mtime to model a fast overwrite that
            # defeats metadata-only cache keys.
            media.write_bytes(b"B" * 8192)
            os.utime(media, ns=(before_stat.st_atime_ns, before_stat.st_mtime_ns))
            after = media_token(media)

            self.assertEqual(before["ino"], after["ino"])
            self.assertEqual(before["size"], after["size"])
            self.assertEqual(before["mtime_ns"], after["mtime_ns"])
            self.assertNotEqual(before["content_hash"], after["content_hash"])
            self.assertFalse(index_is_current(index, media))

    def test_arabic_prefix_chain_is_review_only_and_all_beats_are_retained(self):
        beats = [
            beat(0, "اضغطوا على زر النشر", 0, 0.0, 2.0),
            beat(1, "اضغطوا على زر النشر وبعدها انتظروا", 0, 2.1, 5.0),
            beat(2, "اضغطوا على زر النشر وبعدها انتظروا للنتيجة", 0, 5.1, 8.0),
        ]

        groups = group_duplicates(beats)

        self.assertFalse(any(
            len(group["members"]) > 1 and group.get("status") != "review"
            for group in groups
        ))
        self.assertTrue(any(group.get("status") == "review" for group in groups))
        self.assertEqual(suggested_keep(beats, groups), [0, 1, 2])

    def test_first_word_in_preserves_explicit_trust_even_with_low_confidence(self):
        word = first_word_in({
            "words": [{
                "word": "مرحبا",
                "start": 0.30,
                "end": 0.80,
                "probability": 0.05,
                "word_start_trustworthy": True,
            }],
        }, 0.40, 0.90)

        self.assertEqual(word["word_start_trustworthy"], True)
        self.assertTrue(trustworthy_word_start(
            AudioIndex([-70.0] * 200, 0.01), word, acoustic_onset=0.36,
        ))

    def test_repair_uses_lint_predicate_for_loud_falling_boundary(self):
        db = [-70.0] * 200
        for i in range(60, 85):
            db[i] = -20.0
        idx = AudioIndex(db, 0.01)
        picked = [beat(0, "مرحبا", 0, 0.50, 0.80)]

        self.assertTrue(any("LOUD_BOUNDARY" in finding
                            for finding in lint(idx, [("b0", 0.50, 0.80)])))
        notices = repair(idx, picked)

        self.assertTrue(any("OUT 0.800" in notice and "trough" in notice for notice in notices), notices)
        self.assertFalse(any("LOUD_BOUNDARY" in finding
                             for finding in lint(idx, [("b0", picked[0]["src_in"], picked[0]["src_out"])])))

    def test_flat_loud_boundary_is_explicitly_left_blocking(self):
        idx = AudioIndex([-20.0] * 200, 0.01)
        picked = [beat(0, "مرحبا", 0, 0.50, 0.80)]

        notices = repair(idx, picked)

        self.assertTrue(any("remains blocking" in notice for notice in notices), notices)
        self.assertTrue(any("LOUD_BOUNDARY" in finding
                            for finding in lint(idx, [("b0", 0.50, 0.80)])))

    def test_plan_carries_input_fps_and_quantizes_24_and_2997(self):
        for fps in (24.0, 29.97):
            with self.subTest(fps=fps), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                media = root / "take.mp4"
                media.write_bytes(b"media")
                plan_path = root / "take.plan.json"
                start = 12.0 / fps
                end = 30.0 / fps
                data = {
                    "media": str(media),
                    "fps": fps,
                    "source_duration": 3.0,
                    "beats": [{
                        "id": 0,
                        "text": "مرحبا",
                        "src_in": start,
                        "src_out": end,
                        "dur": end - start,
                        "first_word_trustworthy": False,
                    }],
                    "default_keep": [0],
                }
                index = root / "take.aroll.json"
                index.write_text(json.dumps(data, ensure_ascii=False))
                args = Namespace(
                    index=str(index), keep=None, drop=None, no_repair=True,
                    force=False, project=None, into=None, dry_run=False,
                    plan=str(plan_path), fps=None,
                )
                with patch("aroll.AudioIndex.build_or_load",
                           return_value=AudioIndex([-70.0] * 500, 0.01)):
                    self.assertEqual(cmd_cut(args), 0)

                plan = json.loads(plan_path.read_text())
                self.assertEqual(plan["fps"], fps)
                self.assertEqual(plan["fps_contract"], {
                    "fps": fps, "quantized": True, "authority": "input",
                })
                self.assertEqual(plan["handoff"]["fps"], fps)
                for item in plan["timeline"]:
                    for field in ("tl_in", "tl_out", "src_in", "dur"):
                        self.assertLess(
                            abs(item[field] * fps - round(item[field] * fps)),
                            1e-4,
                            (fps, field, item[field]),
                        )


if __name__ == "__main__":
    unittest.main()
