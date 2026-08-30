#!/usr/bin/env python3
"""Regression coverage for cross-Whisper-segment A-roll speech."""
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from aroll import cmd_cut, cmd_index
from audio_index import AudioIndex


def cut_args(index, plan, keep, order):
    return Namespace(
        index=str(index), keep=keep, drop=None, order=order, trim_beat=None, review=None,
        no_repair=True, force=True, project=None, into=None, dry_run=True, plan=str(plan), fps=None,
    )


class ArollContinuousSpeechTest(unittest.TestCase):
    def test_cross_segment_speech_coalesces_or_refuses_without_changing_silent_cuts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "face.mp4"
            media.write_bytes(b"fixture media")
            index = root / "face.aroll.json"
            db = [-70.0] * 2400
            for sample in range(1460, 2176):
                db[sample] = -20.0
            continuous = AudioIndex(db, 0.01)
            transcript = {"segments": [
                {"start": 14.020, "end": 17.520, "text": "باستخدم هيرمس كل يوم", "words": [
                    {"word": "باستخدم", "start": 14.600, "end": 15.000},
                    {"word": "هيرمس", "start": 15.000, "end": 16.000},
                    {"word": "كل", "start": 17.060, "end": 17.240},
                    {"word": "يوم", "start": 17.240, "end": 17.520},
                ]},
                {"start": 17.520, "end": 21.767, "text": "وبصراحة بحط كلود وكودكس", "words": [
                    {"word": "وبصراحة", "start": 17.520, "end": 18.100},
                    {"word": "بحط", "start": 18.100, "end": 18.500},
                    {"word": "كلود", "start": 18.500, "end": 19.000},
                    {"word": "وكودكس", "start": 19.000, "end": 19.600},
                ]},
            ]}
            args = Namespace(media=str(media), lang="ar", model="fixture", reindex=False,
                             fps=30.0, out=str(index))
            with patch("aroll.AudioIndex.build_or_load", return_value=continuous), \
                    patch("aroll.transcribe", return_value=transcript), \
                    patch("aroll.snap", side_effect=[(14.600, 17.100), (17.167, 21.767)]):
                self.assertEqual(cmd_index(args), 0)

            indexed = json.loads(index.read_text())
            self.assertEqual(indexed["beats"][1]["continuation_of"], 0)
            self.assertEqual(indexed["beats"][1]["foreign_lead"], "كل يوم")

            plan_path = root / "both.plan.json"
            with patch("aroll.AudioIndex.build_or_load", return_value=continuous):
                self.assertEqual(cmd_cut(cut_args(index, plan_path, "0,1", "0,1")), 0)
            plan = json.loads(plan_path.read_text())
            self.assertEqual(plan["kept"], [0, 1])
            self.assertEqual(plan["order"], [0, 1])
            self.assertEqual(len(plan["timeline"]), 1)
            clip = plan["timeline"][0]
            self.assertEqual(clip["beats"], [0, 1])
            self.assertEqual(clip["continuity"][0]["foreign_lead"], "كل يوم")
            self.assertIn("كل يوم", clip["text"])
            self.assertEqual(clip["src_dur"], clip["dur"])
            self.assertEqual(clip["tl_out"] - clip["tl_in"], clip["dur"])
            for field in ("src_in", "src_out", "src_dur", "tl_in", "tl_out", "dur"):
                self.assertAlmostEqual(clip[field] * 30, round(clip[field] * 30), places=4)

            orphan_plan = root / "orphan.plan.json"
            with patch("aroll.AudioIndex.build_or_load", return_value=continuous):
                self.assertEqual(cmd_cut(cut_args(index, orphan_plan, "1", "1")), 2)
            self.assertFalse(orphan_plan.exists())

            clipped_plan = root / "clipped.plan.json"
            with patch("aroll.AudioIndex.build_or_load", return_value=continuous):
                self.assertEqual(cmd_cut(cut_args(index, clipped_plan, "0", "0")), 2)
            self.assertFalse(clipped_plan.exists())

            normal_index = root / "normal.aroll.json"
            normal_index.write_text(json.dumps({
                "media": str(media), "fps": 30.0, "source_duration": 3.0,
                "beats": [
                    {"id": 0, "text": "first", "src_in": 0.0, "src_out": 1.0, "dur": 1.0},
                    {"id": 1, "text": "second", "src_in": 2.0, "src_out": 3.0, "dur": 1.0},
                ], "default_keep": [0, 1],
            }))
            silent = AudioIndex([-20.0] * 100 + [-70.0] * 100 + [-20.0] * 100 + [-70.0] * 100, 0.01)
            normal_plan = root / "normal.plan.json"
            with patch("aroll.AudioIndex.build_or_load", return_value=silent):
                self.assertEqual(cmd_cut(cut_args(normal_index, normal_plan, "0,1", "0,1")), 0)
            self.assertEqual([item["beats"] for item in json.loads(normal_plan.read_text())["timeline"]], [[0], [1]])


if __name__ == "__main__":
    unittest.main()
