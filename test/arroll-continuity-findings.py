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

from aroll import cmd_cut, cmd_index, seam_repeat_findings
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


def word(text, start, end):
    return {"text": text, "start": start, "end": end, "segment": 0}


class SeamRepeatTest(unittest.TestCase):
    def test_a_phrase_on_both_sides_of_a_splice_is_one_finding(self):
        words = [word("we", 0.0, 0.3), word("open", 0.3, 0.6), word("X", 0.6, 0.8), word("Y", 0.8, 1.0),
                 word("X", 5.0, 5.2), word("Y", 5.2, 5.4), word("then", 5.4, 5.7), word("go", 5.7, 6.0)]
        clips = [{"id": 0, "src_in": 0.0, "src_out": 1.0}, {"id": 3, "src_in": 5.0, "src_out": 6.0}]
        findings = seam_repeat_findings(words, clips)
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("b0->b3 SEAM_REPEAT", findings[0])
        self.assertIn("'x y'", findings[0])

    def test_one_shared_word_a_distant_repeat_and_source_neighbours_are_clean(self):
        one = [word("we", 0.0, 0.3), word("open", 0.3, 0.6), word("it", 0.6, 1.0),
               word("it", 5.0, 5.2), word("closes", 5.2, 5.6)]
        clips = [{"id": 0, "src_in": 0.0, "src_out": 1.0}, {"id": 1, "src_in": 5.0, "src_out": 6.0}]
        self.assertEqual(seam_repeat_findings(one, clips), [])

        far = [word("X", 0.0, 0.1), word("Y", 0.1, 0.2)] + [
            word(f"w{i}", 0.2 + i * 0.1, 0.3 + i * 0.1) for i in range(7)] + [
            word("X", 5.0, 5.1), word("Y", 5.1, 5.2)]
        clips = [{"id": 0, "src_in": 0.0, "src_out": 1.0}, {"id": 1, "src_in": 5.0, "src_out": 6.0}]
        self.assertEqual(seam_repeat_findings(far, clips), [], "more than k tokens away")

        # Source neighbours share the boundary words through the pad; a word instance is never
        # its own repeat.
        neighbours = [word("a", 0.0, 0.4), word("b", 0.4, 0.8), word("c", 0.8, 1.0),
                      word("d", 1.05, 1.3), word("e", 1.3, 1.6)]
        clips = [{"id": 0, "src_in": 0.0, "src_out": 1.0}, {"id": 1, "src_in": 1.03, "src_out": 1.6}]
        self.assertEqual(seam_repeat_findings(neighbours, clips), [])
        self.assertEqual(seam_repeat_findings(None, clips), [])

    def test_a_coalesced_span_is_one_clip_and_has_no_seam_to_compare(self):
        words = [word("X", 0.6, 0.8), word("Y", 0.8, 1.0), word("X", 1.1, 1.3), word("Y", 1.3, 1.5)]
        coalesced = [{"id": 0, "beats": [0, 1], "src_in": 0.5, "src_out": 1.6}]
        self.assertEqual(seam_repeat_findings(words, coalesced), [])

    def test_cut_refuses_a_seam_repeat_unless_forced_and_rebuilds_row_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "face.mp4"
            media.write_bytes(b"fixture media")
            index = root / "face.aroll.json"
            index.write_text(json.dumps({
                "media": str(media), "fps": 30.0, "source_duration": 4.0,
                "words": [word("open", 0.1, 0.5), word("the", 0.5, 0.7), word("app", 0.7, 0.95),
                          word("the", 2.05, 2.3), word("app", 2.3, 2.6), word("now", 2.6, 2.95)],
                "beats": [
                    {"id": 0, "text": "stale words", "src_in": 0.0, "src_out": 1.0, "dur": 1.0},
                    {"id": 1, "text": "the app now", "src_in": 2.0, "src_out": 3.0, "dur": 1.0},
                ], "default_keep": [0, 1],
            }))
            silent = AudioIndex([-20.0] * 100 + [-70.0] * 100 + [-20.0] * 100 + [-70.0] * 100, 0.01)
            plan_path = root / "repeat.plan.json"
            args = cut_args(index, plan_path, "0,1", "0,1")
            args.force, args.project = False, "Repeat Project"
            with patch("aroll.AudioIndex.build_or_load", return_value=silent), \
                    patch("aroll.subprocess.run") as run:
                self.assertEqual(cmd_cut(args), 1)
            run.assert_not_called()
            plan = json.loads(plan_path.read_text())
            self.assertTrue(any("SEAM_REPEAT" in f and "'the app'" in f for f in plan["lint"]), plan["lint"])
            self.assertEqual(plan["timeline"][0]["text"], "open the app")


if __name__ == "__main__":
    unittest.main()
