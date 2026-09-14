#!/usr/bin/env python3
"""Focused regressions for the rl2 change-signal index behind `find --moments`."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import change_index  # noqa: E402
import find  # noqa: E402


def write_take(directory, frames, trace=(), session=None):
    """An rl2 take directory. `frames` are (vt, score) or (vt, score, blocks, mask)."""
    directory.mkdir(parents=True, exist_ok=True)
    rows = []
    for index, frame in enumerate(frames):
        vt, score = frame[0], frame[1]
        blocks = frame[2] if len(frame) > 2 else 0
        mask = frame[3] if len(frame) > 3 else "0"
        rows.append({"n": index + 1, "vt": vt, "score": score, "blocks": blocks, "mask": mask})
    (directory / "change.ndjson").write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
    (directory / "trace.ndjson").write_text(
        "\n".join(json.dumps(row) for row in trace) + ("\n" if trace else ""), encoding="utf-8")
    (directory / "session.json").write_text(
        json.dumps(session if session is not None else {"clock": {"first_frame_host": 100.0}}),
        encoding="utf-8")
    return directory


class SidecarDiscoveryTests(unittest.TestCase):
    def test_sidecars_beside_the_media_are_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            take = write_take(Path(tmp) / "take", [(0.0, 0.0), (10.0, 9.0)])
            media = take / "screen.mp4"
            media.write_bytes(b"")
            self.assertEqual(change_index.sidecar_dir(media), take)

    def test_a_localized_take_is_matched_by_name_under_the_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "Muse Spark"
            media = project / "Resources" / "CapcutctlMedia" / "windows-2-20260905__screen.mp4"
            media.parent.mkdir(parents=True)
            media.write_bytes(b"")
            take = write_take(
                project / ".capcutctl" / "rl2" / "windows-2-20260905__rl2-b049c73f7516",
                [(0.0, 0.0), (10.0, 9.0)])
            self.assertEqual(change_index.sidecar_dir(media), take)

    def test_media_with_no_sidecar_anywhere_is_not_invented(self):
        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "plain.mov"
            media.write_bytes(b"")
            self.assertIsNone(change_index.sidecar_dir(media))
            index, reason = change_index.load(media, 10.0)
            self.assertIsNone(index)
            self.assertIn("no rl2 sidecar", reason)


class LoadTests(unittest.TestCase):
    def test_a_sidecar_whose_clock_disagrees_with_the_media_is_refused(self):
        """A trimmed or recut copy keeps the take's name and none of its timeline."""
        with tempfile.TemporaryDirectory() as tmp:
            take = write_take(Path(tmp) / "take", [(0.0, 0.0), (600.0, 9.0)])
            media = take / "screen.mp4"
            media.write_bytes(b"")
            index, reason = change_index.load(media, 45.0)
            self.assertIsNone(index)
            self.assertIn("trimmed or derived copy", reason)

    def test_a_truncated_final_record_still_indexes_what_survived(self):
        """The take we recovered had a writer die mid-record. It must still index."""
        with tempfile.TemporaryDirectory() as tmp:
            take = write_take(Path(tmp) / "take", [(0.0, 0.0), (5.0, 9.0), (10.0, 0.0)])
            with open(take / "change.ndjson", "a", encoding="utf-8") as handle:
                handle.write('{"n": 4, "vt": 10.5, "sco')
            media = take / "screen.mp4"
            media.write_bytes(b"")
            index, reason = change_index.load(media, 10.0)
            self.assertIsNone(reason)
            self.assertEqual(index.frames, 3)
            self.assertEqual([round(m.start, 2) for m in index.moments], [5.0])


