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
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import frame_qa  # noqa: E402


def segment(segment_id, start, duration, material="VIDEO", desc=""):
    return {
        "id": segment_id,
        "material_id": material,
        "desc": desc,
        "target_timerange": {
            "start": round(start * 1_000_000),
            "duration": round(duration * 1_000_000),
        },
        "source_timerange": {
            "start": 0,
            "duration": round(duration * 1_000_000),
        },
    }


class FrameAccuracyTests(unittest.TestCase):
    def setUp(self):
        frame_qa._cache_reset()

    def tearDown(self):
        frame_qa._cache_reset()

    def test_drift_over_one_frame_reextracts_with_coarse_timestamp_selection(self):
        calls = []

        def fake_run(command, **_kwargs):
            calls.append(command)
            Path(command[-1]).parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGBA", (8, 8), (len(calls), 0, 0, 255)).save(command[-1])
            if "select=" in " ".join(command):
                stderr = "[showinfo] n:   0 pts: 1058 pts_time:1.033 duration_time:0.033"
            else:
                # The fast seek landed a full second early; this must not be accepted.
                stderr = "[showinfo] n:   0 pts:    0 pts_time:0 duration_time:0.033"
            return SimpleNamespace(stderr=stderr)

        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"TMPDIR": tmp}), \
                patch.object(frame_qa.subprocess, "run", side_effect=fake_run):
            sample = frame_qa.extract_frame("recording.mp4", 1.0, fps=30)

        self.assertEqual(sample.method, "coarse+timestamp")
        self.assertTrue(sample.reextracted)
        self.assertAlmostEqual(sample.requested_pts, 1.0)
        self.assertAlmostEqual(sample.delivered_pts, 1.033)
        self.assertAlmostEqual(sample.drift, 0.033)
        self.assertEqual(len(calls), 2)
        self.assertIn("-ss", calls[1])
        self.assertIn("0.000000000", calls[1])
        selector = calls[1][calls[1].index("-vf") + 1]
        self.assertIn(r"select=gte(t\,1.000000000),showinfo", selector)
        self.assertTrue(all("-start_at_zero" in call for call in calls))
        output_dirs = {Path(call[-1]).parent for call in calls}
        self.assertEqual(len(output_dirs), 2)
        self.assertTrue(all(path.name.startswith("capcutctl-frame-") for path in output_dirs))

    def test_one_frame_fast_seek_drift_is_reported_without_retry(self):
        calls = []

        def fake_run(command, **_kwargs):
            calls.append(command)
            Image.new("RGBA", (4, 4), "blue").save(command[-1])
            return SimpleNamespace(
                stderr="[showinfo] n: 0 pts: 1033 pts_time:1.033 duration_time:0.033"
            )

        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"TMPDIR": tmp}), \
                patch.object(frame_qa.subprocess, "run", side_effect=fake_run):
            sample = frame_qa.extract_frame("recording.mp4", 1.0, fps=30)

        self.assertEqual(sample.method, "fast-seek")
        self.assertFalse(sample.reextracted)
        self.assertEqual(len(calls), 1)
        self.assertAlmostEqual(sample.drift, 0.033)

    def test_qa_prints_requested_and_delivered_pts(self):
        sample = frame_qa.FrameSample(
            Image.new("RGBA", (2, 2)), 4.0, 4.033, 1 / 30, "coarse+timestamp", True
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            frame_qa.report_extractions(12.5, [("/tmp/screen.mp4", sample)])
        text = output.getvalue()
        self.assertIn("requested PTS 4.000000s", text)
        self.assertIn("delivered PTS 4.033000s", text)
        self.assertIn("re-extracted accurately", text)

    def test_nonzero_start_long_gop_returns_relative_pts_and_expected_frame(self):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            self.skipTest("ffmpeg and ffprobe are required for the real timestamp regression")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            colours = [(255, 0, 0)] * 4 + [(0, 255, 0)] * 4
            colours += [(0, 0, 255)] * 4 + [(255, 255, 0)] * 4
            for index, colour in enumerate(colours):
                Image.new("RGB", (64, 64), colour).save(root / f"frame {index:02d}.png")
            base = root / "base long-gop.mp4"
            offset = root / "shifted recording with spaces.mp4"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-framerate", "4", "-i", str(root / "frame %02d.png"),
                "-c:v", "libx264", "-preset", "ultrafast", "-g", "16",
                "-keyint_min", "16", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
                "-video_track_timescale", "1000", str(base),
            ], check=True)
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-itsoffset", "10",
                "-i", str(base), "-map", "0:v:0", "-c", "copy", "-copyts", str(offset),
            ], check=True)
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "format=start_time",
                "-of", "default=nw=1:nk=1", str(offset),
            ], check=True, capture_output=True, text=True)
            self.assertAlmostEqual(float(probe.stdout.strip()), 10.0, places=3)

            sample = frame_qa.extract_frame(str(offset), 2.25, fps=4, force_accurate=True)

        self.assertEqual(sample.method, "coarse+timestamp")
        self.assertAlmostEqual(sample.requested_pts, 2.25, places=3)
        self.assertAlmostEqual(sample.delivered_pts, 2.25, places=3)
        self.assertLessEqual(sample.drift, sample.frame_period + 1e-6)
        red, green, blue, _alpha = sample.image.getpixel((32, 32))
        self.assertGreater(blue, 150, (red, green, blue))
        self.assertGreater(blue, red * 2, (red, green, blue))
        self.assertGreater(blue, green * 2, (red, green, blue))


class PreviewAndSamplingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        project = Path(self.temp.name)
        (project / ".capcutctl").mkdir()
        (project / ".capcutctl" / "created.json").write_text(json.dumps({
            "contentEnd": 8_000_000,
            "preserved": {"start": 20_000_000, "end": 50_000_000},
        }))
        self.project = project
        self.tl = {
            "duration": 50_000_000,
            "fps": 30,
            "tracks": [
                {"type": "video", "flag": 0, "segments": []},
                {"type": "video", "name": "broll", "flag": 2, "segments": [
                    segment("b0", 0, 2, desc="broll: intro"),
                    segment("b1", 4, 2, desc="broll: files"),
                    segment("park-b", 20, 2, desc="template parts bin"),
                ]},
                {"type": "video", "name": "content", "flag": 2, "segments": [
                    segment("s0", 0, 4),
                    segment("s1", 4, 4),
                    segment("park-s", 20, 30, desc="template endcard"),
                ]},
                {"type": "video", "name": "layout", "flag": 2, "segments": [
                    segment("plate", 0, 8, material="PLATE", desc="layout:seam-bar"),
                ]},
            ],
            "materials": {
                "videos": [
                    {"id": "VIDEO", "path": "screen.mp4"},
                    {"id": "PLATE", "path": "seam.png"},
                ],
            },
        }
        (project / "screen.mp4").write_bytes(b"fixture")
        Image.new("RGB", (8, 8), "gray").save(project / "seam.png")
        self.tl["materials"]["videos"][0]["path"] = str(project / "screen.mp4")
        self.tl["materials"]["videos"][1]["path"] = str(project / "seam.png")

    def tearDown(self):
        self.temp.cleanup()

    def test_default_preview_range_stops_before_parked_parts_bin(self):
        self.assertEqual(
            frame_qa.content_edit_range(str(self.project), self.tl), (0.0, 8.0)
        )
        self.assertEqual(
            frame_qa.resolve_preview_range(str(self.project), self.tl), (0.0, 8.0)
        )
        self.assertEqual(
            frame_qa.resolve_preview_range(str(self.project), self.tl, 21, 24), (21.0, 24.0)
        )

    def test_legacy_preview_range_uses_maximum_eligible_segment_end(self):
        legacy = json.loads(json.dumps(self.tl))
        legacy["tracks"][2]["segments"].append(segment("late-scene", 9, 3))
        (self.project / ".capcutctl" / "created.json").write_text(json.dumps({
            "preserved": {"start": 20_000_000, "end": 50_000_000},
        }))
        self.assertEqual(
            frame_qa.content_edit_range(str(self.project), legacy), (0.0, 12.0)
        )

    def test_legacy_preview_range_clamps_to_parked_start_and_draft_end(self):
        legacy = json.loads(json.dumps(self.tl))
        legacy["tracks"][2]["segments"].append(segment("long-tail", 18, 10))
        (self.project / ".capcutctl" / "created.json").write_text(json.dumps({
            "preserved": {"start": 20_000_000, "end": 50_000_000},
        }))
        self.assertEqual(
            frame_qa.content_edit_range(str(self.project), legacy), (0.0, 20.0)
        )
        legacy["duration"] = 19_000_000
        self.assertEqual(
            frame_qa.content_edit_range(str(self.project), legacy), (0.0, 19.0)
        )

    def test_semantic_samples_merge_times_and_exclude_parked_clips(self):
        samples = frame_qa.qa_sample_times(
            self.tl,
            str(self.project),
            times="6,0,4,6",
            at_cuts=True,
            at_scenes=True,
            at_broll=True,
        )
        self.assertEqual(samples, [0.0, 1.0, 2.0, 4.0, 5.0, 6.0])
        self.assertEqual(frame_qa.merge_sample_times([4, 1, 4.0000001, 2]), [1.0, 2.0, 4.0])

    def test_at_broll_includes_screen_recording_but_excludes_generated_helpers(self):
        timeline = json.loads(json.dumps(self.tl))
        timeline["tracks"].append({
            "type": "video", "name": "generated-screen", "flag": 2, "segments": [
                segment("recording", 1, 1, desc="layout:screen-recording"),
                segment("frame", 2, 1, material="PLATE", desc="layout:screen-frame"),
                segment("pip", 3, 1, material="PLATE", desc="layout:screen-pip"),
                segment("blur", 4, 1, material="PLATE", desc="layout:screen-blur"),
                segment("ring", 5, 1, material="PLATE", desc="layout:screen-pip-ring"),
            ],
        })
        samples = frame_qa.qa_sample_times(
            timeline, str(self.project), at_broll=True
        )
        self.assertIn(1.5, samples)
        self.assertNotIn(2.5, samples)
        self.assertNotIn(3.5, samples)
        self.assertNotIn(4.5, samples)
        self.assertNotIn(5.5, samples)

    def test_missing_material_id_is_fatal_for_render_with_segment_details(self):
        broken = json.loads(json.dumps(self.tl))
        broken["tracks"][1]["segments"][0]["material_id"] = "MISSING-MATERIAL"
        with self.assertRaises(frame_qa.FrameExtractionError) as caught:
            frame_qa.render(str(self.project), broken, 0)
        message = str(caught.exception)
        self.assertIn("segment b0", message)
        self.assertIn("MISSING-MATERIAL", message)

    def test_missing_media_path_is_fatal_for_preview_and_has_path_details(self):
        broken = json.loads(json.dumps(self.tl))
        broken["materials"]["videos"][0]["path"] = str(self.project / "missing clip.mp4")
        output = self.project / "should-not-exist.mp4"
        with self.assertRaises(frame_qa.FrameExtractionError) as caught:
            frame_qa.write_preview(
                str(self.project), broken, str(output), fps=2, start=0, end=1
            )
        message = str(caught.exception)
        self.assertIn("segment b0", message)
        self.assertIn("missing clip.mp4", message)
        self.assertFalse(output.exists())

    def test_allow_missing_is_an_explicit_degraded_render(self):
        broken = json.loads(json.dumps(self.tl))
        broken["materials"]["videos"][0]["path"] = str(self.project / "missing clip.mp4")
        _image, rows, _width, _height = frame_qa.render(
            str(self.project), broken, 0, allow_missing=True
        )
        self.assertTrue(any(row[2].startswith("MISSING:") for row in rows))

    def test_write_preview_uses_explicit_relative_range_for_frames_and_audio(self):
        rendered = []
        audio_ranges = []

        def fake_render(_project, _tl, time, _z):
            rendered.append(time)
            return Image.new("RGBA", (4, 4)), [], 4, 4

        def fake_audio(_project, _tl, _tmp, duration, range_start):
            audio_ranges.append((duration, range_start))
            return None

        with patch.object(frame_qa, "render", side_effect=fake_render), \
                patch.object(frame_qa, "_timeline_audio", side_effect=fake_audio), \
                patch.object(frame_qa.subprocess, "run", return_value=SimpleNamespace()):
            output = frame_qa.write_preview(
                str(self.project), self.tl, str(self.project / "preview.mp4"),
                fps=2, start=4, end=6,
            )

        self.assertEqual(output, str(self.project / "preview.mp4"))
        self.assertTrue(rendered)
        self.assertGreaterEqual(min(rendered), 4.0)
        self.assertLess(max(rendered), 6.0)
        self.assertEqual(audio_ranges, [(2.0, 4.0)])

    def test_write_preview_defaults_to_content_end_not_draft_tail(self):
        rendered = []

        def fake_render(_project, _tl, time, _z):
            rendered.append(time)
            return Image.new("RGBA", (4, 4)), [], 4, 4

        with patch.object(frame_qa, "render", side_effect=fake_render), \
                patch.object(frame_qa, "_timeline_audio", return_value=None), \
                patch.object(frame_qa.subprocess, "run", return_value=SimpleNamespace()):
            frame_qa.write_preview(
                str(self.project), self.tl, str(self.project / "default-preview.mp4"), fps=2
            )

        self.assertTrue(rendered)
        self.assertGreaterEqual(min(rendered), 0.0)
        self.assertLess(max(rendered), 8.0)

    def test_preview_cli_accepts_bounds_and_prints_the_rendered_range(self):
        output = io.StringIO()
        with patch.object(sys, "argv", [
                "frame_qa.py", "--project", str(self.project), "--preview",
                str(self.project / "preview.mp4"), "--from", "2", "--to", "5",
        ]), patch.object(frame_qa, "load_project", return_value=(
                str(self.project), self.tl, str(self.project / "draft_info.json")
        )), patch.object(frame_qa, "write_preview", return_value=str(self.project / "preview.mp4")), \
                contextlib.redirect_stdout(output):
            frame_qa.main()

        self.assertIn("rendered range: 2.000s -> 5.000s", output.getvalue())


