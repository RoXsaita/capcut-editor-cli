import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import find  # noqa: E402
import frame_qa  # noqa: E402


class FindAccurateFramesTests(unittest.TestCase):
    def test_strip_uses_shared_frame_extractor_and_reports_pts(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "cache"
            cache.mkdir()
            media = Path(tmp) / "screen recording.mp4"
            media.write_bytes(b"fixture")
            (cache / "screen recording.ocr.json").write_text(json.dumps({
                "10": "hello world",
                "11": "hello world",
            }))
            strip = Path(tmp) / "strip.png"
            sample = frame_qa.FrameSample(
                Image.new("RGBA", (8, 8), "green"), 10.0, 10.033, 1 / 30,
                "coarse+timestamp", True,
            )
            output = io.StringIO()
            with patch.object(find, "CACHE", str(cache)), \
                    patch.object(frame_qa, "extract_frame", return_value=sample) as extractor, \
                    patch.object(frame_qa, "contact_sheet", return_value=str(strip)) as sheet, \
                    patch.dict(os.environ, {"TMPDIR": tmp}), \
                    patch.object(sys, "argv", [
                        "find.py", "hello", "--media", str(media), "--shows",
                        "--strip", str(strip),
                    ]), \
                    contextlib.redirect_stdout(output):
                find.main()

            self.assertEqual(extractor.call_count, 1)
            extractor.assert_called_once_with(str(media), 10)
            text = output.getvalue()
            self.assertIn("requested PTS 10.000000s", text)
            self.assertIn("delivered PTS 10.033000s", text)
            self.assertIn("re-extracted accurately", text)
            tiles = sheet.call_args.args[0]
            self.assertEqual(len(tiles), 1)
            tile_path = Path(tiles[0][0])
            self.assertTrue(tile_path.parent.name.startswith("capcutctl-find-"))
            self.assertNotEqual(tile_path.parent, Path(tmp) / "capcutctl-find")
            self.assertEqual(tile_path.name, "f000.png")


if __name__ == "__main__":
    unittest.main()
