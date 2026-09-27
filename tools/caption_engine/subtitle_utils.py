"""Script-aware subtitle helpers (adapted from ai-video-captions)."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ScriptConfig:
    languages: frozenset
    char_width_ratio: float
    font_scale: float
    is_rtl: bool = False


SCRIPT_REGISTRY: dict[str, ScriptConfig] = {
    "latin": ScriptConfig(
        languages=frozenset(
            {
                "en",
                "es",
                "fr",
                "de",
                "pt",
                "it",
                "nl",
                "pl",
                "tr",
                "id",
                "ms",
                "vi",
                "sw",
            }
        ),
        char_width_ratio=0.55,
        font_scale=1.0,
    ),
    "arabic": ScriptConfig(
        languages=frozenset({"ar", "ur", "fa"}),
        char_width_ratio=0.62,
        # Suheil captions are large; keep closer to Latin scale than stock 0.50
        font_scale=0.95,
        is_rtl=True,
    ),
    "cjk": ScriptConfig(
        languages=frozenset({"zh", "ja", "ko"}),
        char_width_ratio=1.05,
        font_scale=0.65,
    ),
}

_DEFAULT = ScriptConfig(languages=frozenset(), char_width_ratio=0.70, font_scale=0.70)
_TARGET_LINE_WIDTH_PX = 820


def get_script_config(language: str) -> tuple[str, ScriptConfig]:
    lang = (language or "ar").split("-")[0].lower()
    for name, cfg in SCRIPT_REGISTRY.items():
        if lang in cfg.languages:
            return name, cfg
    return "unknown", _DEFAULT


def is_latin_language(language: str) -> bool:
    return get_script_config(language)[0] == "latin"


def is_rtl_language(language: str) -> bool:
    return get_script_config(language)[1].is_rtl


def get_subtitle_layout(language: str, font_size: int = 92) -> tuple[int, float]:
    _, cfg = get_script_config(language)
    effective = font_size * cfg.font_scale
    avg = max(8.0, effective * cfg.char_width_ratio)
    # Arabic captions on Suheil channel are short phrases — keep lines tight
    max_chars = max(6, min(18, int(_TARGET_LINE_WIDTH_PX / avg)))
    if is_rtl_language(language):
        max_chars = min(max_chars, 12)
    return max_chars, cfg.font_scale


def strip_emojis(text: str) -> str:
    emoji_pattern = re.compile(
        "["
        "\U0001F600-\U0001F64F"
        "\U0001F300-\U0001F5FF"
        "\U0001F680-\U0001F6FF"
        "\U0001F1E0-\U0001F1FF"
        "\U00002500-\U00002BEF"
        "\U00002702-\U000027B0"
        "\U000024C2-\U0001F251"
        "\U0001f926-\U0001f937"
        "\U00010000-\U0010ffff"
        "]+",
        flags=re.UNICODE,
    )
    return emoji_pattern.sub("", text or "").strip()


def escape_ass_text(text: str) -> str:
    text = (text or "").replace("\\", "\\\\")
    text = text.replace("{", "\\{").replace("}", "\\}")
    text = text.replace("\n", " ")
    return text
