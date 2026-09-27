"""ASR backends for on-screen captions.

Preference order on Apple Silicon:
1. mlx-whisper large-v3-turbo (Metal)
2. faster-whisper large-v3-turbo / distil-large-v3
3. faster-whisper base (last resort)
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("dashboard.caption_asr")

# Env overrides
# CAPTION_ASR_BACKEND=mlx|faster|auto
# CAPTION_ASR_MODEL=mlx-community/whisper-large-v3-turbo | large-v3-turbo | base
DEFAULT_MLX_REPO = os.environ.get(
    "CAPTION_ASR_MODEL_MLX",
    "mlx-community/whisper-large-v3-turbo",
)
DEFAULT_FW_MODEL = os.environ.get("CAPTION_ASR_MODEL_FW", "large-v3-turbo")
DEFAULT_BACKEND = os.environ.get("CAPTION_ASR_BACKEND", "auto").strip().lower()


def transcribe_word_level_isolated(
    video_path: str | Path,
    *,
    language: str = "ar",
    model_size: str | None = None,
    timeout: int = 3600,
    popen_factory: Any = subprocess.Popen,
) -> dict:
    """Run ASR in a child process so MLX/Metal memory dies with the job."""
    dashboard_dir = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    path_parts = ["/opt/homebrew/bin", "/usr/local/bin", env.get("PATH", "")]
    env["PATH"] = ":".join(part for part in path_parts if part)

    with tempfile.TemporaryDirectory(prefix="caption-asr-") as temp_dir:
        output_path = Path(temp_dir) / "transcript.json"
        command = [
            sys.executable,
            "-m",
            "caption_engine.asr_worker",
            "--input",
            str(Path(video_path).resolve()),
            "--output",
            str(output_path),
            "--language",
            language,
        ]
        if model_size:
            command.extend(["--model-size", model_size])
        try:
            process = popen_factory(
                command,
                cwd=str(dashboard_dir),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                start_new_session=True,
            )
        except OSError as exc:
            raise RuntimeError(f"ASR worker could not start: {exc}") from exc
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            detail = (stderr or stdout or "").strip()
            suffix = f": {detail[-2000:]}" if detail else ""
            raise RuntimeError(f"ASR worker timed out after {timeout}s{suffix}") from exc
        if process.returncode != 0:
            detail = (stderr or stdout or "unknown ASR worker error").strip()
            raise RuntimeError(f"ASR worker failed: {detail[-2000:]}")
        if not output_path.exists():
            raise RuntimeError("ASR worker completed without a transcript")
        try:
            return json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"ASR worker returned an invalid transcript: {exc}") from exc


def _norm_word_entry(w: Any) -> dict | None:
    if isinstance(w, dict):
        token = str(w.get("word") or w.get("text") or "").strip()
        if not token:
            return None
        return {
            "word": token,
            "start": float(w.get("start") or 0.0),
            "end": float(w.get("end") or w.get("start") or 0.0),
            "probability": float(w.get("probability") or w.get("prob") or 0.0),
        }
    # object-like
    token = str(getattr(w, "word", "") or getattr(w, "text", "") or "").strip()
    if not token:
        return None
    return {
        "word": token,
        "start": float(getattr(w, "start", 0.0) or 0.0),
        "end": float(getattr(w, "end", getattr(w, "start", 0.0)) or 0.0),
        "probability": float(getattr(w, "probability", 0.0) or 0.0),
    }


def _transcribe_mlx(video_path: str | Path, *, language: str = "ar") -> dict:
    import mlx_whisper

    repo = DEFAULT_MLX_REPO
    t0 = time.time()
    out = mlx_whisper.transcribe(
        str(video_path),
        path_or_hf_repo=repo,
        language=language or None,
        word_timestamps=True,
        verbose=False,
    )
    elapsed = time.time() - t0
    segments = []
    for seg in out.get("segments") or []:
        words = []
        for w in seg.get("words") or []:
            nw = _norm_word_entry(w)
            if nw:
                # mlx sometimes prefixes space
                nw["word"] = nw["word"].strip()
                if nw["word"]:
                    words.append(nw)
        text = str(seg.get("text") or "").strip()
        segments.append(
            {
                "start": float(seg.get("start") or (words[0]["start"] if words else 0.0)),
                "end": float(seg.get("end") or (words[-1]["end"] if words else 0.0)),
                "text": text,
                "words": words,
            }
        )
    return {
        "language": out.get("language") or language or "ar",
        "segments": segments,
        "text": (out.get("text") or "").strip(),
        "backend": "mlx-whisper",
        "model": repo,
        "elapsed_sec": round(elapsed, 2),
    }


def _transcribe_faster(
    video_path: str | Path,
    *,
    language: str = "ar",
    model_size: str | None = None,
) -> dict:
    from faster_whisper import WhisperModel

    size = model_size or DEFAULT_FW_MODEL
    t0 = time.time()
    # Prefer int8 on CPU; large models still usable on M4 via CTranslate2
    try:
        model = WhisperModel(size, device="cpu", compute_type="int8")
    except Exception:
        model = WhisperModel("base", device="cpu", compute_type="int8")
        size = "base"
    segments_iter, info = model.transcribe(
        str(video_path),
        language=language or None,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=400),
        beam_size=5,
    )
    segments = []
    for seg in segments_iter:
        words = []
        for w in seg.words or []:
            nw = _norm_word_entry(w)
            if nw:
                words.append(nw)
        text = (seg.text or "").strip()
        segments.append(
            {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": text,
                "words": words,
            }
        )
    elapsed = time.time() - t0
    text = " ".join(s["text"] for s in segments if s["text"]).strip()
    return {
        "language": getattr(info, "language", None) or language or "ar",
        "segments": segments,
        "text": text,
        "backend": "faster-whisper",
        "model": size,
        "elapsed_sec": round(elapsed, 2),
    }


def transcribe_word_level(
    video_path: str | Path,
    *,
    language: str = "ar",
    model_size: str | None = None,
) -> dict:
    """Return unified transcript dict with word timestamps + backend metadata."""
    backend = DEFAULT_BACKEND
    errors: list[str] = []

    prefer_mlx = backend in ("auto", "mlx")
    if prefer_mlx:
        try:
            result = _transcribe_mlx(video_path, language=language)
            if result.get("segments"):
                log.info(
                    "ASR mlx ok model=%s elapsed=%.1fs segs=%d",
                    result.get("model"),
                    result.get("elapsed_sec") or 0,
                    len(result["segments"]),
                )
                return result
            errors.append("mlx returned empty segments")
        except Exception as exc:
            errors.append(f"mlx failed: {exc}")
            log.warning("mlx-whisper failed: %s", exc)

    if backend in ("auto", "faster"):
        try:
            size = model_size or DEFAULT_FW_MODEL
            result = _transcribe_faster(video_path, language=language, model_size=size)
            if result.get("segments"):
                log.info(
                    "ASR faster-whisper ok model=%s elapsed=%.1fs segs=%d",
                    result.get("model"),
                    result.get("elapsed_sec") or 0,
                    len(result["segments"]),
                )
                return result
            errors.append("faster-whisper returned empty segments")
        except Exception as exc:
            errors.append(f"faster failed: {exc}")
            log.warning("faster-whisper failed: %s", exc)

    # last resort base
    result = _transcribe_faster(video_path, language=language, model_size="base")
    result["fallback_errors"] = errors
    return result
