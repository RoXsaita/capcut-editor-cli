"""Caption style loader (adapted from ai-video-captions)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

_CONFIG_PATH = Path(__file__).parent / "styles.json"


@dataclass(frozen=True)
class CaptionStyle:
    id: str
    name: str
    font_name: str
    font_name_fallback: str
    font_size: int
    primary_color: str  # ASS
    highlight_color: str  # ASS
    outline_color: str  # ASS
    shadow_color: str  # ASS
    outline_size: float
    box_border_size: float
    box_padding_x: int
    box_padding_y: int
    box_radius: int
    render_mode: str
    shadow_depth: float
    bold: bool
    italic: bool
    letter_spacing: float
    word_spacing: int
    animation_type: str
    uppercase: bool


def _clamp(v: int) -> int:
    return max(0, min(255, int(v)))


def hex_to_ass(hex_color: str, alpha: int = 0) -> str:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    a = _clamp(alpha)
    return f"&H{a:02X}{_clamp(b):02X}{_clamp(g):02X}{_clamp(r):02X}"


def _load() -> dict:
    return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))


def list_styles() -> list[dict]:
    cfg = _load()
    out = []
    for sid, s in cfg["styles"].items():
        out.append(
            {
                "id": sid,
                "name": s["name"],
                "description": s.get("description", ""),
            }
        )
    return out


def default_style_id() -> str:
    return _load().get("defaults", {}).get("styleId", "suheil")


def default_caption_position() -> int:
    # 20% from the bottom is the full-screen-face preset.
    return int(_load().get("defaults", {}).get("captionPosition", 20))


def get_style(style_id: str | None = None) -> CaptionStyle:
    cfg = _load()
    sid = style_id or cfg.get("defaults", {}).get("styleId", "suheil")
    if sid not in cfg["styles"]:
        raise ValueError(f"Unknown caption style: {sid}")
    s = cfg["styles"][sid]
    return CaptionStyle(
        id=s["id"],
        name=s["name"],
        font_name=s["fontName"],
        font_name_fallback=s["fontNameFallback"],
        font_size=int(s["fontSize"]),
        primary_color=hex_to_ass(s["primaryColor"]),
        highlight_color=hex_to_ass(s["highlightColor"]),
        outline_color=hex_to_ass(s["outlineColor"]),
        shadow_color=hex_to_ass(s["shadowColor"], alpha=int(s.get("shadowAlpha", 0))),
        outline_size=float(s.get("outlineSize", 0)),
        box_border_size=float(s.get("boxBorderSize", s.get("outlineSize", 0))),
        box_padding_x=int(s.get("boxPaddingX", 20)),
        box_padding_y=int(s.get("boxPaddingY", 12)),
        box_radius=int(s.get("boxRadius", 12)),
        render_mode=s.get("renderMode", "glyph_outline"),
        shadow_depth=float(s["shadowDepth"]),
        bold=bool(s["bold"]),
        italic=bool(s["italic"]),
        letter_spacing=float(s.get("letterSpacing", 0)),
        word_spacing=int(s.get("wordSpacing", 100)),
        animation_type=s.get("animationType", "none"),
        uppercase=bool(s.get("uppercase", False)),
    )
