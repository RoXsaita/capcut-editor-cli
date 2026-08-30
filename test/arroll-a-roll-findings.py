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
    apply_boundary_adjustments,
    audio_ramp_operations,
    cmd_cut,
    group_duplicates,
    load_review,
    snap,
    parse_order_spec,
    parse_trim_specs,
    resolve_editorial_decisions,
    suggested_keep,
    trustworthy_word_start,
)
from audio_index import AudioIndex, source_token


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

    def test_order_is_an_exact_permutation_and_trim_flags_are_inward_only(self):
        data = {
            "source_token": {"content_hash": "current"},
            "beats": [beat(0, "one", 0, 0, 1), beat(1, "two", 0, 1, 2), beat(2, "three", 0, 2, 3)],
            "default_keep": [0, 1, 2],
        }
        args = Namespace(keep="0,2", drop=None, order="2,0", trim_beat=None, review=None)
        resolved = resolve_editorial_decisions(data, args)
        self.assertEqual(resolved["kept"], [0, 2])
        self.assertEqual(resolved["order"], [2, 0])

        for order in ("2,2", "2,1", "2,9"):
            with self.subTest(order=order):
                args.order = order
                with self.assertRaisesRegex(ValueError, "permutation|duplicate|unknown"):
                    resolve_editorial_decisions(data, args)

        with self.assertRaisesRegex(ValueError, "expands"):
            parse_trim_specs(["1:in=-0.2"])
        with self.assertRaisesRegex(ValueError, "expands"):
            parse_trim_specs(["1:out=0.2"])
        self.assertEqual(parse_order_spec("2,0"), [2, 0])

    def test_review_file_requires_current_source_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            token = {"ino": 1, "size": 2, "mtime_ns": 3, "content_hash": "same"}
            data = {
                "source_token": token,
                "beats": [beat(0, "one", 0, 0, 1), beat(1, "two", 0, 1, 2)],
                "default_keep": [0, 1],
            }
            review = root / "decisions.json"
            review.write_text(json.dumps({
                "version": 1, "sourceToken": token, "keep": [0, 1], "order": [1, 0],
                "boundaries": {"1": {"outOffset": -0.2}},
            }))
            loaded = load_review(review, data)
            self.assertEqual(loaded["order"], [1, 0])
            self.assertEqual(loaded["boundaries"], {1: {"outOffset": -0.2}})

            stale = json.loads(review.read_text())
            stale["sourceToken"] = {**token, "content_hash": "old"}
            review.write_text(json.dumps(stale))
            with self.assertRaisesRegex(ValueError, "stale"):
                load_review(review, data)

    def test_inward_trim_resolves_to_acoustic_onset_and_trough_with_equal_durations(self):
        db = [-70.0] * 500
        for start, end in ((100, 150), (250, 350)):
            for index in range(start, end):
                db[index] = -20.0
        idx = AudioIndex(db, 0.01)
        picked = [beat(0, "a useful beat", 0, 0.98, 4.5)]
        adjustments = apply_boundary_adjustments(
            idx, picked, {0: {"inOffset": 0.8, "outOffset": -0.7}}, fps=30,
        )

        self.assertEqual(len(adjustments), 1)
        self.assertGreater(picked[0]["src_in"], 0.98)
        self.assertLess(picked[0]["src_out"], 4.5)
        self.assertLess(idx.at(picked[0]["src_out"]), -55.0)
        self.assertAlmostEqual(
            adjustments[0]["resolved"]["src_out"] - adjustments[0]["resolved"]["src_in"],
            picked[0]["src_out"] - picked[0]["src_in"],
        )

    def test_cmd_cut_review_writes_ordered_one_x_plan_with_source_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "face.mp4"
            media.write_bytes(b"fixture media")
            token = source_token(media)
            index = root / "face.aroll.json"
            plan = root / "face.plan.json"
            data = {
                "version": 3,
                "media": str(media),
                "source_token": token,
                "fps": 30.0,
                "source_duration": 3.0,
                "beats": [
                    beat(0, "first", 0, 0.0, 1.0),
                    beat(1, "second", 0, 2.0, 3.0),
                ],
                "default_keep": [0, 1],
            }
            index.write_text(json.dumps(data))
            review = root / "decisions.json"
            review.write_text(json.dumps({
                "version": 1, "sourceToken": token, "keep": [0, 1], "order": [1, 0],
            }))
            args = Namespace(
                index=str(index), keep=None, drop=None, order=None, trim_beat=None,
                review=str(review), no_repair=True, force=False, project=None, into=None,
                dry_run=True, plan=str(plan), fps=None,
            )
            idx = AudioIndex([-20.0] * 100 + [-70.0] * 100
                             + [-20.0] * 100 + [-70.0] * 100, 0.01)
            with patch.object(__import__("aroll").AudioIndex, "build_or_load", return_value=idx):
                self.assertEqual(cmd_cut(args), 0)

            resolved = json.loads(plan.read_text())
            self.assertEqual(resolved["order"], [1, 0])
            self.assertEqual(resolved["sourceToken"], token)
            self.assertEqual(resolved["editorial"]["reviewFile"], str(review.absolute()))
            self.assertEqual([item["beat"] for item in resolved["timeline"]], [1, 0])
            for item in resolved["timeline"]:
                self.assertAlmostEqual(item["src_dur"], item["dur"])
                self.assertAlmostEqual(item["tl_out"] - item["tl_in"], item["dur"])

    def test_long_tail_trim_keeps_useful_beat_and_is_accepted_without_force(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "face.mp4"
            media.write_bytes(b"fixture media")
            token = source_token(media)
            index = root / "face.aroll.json"
            plan = root / "face.plan.json"
            index.write_text(json.dumps({
                "version": 3,
                "media": str(media),
                "source_token": token,
                "fps": 30.0,
                "source_duration": 6.0,
                "beats": [beat(
                    0, "a useful beat with a long tail", 0, 1.0, 4.5,
                    first_word="a", first_word_start=1.0, first_word_trustworthy=True,
                )],
                "default_keep": [0],
            }))
            args = Namespace(
                index=str(index), keep="0", drop=None, order="0",
                trim_beat=["0:out=-1.16"], review=None, no_repair=True, force=False,
                project=None, into="existing project", dry_run=False, plan=str(plan), fps=None,
            )
            # Speech ends at 2.0s; the indexed beat deliberately carries a 2.5s tail.
            idx = AudioIndex([-70.0] * 100 + [-20.0] * 100 + [-70.0] * 500, 0.01)
            with patch.object(__import__("aroll").AudioIndex, "build_or_load", return_value=idx), \
                    patch("aroll.subprocess.run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = ""
                self.assertEqual(cmd_cut(args), 0)

            resolved = json.loads(plan.read_text())
            item = resolved["timeline"][0]
            self.assertEqual(resolved["kept"], [0])
            self.assertLess(item["src_out"], 4.5)
            self.assertGreater(item["src_out"], 2.0)
            self.assertEqual(resolved["lint"], [])
            self.assertEqual(resolved["adjustments"][0]["offsets"], {"outOffset": -1.16})
            self.assertAlmostEqual(item["src_dur"], item["dur"])
            self.assertAlmostEqual(item["tl_out"] - item["tl_in"], item["dur"])
            command = run.call_args.args[0]
            self.assertEqual(command[:4], ["capcutctl", "apply", "--project", "existing project"])

    def test_source_overlap_is_a_hard_refusal_even_with_force(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "face.mp4"
            media.write_bytes(b"fixture media")
            token = source_token(media)
            index = root / "face.aroll.json"
            plan = root / "face.plan.json"
            index.write_text(json.dumps({
                "version": 3, "media": str(media), "source_token": token, "fps": 30.0,
                "source_duration": 4.0,
                "beats": [beat(0, "first", 0, 0.0, 2.0), beat(1, "overlap", 0, 1.5, 3.0)],
                "default_keep": [0, 1],
            }))
            args = Namespace(
                index=str(index), keep="0,1", drop=None, order="0,1", trim_beat=None,
                review=None, no_repair=True, force=True, project="A-roll Review", into=None,
                dry_run=False, plan=str(plan), fps=None,
            )
            idx = AudioIndex([-20.0] * 400, 0.01)
            with patch.object(__import__("aroll").AudioIndex, "build_or_load", return_value=idx), \
                    patch("aroll.subprocess.run") as run:
                self.assertEqual(cmd_cut(args), 1)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