class MomentTests(unittest.TestCase):
    def build(self, frames, duration, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            take = write_take(Path(tmp) / "take", frames)
            media = take / "screen.mp4"
            media.write_bytes(b"")
            index, reason = change_index.load(media, duration, **kwargs)
            self.assertIsNone(reason)
            return index

    def test_bursts_inside_the_gap_are_one_moment_and_beyond_it_are_two(self):
        index = self.build([(0.0, 0.0), (1.0, 9.0), (1.5, 9.0), (5.0, 9.0), (10.0, 0.0)], 10.0)
        self.assertEqual([(round(m.start, 2), round(m.end, 2)) for m in index.moments],
                         [(1.0, 1.5), (5.0, 5.0)])

    def test_a_moment_carries_the_peak_the_block_count_and_the_union_of_masks(self):
        index = self.build(
            [(0.0, 0.0), (1.0, 3.0, 4, "1"), (1.2, 40.0, 31, "20"), (10.0, 0.0)], 10.0)
        moment = index.moments[0]
        self.assertEqual(moment.peak, 40.0)
        self.assertEqual(moment.blocks, 31)
        self.assertEqual(moment.mask, 0x21)

    def test_frames_delivered_out_of_order_do_not_split_a_moment(self):
        """rl2 writes in host order; the last frames of a take can arrive out of sequence."""
        index = self.build([(0.0, 0.0), (1.2, 9.0), (1.0, 9.0), (10.0, 0.0)], 10.0)
        self.assertEqual(len(index.moments), 1)
        self.assertEqual((round(index.moments[0].start, 2), round(index.moments[0].end, 2)),
                         (1.0, 1.2))

    def test_the_threshold_is_what_decides_a_moment(self):
        frames = [(0.0, 0.0), (1.0, 0.6), (5.0, 9.0), (10.0, 0.0)]
        self.assertEqual(len(self.build(frames, 10.0).moments), 2)
        self.assertEqual(len(self.build(frames, 10.0, min_score=5.0).moments), 1)


class FocusTests(unittest.TestCase):
    def index(self, trace, duration=100.0, session=None):
        with tempfile.TemporaryDirectory() as tmp:
            take = write_take(Path(tmp) / "take", [(0.0, 0.0), (duration, 0.0)],
                              trace=trace, session=session)
            media = take / "screen.mp4"
            media.write_bytes(b"")
            index, reason = change_index.load(media, duration)
            self.assertIsNone(reason)
            return index

    def test_host_times_become_source_times_through_the_first_frame_clock(self):
        index = self.index([
            {"type": "focus_change", "host": 100.0, "app": "Chrome"},
            {"type": "focus_change", "host": 130.0, "app": "Hermes"},
        ])
        self.assertEqual([(s.start, s.end, s.app) for s in index.focus],
                         [(0.0, 30.0, "Chrome"), (30.0, 100.0, "Hermes")])
        self.assertEqual(index.app_at(5.0), "Chrome")
        self.assertEqual(index.app_at(50.0), "Hermes")

    def test_repeated_switches_to_the_same_app_are_one_span(self):
        index = self.index([
            {"type": "focus_change", "host": 100.0, "app": "Chrome"},
            {"type": "focus_change", "host": 110.0, "app": "Chrome"},
            {"type": "focus_change", "host": 120.0, "app": "Hermes"},
        ])
        self.assertEqual([(s.start, s.end, s.app) for s in index.focus],
                         [(0.0, 20.0, "Chrome"), (20.0, 100.0, "Hermes")])

    def test_a_take_with_no_clock_reports_no_focus_rather_than_guessing_zero(self):
        index = self.index([{"type": "focus_change", "host": 100.0, "app": "Chrome"}],
                           session={})
        self.assertEqual(index.focus, [])
        self.assertIsNone(index.app_at(5.0))

    def test_non_focus_trace_records_are_ignored(self):
        index = self.index([
            {"type": "click", "host": 105.0, "app": "Chrome"},
            {"type": "session_end", "host": 190.0, "frames": 10},
        ])
        self.assertEqual(index.focus, [])


class SnapTests(unittest.TestCase):
    def index(self, starts):
        moments = [change_index.Moment(at, at, 9.0, 1, 1) for at in starts]
        return change_index.ChangeIndex("take", 100.0, moments, [], 10)

    def test_a_sampled_second_is_pulled_back_to_the_change_inside_it(self):
        self.assertAlmostEqual(self.index([586.52]).snap(587).start, 586.52)

    def test_the_latest_change_inside_the_window_is_the_cause(self):
        self.assertAlmostEqual(self.index([586.1, 586.9]).snap(587).start, 586.9)

    def test_a_change_outside_the_window_is_a_different_event(self):
        self.assertIsNone(self.index([585.4]).snap(587))

    def test_no_moment_at_all_leaves_the_reported_second_alone(self):
        self.assertIsNone(self.index([]).snap(587))


class FindWiringTests(unittest.TestCase):
    def test_focus_is_rejected_for_a_transcript_search(self):
        with patch.object(sys, "argv",
                          ["find.py", "q", "--media", "unused", "--says", "--focus", "Chrome"]), \
                self.assertRaises(SystemExit) as raised:
            find.main()
        self.assertIn("--focus", str(raised.exception))

    def test_a_query_is_still_required_unless_moments_is_listing(self):
        with patch.object(sys, "argv", ["find.py", "--media", "unused"]), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            find.main()
        self.assertEqual(raised.exception.code, 2)

    def test_a_negative_threshold_is_rejected_before_any_media_is_touched(self):
        with patch.object(sys, "argv",
                          ["find.py", "q", "--media", "unused", "--min-score", "-1"]), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            find.main()
        self.assertEqual(raised.exception.code, 2)

    def test_moments_on_a_plain_recording_says_so_and_names_the_alternative(self):
        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "plain.mov"
            media.write_bytes(b"")
            with patch.object(sys, "argv", ["find.py", "--media", str(media), "--moments"]), \
                    patch.object(find, "_probe_duration", return_value=10.0), \
                    self.assertRaises(SystemExit) as raised:
                find.main()
        self.assertIn("--shows", str(raised.exception))

    def test_a_take_with_nothing_above_the_threshold_is_named_not_reported_as_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            take = write_take(Path(tmp) / "take", [(0.0, 0.0), (10.0, 0.0)])
            media = take / "screen.mp4"
            media.write_bytes(b"")
            with patch.object(sys, "argv", ["find.py", "--media", str(media), "--moments"]), \
                    patch.object(find, "_probe_duration", return_value=10.0), \
                    self.assertRaises(SystemExit) as raised:
                find.main()
        self.assertIn("no moment above", str(raised.exception))

    def test_listing_moments_needs_no_ocr_at_all(self):
        """The whole point: knowing what happened must not cost a single OCR call."""
        with tempfile.TemporaryDirectory() as tmp:
            take = write_take(Path(tmp) / "take", [(0.0, 0.0), (5.0, 9.0), (10.0, 0.0)],
                              trace=[{"type": "focus_change", "host": 100.0, "app": "Hermes"}])
            media = take / "screen.mp4"
            media.write_bytes(b"")
            output = io.StringIO()
            with patch.object(sys, "argv", ["find.py", "--media", str(media), "--moments"]), \
                    patch.object(find, "_probe_duration", return_value=10.0), \
                    patch.object(find, "_ocr_frame", side_effect=AssertionError("OCR was called")), \
                    contextlib.redirect_stdout(output):
                find.main()
        self.assertIn("1 moment(s)", output.getvalue())
        self.assertIn("[Hermes]", output.getvalue())


class MomentCacheTests(unittest.TestCase):
    def take(self, tmp):
        directory = write_take(Path(tmp) / "take", [(0.0, 0.0), (5.0, 9.0), (10.0, 0.0)])
        media = directory / "screen.mp4"
        media.write_bytes(b"rl2 take bytes")
        index, reason = change_index.load(media, 10.0)
        self.assertIsNone(reason)
        return str(media), index

    def test_a_built_index_round_trips_and_is_not_rebuilt(self):
        with tempfile.TemporaryDirectory() as tmp:
            media, index = self.take(tmp)
            cache = str(Path(tmp) / "cache")
            with patch.object(find, "_extract_frame_at"), \
                    patch.object(find, "_ocr_frame", return_value="signal bay"), \
                    patch.object(find, "OCR_BIN", sys.executable), \
                    contextlib.redirect_stderr(io.StringIO()):
                first = find.load_moment_record(media, index, cache_dir=cache)
            self.assertEqual(first, {5.0: "signal bay"})

            with patch.object(find, "_ocr_frame", side_effect=AssertionError("rebuilt")), \
                    contextlib.redirect_stderr(io.StringIO()):
                again = find.load_moment_record(media, index, cache_dir=cache)
            self.assertEqual(again, first)

    def test_a_different_threshold_describes_different_moments_and_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            media, index = self.take(tmp)
            cache = str(Path(tmp) / "cache")
            with patch.object(find, "_extract_frame_at"), \
                    patch.object(find, "_ocr_frame", return_value="signal bay"), \
                    patch.object(find, "OCR_BIN", sys.executable), \
                    contextlib.redirect_stderr(io.StringIO()):
                find.load_moment_record(media, index, cache_dir=cache)

            stricter, _ = change_index.load(media, 10.0, min_score=50.0)
            data = json.loads(find.moments_cache_path(media, cache_dir=cache).read_text())
            rejected, reason = find._validate_moment_record(
                data, find.canonical_media(media), find.source_token(media), stricter)
            self.assertIsNone(rejected)
            self.assertIn("--min-score", reason)


if __name__ == "__main__":
    unittest.main(verbosity=2)
