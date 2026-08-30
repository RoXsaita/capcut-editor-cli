#!/usr/bin/env python3
"""Focused acoustic lint regression tests; run directly with Python 3.11+."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from audio_index import AudioIndex, first_word_clipped, lint


class AudioIndexFindingsTest(unittest.TestCase):
    def test_lint_flags_a_flat_loud_out_not_only_a_rising_one(self):
        db = [-70.0] * 180
        for i in range(20, 140):
            db[i] = -20.0
        idx = AudioIndex(db, 0.01)

        findings = lint(idx, [("tutorial", 0.20, 1.00)])

        self.assertTrue(any("LOUD_BOUNDARY" in finding for finding in findings), findings)
        self.assertFalse(any("rising envelope" in finding for finding in findings), findings)

    def test_lint_blocks_a_trusted_first_word_clip_and_ignores_untrusted_timing(self):
        idx = AudioIndex([-70.0] * 200, 0.01)
        clipped = lint(
            idx,
            [("cta", 1.00, 1.50)],
            first_word_starts=[{"start": 0.80, "word": "مرحبا", "trustworthy": True}],
        )
        untrusted = lint(
            idx,
            [("cta", 1.00, 1.50)],
            first_word_starts=[{"start": 0.80, "word": "مرحبا", "trustworthy": False}],
        )

        self.assertTrue(any("FIRST_WORD_CLIPPED" in finding for finding in clipped), clipped)
        self.assertFalse(any("FIRST_WORD_CLIPPED" in finding for finding in untrusted), untrusted)

    def test_first_word_tolerance_is_frame_based(self):
        self.assertFalse(first_word_clipped(1.0, 1.0 - 0.5 / 30.0, fps=30))
        self.assertTrue(first_word_clipped(1.0, 1.0 - 0.6 / 30.0, fps=30))


if __name__ == "__main__":
    unittest.main()
