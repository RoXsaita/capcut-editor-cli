"""CLI worker for isolated caption ASR jobs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .asr import transcribe_word_level


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one ASR job and write JSON output")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", default="ar")
    parser.add_argument("--model-size")
    args = parser.parse_args()

    result = transcribe_word_level(
        args.input,
        language=args.language,
        model_size=args.model_size,
    )
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_suffix(output_path.suffix + ".tmp")
    temp_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    temp_path.replace(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
