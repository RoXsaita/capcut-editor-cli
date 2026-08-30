#!/usr/bin/env python3
"""Regression coverage for source tokens and derived-audio cache invalidation."""
import json
import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from audio_index import AudioIndex, source_token


def write_pcm(path, amplitude, frames=16000):
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        sample = int(amplitude).to_bytes(2, "little", signed=True)
        handle.writeframes(sample * frames)


class AudioIndexCacheFindingsTest(unittest.TestCase):
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
            stamped = json.loads((cache / "take.energy10.json").read_text())
            self.assertEqual(stamped["token"], AudioIndex._token(media))


if __name__ == "__main__":
    unittest.main()
