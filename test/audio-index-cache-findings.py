#!/usr/bin/env python3
"""Regression coverage for source tokens and derived-audio cache invalidation."""
import json
import os
import shutil
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from audio_index import AudioIndex, same_source, source_token


def write_pcm(path, amplitude, frames=16000):
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        sample = int(amplitude).to_bytes(2, "little", signed=True)
        handle.writeframes(sample * frames)


class AudioIndexCacheFindingsTest(unittest.TestCase):
    def test_pcm_widths_stereo_and_trailing_partial_bin_retain_speech(self):
        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "take.wav"
            for width in (1, 2, 3, 4):
                for channels in (1, 2):
                    with self.subTest(width=width, channels=channels):
                        silence = (128 if width == 1 else 0).to_bytes(width, "little", signed=width > 1)
                        loud = (192 if width == 1 else 2 ** (width * 8 - 2)).to_bytes(
                            width, "little", signed=width > 1)
                        with wave.open(str(media), "wb") as handle:
                            handle.setnchannels(channels)
                            handle.setsampwidth(width)
                            handle.setframerate(16000)
                            handle.writeframes(silence * channels * 160
                                               + (silence * (channels - 1) + loud) * 161)
                        index = AudioIndex.from_wav(media)
                        self.assertEqual(len(index.db), 3)
                        self.assertLess(index.at(0), -100)
                        self.assertGreater(index.at(0.01), -10)
                        self.assertGreater(index.at(0.02), -10)
                        self.assertEqual(index.at(-0.001), -99)

    def test_exact_bin_end_is_retained_and_invalid_bins_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "take.wav"
            write_pcm(media, 20000, frames=160)
            self.assertEqual(len(AudioIndex.from_wav(media).db), 1)
            for bin_ms in (0, -1, float("nan"), float("inf")):
                with self.subTest(bin_ms=bin_ms), self.assertRaisesRegex(ValueError, "bin size"):
                    AudioIndex.from_wav(media, bin_ms=bin_ms)

    def test_audio_token_catches_same_size_fast_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "take.mp4"
            media.write_bytes(b"A" * 8192)
            original_stat = media.stat()
            before = source_token(media)
            media.write_bytes(b"B" * 8192)
            os.utime(media, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
            after = AudioIndex._token(media)

            self.assertEqual(before["ino"], after["ino"])
            self.assertEqual(before["size"], after["size"])
            self.assertEqual(before["mtime_ns"], after["mtime_ns"])
            self.assertNotEqual(before["content_hash"], after["content_hash"])

    def test_changed_source_regenerates_stale_derived_wav_before_energy_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "take.mp4"
            media.write_bytes(b"A" * 8192)
            old_token = AudioIndex._token(media)
            original_stat = media.stat()
            media.write_bytes(b"B" * 8192)
            os.utime(media, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

            cache = root / "cache"
            cache.mkdir()
            derived = cache / "take.16k.wav"
            write_pcm(derived, 1000)
            stale_bytes = derived.read_bytes()
            (cache / "take.energy10.json").write_text(json.dumps({
                "bin": 0.01,
                "db": [-30.0],
                "token": old_token,
            }))

            calls = []

            def fake_ffmpeg(command, check):
                calls.append(command)
                write_pcm(command[-1], 20000)

            with patch("audio_index.subprocess.run", side_effect=fake_ffmpeg):
                index = AudioIndex.build_or_load(media, cache_dir=cache)

            self.assertEqual(len(calls), 1)
            self.assertNotEqual(Path(calls[0][-1]), derived)
            self.assertNotEqual(derived.read_bytes(), stale_bytes)
            self.assertGreater(index.at(0), -10.0)
            keyed = list(cache.glob("take.energy10.*.json"))
            self.assertEqual(len(keyed), 1, "the rebuilt index is written under its content key")
            stamped = json.loads(keyed[0].read_text())
            self.assertEqual(stamped["token"], AudioIndex._token(media))
            legacy = json.loads((cache / "take.energy10.json").read_text())
            self.assertEqual(legacy["token"], old_token, "the legacy unkeyed file is never overwritten")

    def test_same_named_takes_keep_their_own_energy_files_and_copies_hit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, second = root / "one" / "screen.mp4", root / "two" / "screen.mp4"
            first.parent.mkdir()
            second.parent.mkdir()
            first.write_bytes(b"A" * 8192)
            second.write_bytes(b"B" * 8192)
            cache = root / "cache"
            calls = []

            def fake_ffmpeg(command, check):
                calls.append(command)
                write_pcm(command[-1], 20000 if "one" in command[5] else 1000)

            with patch("audio_index.subprocess.run", side_effect=fake_ffmpeg):
                loud = AudioIndex.build_or_load(first, cache_dir=cache)
                quiet = AudioIndex.build_or_load(second, cache_dir=cache)
                self.assertEqual(len(list(cache.glob("screen.energy10.*.json"))), 2)
                self.assertEqual(AudioIndex.build_or_load(first, cache_dir=cache).db, loud.db)
                self.assertEqual(len(calls), 2, "the second call on the first take is a cache hit")

                copy = root / "proj" / "Downloads__screen.mp4"
                copy.parent.mkdir()
                shutil.copy2(first, copy)
                stat = first.stat()
                os.utime(first, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
                self.assertEqual(AudioIndex.build_or_load(first, cache_dir=cache).db, loud.db)
                self.assertEqual(len(calls), 2, "touching the original keeps its index")
                stamps = [json.loads(path.read_text())["token"] for path in cache.glob("screen.energy10.*.json")]
                self.assertIn(source_token(first), stamps, "the hit is re-stamped for mtime-checking readers")
            self.assertNotEqual(loud.db, quiet.db)

            # A copy has its own stem, so it has its own file name; the bytes still say it is
            # the same source (see find.py and src/video-index.mjs for the cross-name lookup).
            self.assertTrue(same_source(source_token(copy), source_token(first)))
            first.write_bytes(b"C" * 8192)
            os.utime(first, ns=(stat.st_atime_ns, stat.st_mtime_ns))
            self.assertFalse(same_source(source_token(copy), source_token(first)))


if __name__ == "__main__":
    unittest.main()
