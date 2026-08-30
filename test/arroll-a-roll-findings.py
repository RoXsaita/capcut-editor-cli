#!/usr/bin/env python3
"""Focused A-roll regression tests; run directly with Python 3.11+."""
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from aroll import (
    AUDIO_RAMP_FRAMES,
    FRAME,
    add_audio_ramps,
    audio_ramp_operations,
    cmd_cut,
    group_duplicates,
    snap,
    suggested_keep,
    trustworthy_word_start,
)
from audio_index import AudioIndex


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


class ArollFindingsTest(unittest.TestCase):
    def test_default_keep_keeps_unique_tutorial_and_late_cta_redo(self):
        beats = [
            beat(0, "شرح طويل لكل خطوات الربط على الموبايل", 0, 0, 8),
            beat(1, "اكتبوا دليل بالتعليقات", 0, 8, 9),
            beat(2, "اكتبوا دليل بالتعليقات", 1, 20, 21),
        ]

        groups = group_duplicates(beats)

        self.assertEqual([group["members"] for group in groups if len(group["members"]) > 1], [[1, 2]])
        self.assertEqual(suggested_keep(beats, groups), [0, 2])

    def test_last_complete_wins_when_late_retry_is_truncated(self):
        beats = [
            beat(0, "افتحوا التطبيق واختاروا هيرمس", 0, 0, 4),
            beat(1, "افتحوا التطبيق", 1, 10, 11),
            beat(2, "اضغطوا على زر الربط", 0, 12, 14),
            beat(3, "اضغطوا على زر الربط", 1, 20, 22, complete=False),
        ]

        groups = group_duplicates(beats)

        self.assertEqual(suggested_keep(beats, groups), [0, 2])
        self.assertEqual(groups[0]["selected"], 0)
        self.assertEqual(groups[1]["selected"], 2)

    def test_existing_very_short_defect_marks_a_late_duplicate_incomplete(self):
        beats = [
            beat(0, "اضغطوا على زر النشر", 0, 0, 2),
            beat(1, "اضغطوا على زر النشر", 1, 10, 10.3, defects=["very short"]),
        ]

        groups = group_duplicates(beats)

        self.assertEqual(suggested_keep(beats, groups), [0])
        self.assertEqual(groups[0]["selected"], 0)

    def test_arabic_orthography_variants_are_one_group_but_unrelated_beats_are_not(self):
        beats = [
            beat(0, "أَحْلَى طريقة للربط", 0, 0, 2),
            beat(1, "احلى طريقة للربط!", 1, 10, 12),
            beat(2, "بعدها افتحوا تليجرام", 1, 13, 15),
        ]

        groups = group_duplicates(beats)

        self.assertEqual([group["members"] for group in groups if len(group["members"]) > 1], [[0, 1]])
        self.assertEqual(suggested_keep(beats, groups), [1, 2])

    def test_trusted_earlier_word_start_protects_unvoiced_arabic_lead(self):
        # The first consonant is intentionally below SOFT (-45 dB), while its vowel is
        # loud. Energy-only snapping would start at .36; the trusted Whisper start is .30.
        db = [-70.0] * 160
        for i in range(30, 36):
            db[i] = -50.0
        for i in range(36, 90):
            db[i] = -20.0
        idx = AudioIndex(db, 0.01)
        word = {"start": 0.30}

        self.assertTrue(trustworthy_word_start(idx, word, acoustic_onset=0.36))
        trusted_in, _ = snap(idx, 0.30, 0.90, word_start=0.30, word_start_trustworthy=True)
        acoustic_in, _ = snap(idx, 0.30, 0.90, word_start=0.30, word_start_trustworthy=False)
        self.assertAlmostEqual(trusted_in, 0.2333333333, places=6)
        self.assertAlmostEqual(acoustic_in, 0.30, places=6)

    def test_cut_handoff_has_two_frame_fades_and_keeps_principal_at_one_x(self):
        timeline = [
            {"beat": 0, "tl_in": 0.0, "tl_out": 2.0, "src_in": 12.0, "dur": 2.0, "text": "tutorial"},
            {"beat": 1, "tl_in": 2.0, "tl_out": 2.5, "src_in": 40.0, "dur": 0.5, "text": "CTA"},
        ]

        ramped = add_audio_ramps(timeline)
        operations = audio_ramp_operations(ramped)
        expected = round(AUDIO_RAMP_FRAMES * FRAME, 6)

        self.assertEqual([scene["speed"] for scene in ramped], [1.0, 1.0])
        for scene in ramped:
            self.assertEqual(scene["audio_fade"]["in_frames"], 2)
            self.assertEqual(scene["audio_fade"]["out_frames"], 2)
            self.assertEqual(scene["audio_fade"]["in"], expected)
            self.assertEqual(scene["audio_fade"]["out"], expected)
        self.assertEqual(len(operations), 2)
        self.assertTrue(all(op["op"] == "clip.fade" for op in operations))
        self.assertTrue(all(op["track"] == "content" for op in operations))
        self.assertTrue(all(op["in"] == expected and op["out"] == expected for op in operations))

    def test_cmd_cut_refuses_to_build_a_trusted_first_word_clip_even_with_force(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index = root / "clip.aroll.json"
            index.write_text(json.dumps({
                "media": str(root / "media.mp4"),
                "fps": 30.0,
                "source_duration": 2.0,
                "beats": [{
                    "id": 0,
                    "text": "مرحبا",
                    "src_in": 1.0,
                    "src_out": 1.5,
                    "dur": 0.5,
                    "first_word": "مرحبا",
                    "first_word_start": 0.80,
                    "first_word_trustworthy": True,
                }],
                "default_keep": [0],
            }))
            args = Namespace(
                index=str(index), keep=None, drop=None, no_repair=True, force=True,
                project="should-not-be-created", into=None, dry_run=False, plan=None,
            )
            with patch.object(__import__("aroll").AudioIndex, "build_or_load", return_value=AudioIndex([-70.0] * 200, 0.01)), \
                    patch("aroll.subprocess.run") as run:
                result = cmd_cut(args)

        self.assertEqual(result, 1)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