class RealFfmpegPreviewTests(unittest.TestCase):
    def test_video_only_preview_does_not_overrun_requested_range(self):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            self.skipTest("ffmpeg and ffprobe are required for the real preview regression")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "still frame with spaces.png"
            Image.new("RGB", (32, 32), (30, 80, 180)).save(media)
            timeline = {
                "duration": 2_000_000,
                "canvas_config": {"width": 32, "height": 32},
                "tracks": [{
                    "type": "video", "name": "content", "flag": 2, "segments": [{
                        "id": "content", "material_id": "STILL", "volume": 0,
                        "target_timerange": {"start": 0, "duration": 2_000_000},
                        "source_timerange": {"start": 0, "duration": 2_000_000},
                    }],
                }],
                "materials": {"videos": [{"id": "STILL", "path": str(media)}]},
            }
            output = root / "preview with spaces.mp4"
            requested = 1.01
            frame_qa.write_preview(
                str(root), timeline, str(output), fps=6, start=0, end=requested
            )
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries",
                "format=duration:stream=nb_frames", "-of", "default=nw=1", str(output),
            ], check=True, capture_output=True, text=True)
            values = dict(line.split("=", 1) for line in probe.stdout.splitlines() if "=" in line)

        self.assertLessEqual(float(values["duration"]), requested + 1e-3)
        self.assertAlmostEqual(float(values["duration"]), 1.0, places=2)
        self.assertEqual(int(values["nb_frames"]), 6)


if __name__ == "__main__":
    unittest.main()
