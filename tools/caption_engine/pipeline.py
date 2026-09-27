"""Caption pipeline: whisper words → cues → ASS → burn.

Adapted from ai-video-captions (MIT). Arabic-safe (no forced uppercase).
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path

import pysubs2

from .styles import CaptionStyle, default_caption_position, default_style_id, get_style, list_styles
from .subtitle_utils import (
    escape_ass_text,
    get_subtitle_layout,
    is_latin_language,
    is_rtl_language,
    strip_emojis,
)

__all__ = [
    "burn_ass",
    "build_ass_from_cues",
    "cues_to_vtt",
    "default_style_id",
    "ffmpeg_enable_expression",
    "generate_cues_from_transcript",
    "list_styles",
    "render_cue_window",
    "transcribe_word_level",
]

log = logging.getLogger("dashboard.caption_engine")


def _ffmpeg_bin() -> str:
    """Resolve ffmpeg even when LaunchAgent PATH is stripped."""
    env = (os.environ.get("FFMPEG_BIN") or "").strip()
    if env and Path(env).exists():
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    for candidate in (
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ):
        if Path(candidate).exists():
            return candidate
    return "ffmpeg"


def _ffprobe_bin() -> str:
    env = (os.environ.get("FFPROBE_BIN") or "").strip()
    if env and Path(env).exists():
        return env
    found = shutil.which("ffprobe")
    if found:
        return found
    ff = _ffmpeg_bin()
    if ff.endswith("ffmpeg"):
        cand = ff[: -len("ffmpeg")] + "ffprobe"
        if Path(cand).exists():
            return cand
    for candidate in (
        "/opt/homebrew/bin/ffprobe",
        "/usr/local/bin/ffprobe",
        "/usr/bin/ffprobe",
    ):
        if Path(candidate).exists():
            return candidate
    return "ffprobe"


def transcribe_word_level(
    video_path: str | Path,
    *,
    language: str = "ar",
    model_size: str | None = None,
) -> dict:
    """Return {language, segments, backend metadata} with word-level timestamps."""
    from .asr import transcribe_word_level_isolated as _asr

    return _asr(video_path, language=language, model_size=model_size)


_TATWEEL = "\u0640"
_DIACRITIC_RE = re.compile(r"[\u064B-\u065F\u0670]")
_PUNCT_STRIP = ".,!?؟،:؛\"'()[]{}"
# True clitics: optional و/ف/ب/ل/ك + optional ال. Matching uses tatweel-stripped text.
_PREFIX_RE = re.compile(r"^(?:و|ف|ب|ل|ك)?(?:ال)?$")
_FUNCTION_WORDS = frozenset(
    {
        "في",
        "من",
        "على",
        "إلى",
        "الى",
        "عن",
        "مع",
        "أو",
        "او",
        "ثم",
        "قد",
        "لا",
        "ما",
        "هذا",
        "هذه",
        "ذلك",
        "ان",
        "أن",
        "إن",
        "يا",
        "هو",
        "هي",
        "هم",
        "أنا",
        "انا",
        "أنت",
        "انت",
        "يعني",
        "هون",
    }
)
_LATIN_AL = frozenset({"al", "Al", "AL"})


def _norm_tok(token: str) -> str:
    text = _DIACRITIC_RE.sub("", token or "")
    text = text.replace(_TATWEEL, "")
    return text.strip(_PUNCT_STRIP).strip()


def _has_arabic(token: str) -> bool:
    return any("\u0600" <= ch <= "\u06FF" for ch in token or "")


def _is_prefix_token(token: str) -> bool:
    """Orthographic prefix: و/ب/ل/ف/ك/ال/الـ/والـ and Latin AL."""
    if (token or "").strip() in _LATIN_AL:
        return True
    normalized = _norm_tok(token)
    return bool(normalized and _PREFIX_RE.match(normalized))


def _is_glue_particle(token: str) -> bool:
    """Orphan prefixes / particles that must not occupy a full-screen cue alone."""
    if _is_prefix_token(token):
        return True
    return _norm_tok(token) in _FUNCTION_WORDS


def _token_count(text: str) -> int:
    return len([part for part in str(text).split() if part])


def join_particle_display(particle: str, neighbor: str) -> str:
    """Keep the particle on screen. Max two tokens. الـ sits with the noun.

    Prefix + Arabic noun concatenates (الكتاب / وكتاب) so the default stays
    one visual word. Prefix + Latin keeps a space (الـ CV). Function words
    join with a space (يعني فراطة). Latin AL is rewritten to Arabic الـ.
    """
    raw_particle = str(particle or "").strip()
    raw_neighbor = str(neighbor or "").strip()
    if not raw_particle:
        return raw_neighbor
    if not raw_neighbor:
        return raw_particle

    normalized = _norm_tok(raw_particle)
    is_latin_al = raw_particle in _LATIN_AL
    is_prefix = is_latin_al or bool(normalized and _PREFIX_RE.match(normalized))

    if is_prefix and not _has_arabic(raw_neighbor):
        prefix = raw_particle
        if is_latin_al or normalized == "ال":
            prefix = f"ال{_TATWEEL}"
        elif normalized.endswith("ال") and not raw_particle.endswith(_TATWEEL):
            prefix = f"{raw_particle}{_TATWEEL}"
        return f"{prefix} {raw_neighbor}"

    if is_prefix and _has_arabic(raw_neighbor):
        prefix = "ال" if is_latin_al else raw_particle.replace(_TATWEEL, "")
        neighbor_norm = _norm_tok(raw_neighbor)
        if prefix.endswith("ال") and neighbor_norm.startswith("ال"):
            return raw_neighbor
        return f"{prefix}{raw_neighbor}"

    return f"{raw_particle} {raw_neighbor}"


def generate_cues_from_transcript(
    transcript: dict,
    *,
    language: str | None = None,
    style_id: str | None = None,
    max_lines: int = 2,
    mode: str | None = None,
    default_position: int | None = None,
) -> list[dict]:
    """Group word timestamps into editable cues.

    mode:
      - single (default): one on-screen word at a time (Suheil CapCut style)
      - phrase: short 2–3 word chunks
    Single-word mode may emit one 2-word cue when a particle/prefix would
    otherwise appear alone. Particles are shown, never dropped.
    Each cue may include position (% from bottom); None means track default.
    """
    lang = language or transcript.get("language") or "ar"
    style = get_style(style_id or default_style_id())
    max_chars, _ = get_subtitle_layout(lang, style.font_size)
    cue_mode = (mode or os.environ.get("CAPTION_CUE_MODE") or "single").strip().lower()
    if cue_mode in ("word", "single_word", "words"):
        cue_mode = "single"
    if cue_mode not in ("single", "phrase"):
        cue_mode = "single"
    base_pos = int(
        default_position
        if default_position is not None
        else default_caption_position()
    )
    base_pos = max(5, min(85, base_pos))

    words: list[dict] = []
    for seg in transcript.get("segments") or []:
        if seg.get("words"):
            for w in seg["words"]:
                token = strip_emojis(str(w.get("word", "")).strip())
                if not token:
                    continue
                words.append(
                    {
                        "word": token,
                        "start": float(w["start"]),
                        "end": float(w["end"]),
                    }
                )
        else:
            text = strip_emojis(str(seg.get("text", "")).strip())
            if text:
                words.append(
                    {
                        "word": text,
                        "start": float(seg["start"]),
                        "end": float(seg["end"]),
                    }
                )

    if not words:
        return []

    # Glue orphan particles onto a neighbor (single-word mode). Show both.
    if cue_mode == "single":
        merged: list[dict] = []
        i = 0
        while i < len(words):
            w = words[i]
            if _is_glue_particle(w["word"]) and i + 1 < len(words):
                nxt = words[i + 1]
                nxt2 = words[i + 2] if i + 2 < len(words) else None
                # على + الـ + Gmail: do not pair the function word with الـ.
                # Keep الـ for the noun; park this particle on the previous cue.
                if (
                    nxt2 is not None
                    and _is_prefix_token(nxt["word"])
                    and not _is_glue_particle(nxt2["word"])
                ):
                    if merged and _token_count(merged[-1]["word"]) < 2:
                        prev = merged[-1]
                        prev["word"] = f"{prev['word']} {w['word']}".strip()
                        prev["end"] = max(float(prev["end"]), float(w["end"]))
                        prev["_src_words"] = list(prev.get("_src_words") or []) + [w]
                    else:
                        merged.append({**w, "_src_words": [w]})
                    i += 1
                    continue
                merged.append(
                    {
                        "word": join_particle_display(w["word"], nxt["word"]),
                        "start": w["start"],
                        "end": max(float(nxt["end"]), float(w["start"]) + 0.18),
                        "_src_words": [w, nxt],
                    }
                )
                i += 2
                continue
            if _is_glue_particle(w["word"]) and merged and _token_count(merged[-1]["word"]) < 2:
                # Last-token fallback only. Prefer the next noun when it exists.
                prev = merged[-1]
                if not _has_arabic(prev["word"]):
                    prev["word"] = join_particle_display(w["word"], prev["word"])
                else:
                    prev["word"] = f"{prev['word']} {w['word']}".strip()
                    if _token_count(prev["word"]) > 2:
                        prev["word"] = " ".join(prev["word"].split()[:2])
                prev["end"] = max(float(prev["end"]), float(w["end"]))
                prev["_src_words"] = list(prev.get("_src_words") or []) + [w]
                i += 1
                continue
            merged.append({**w, "_src_words": [w]})
            i += 1
        words = merged

        cues: list[dict] = []
        for w in words:
            text = re.sub(r"\s+", " ", str(w["word"]).strip())
            if not text:
                continue
            start = round(float(w["start"]), 3)
            end = round(float(w["end"]), 3)
            if end <= start:
                end = round(start + 0.28, 3)
            # slight pad for readability on single flashes
            if end - start < 0.22:
                end = round(start + 0.22, 3)
            src = w.get("_src_words") or [w]
            cues.append(
                {
                    "id": len(cues) + 1,
                    "start": start,
                    "end": end,
                    "text": text,
                    "position": base_pos,
                    "mode": "single",
                    "words": [
                        {
                            "word": sw["word"],
                            "start": round(float(sw["start"]), 3),
                            "end": round(float(sw["end"]), 3),
                        }
                        for sw in src
                    ],
                }
            )
        return cues

    # --- phrase mode (legacy) ---
    cues = []
    current: list[dict] = []
    current_chars = 0
    current_lines = 1

    def flush():
        nonlocal current, current_chars, current_lines
        if not current:
            return
        text = " ".join(w["word"] for w in current).strip()
        text = re.sub(r"\s+", " ", text)
        cues.append(
            {
                "id": len(cues) + 1,
                "start": round(current[0]["start"], 3),
                "end": round(current[-1]["end"], 3),
                "text": text,
                "position": base_pos,
                "mode": "phrase",
                "words": [
                    {
                        "word": w["word"],
                        "start": round(w["start"], 3),
                        "end": round(w["end"], 3),
                    }
                    for w in current
                ],
            }
        )
        current = []
        current_chars = 0
        current_lines = 1

    for w in words:
        token = w["word"]
        add = len(token) + (1 if current else 0)
        if current and re.search(r"[.!?؟،]$", current[-1]["word"]):
            flush()
        if current and (w["start"] - current[-1]["end"]) > 0.45:
            flush()
        if current and current_chars + add > max_chars:
            if current_lines < max_lines:
                current_lines += 1
                current_chars = len(token)
                current.append(w)
            else:
                flush()
                current = [w]
                current_chars = len(token)
                current_lines = 1
        else:
            current.append(w)
            current_chars += add
            if is_rtl_language(lang) and len(current) >= 3:
                flush()
            elif not is_rtl_language(lang) and len(current) >= 4:
                flush()

    flush()
    for c in cues:
        if c["end"] <= c["start"]:
            c["end"] = round(c["start"] + 0.35, 3)
    return cues


_CUE_RENDER_EPSILON = 0.001


def render_cue_window(cues: list[dict], index: int) -> tuple[float, float]:
    """Return a half-open ``[start, end)`` render window for one cue.

    ASR cues commonly meet exactly at a boundary. The old Pillow/ffmpeg
    fallback used ``between(t, start, end)``, which is inclusive at both ends
    and can briefly draw the outgoing and incoming captions together. Keep
    stored timing intact, but make every renderer use a tiny exclusive
    boundary so one frame has one caption.
    """
    cue = cues[index]
    try:
        start = max(0.0, float(cue.get("start", 0)))
    except (TypeError, ValueError):
        start = 0.0
    try:
        end = float(cue.get("end", start + 0.35))
    except (TypeError, ValueError):
        end = start + 0.35
    end = max(start + _CUE_RENDER_EPSILON, end)

    if index + 1 < len(cues):
        try:
            next_start = max(0.0, float(cues[index + 1].get("start", end)))
        except (TypeError, ValueError):
            next_start = end
        if next_start > start:
            end = min(end, next_start - _CUE_RENDER_EPSILON)
        else:
            end = min(end, start + _CUE_RENDER_EPSILON)
    if end <= start:
        end = start + _CUE_RENDER_EPSILON
    return round(start, 3), round(end, 3)


def ffmpeg_enable_expression(start: float, end: float) -> str:
    """Build an ffmpeg enable expression with exclusive cue end timing."""
    return f"gte(t,{float(start):.3f})*lt(t,{float(end):.3f})"


def _ass_color_to_rgba(ass_color: str) -> tuple[int, int, int, int]:
    """Convert an &HAABBGGRR ASS colour into a Pillow RGBA tuple."""
    h = ass_color.replace("&H", "").replace("&", "").zfill(8)
    alpha = int(h[0:2], 16)
    blue = int(h[2:4], 16)
    green = int(h[4:6], 16)
    red = int(h[6:8], 16)
    # ASS alpha is inverted relative to Pillow: 0 is fully opaque.
    return (red, green, blue, 255 - alpha)


def _format_display_word(word: str, style: CaptionStyle, language: str) -> str:
    w = strip_emojis(word)
    if style.uppercase and is_latin_language(language):
        return w.upper()
    return w


def build_ass_from_cues(
    cues: list[dict],
    output_path: str | Path,
    *,
    style_id: str | None = None,
    caption_position: int | None = None,
    language: str = "ar",
    video_width: int = 1080,
    video_height: int = 1920,
) -> Path:
    """Write ASS from editable cues. Returns path."""
    style = get_style(style_id or default_style_id())
    pos = int(caption_position if caption_position is not None else default_caption_position())
    pos = max(5, min(85, pos))
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    play_x = int(video_width or 1080)
    play_y = int(video_height or 1920)
    dimension_scale = max(play_y / 1920, 0.35)
    max_chars, font_scale = get_subtitle_layout(language, style.font_size)

    subs = pysubs2.SSAFile()
    subs.info["WrapStyle"] = "0"
    subs.info["ScaledBorderAndShadow"] = "yes"
    subs.info["PlayResX"] = str(play_x)
    subs.info["PlayResY"] = str(play_y)
    subs.info["ScriptType"] = "v4.00+"

    def _parse_ass_color(ass_color: str) -> pysubs2.Color:
        color_hex = ass_color.replace("&H", "").replace("&", "").zfill(8)
        alpha = int(color_hex[0:2], 16)
        blue = int(color_hex[2:4], 16)
        green = int(color_hex[4:6], 16)
        red = int(color_hex[6:8], 16)
        return pysubs2.Color(red, green, blue, alpha)

    st = pysubs2.SSAStyle()
    if is_latin_language(language):
        st.fontname = style.font_name
    else:
        st.fontname = style.font_name_fallback or style.font_name
    # Prefer Arabic rounded when available on mac for Suheil style
    if is_rtl_language(language):
        st.fontname = style.font_name  # SF Arabic Rounded first
    st.fontsize = int(style.font_size * font_scale * dimension_scale)
    st.primarycolor = _parse_ass_color(style.primary_color)
    st.secondarycolor = _parse_ass_color(style.highlight_color)
    st.outlinecolor = _parse_ass_color(style.outline_color)
    st.backcolor = _parse_ass_color(style.shadow_color)
    st.bold = style.bold
    st.italic = style.italic
    st.outline = 0 if style.render_mode == "word_box" else round(style.outline_size * font_scale * dimension_scale, 1)
    st.shadow = round(style.shadow_depth * font_scale * dimension_scale, 1)
    st.alignment = pysubs2.Alignment.BOTTOM_CENTER
    st.marginl = int(48 * dimension_scale)
    st.marginr = int(48 * dimension_scale)
    st.marginv = int(play_y * pos / 100)
    st.borderstyle = 1
    st.encoding = 1
    subs.styles["Default"] = st

    anim = style.animation_type or "none"

    def _cue_position_tag(cue: dict) -> str:
        raw = cue.get("position")
        try:
            cue_pos = int(raw) if raw is not None and str(raw).strip() else pos
        except (TypeError, ValueError):
            cue_pos = pos
        cue_pos = max(5, min(85, cue_pos))
        center_x = int(round(play_x / 2))
        center_y = int(round(play_y * (1.0 - cue_pos / 100.0)))
        # \\an5 makes \\pos anchor the visual center, matching the Pillow
        # overlay fallback and the in-video editor.
        return f"{{\\an5\\pos({center_x},{center_y})}}"

    for cue_index, cue in enumerate(cues):
        text = strip_emojis(str(cue.get("text") or "")).strip()
        if not text:
            continue
        start, end = render_cue_window(cues, cue_index)
        position_tag = _cue_position_tag(cue)

        words = cue.get("words") or []
        if anim in {"highlight", "karaoke", "scale", "bounce"} and len(words) >= 2:
            # word-by-word active highlight within the cue window
            for idx, w in enumerate(words):
                w_start = float(w.get("start", start))
                w_end = float(words[idx + 1]["start"]) if idx < len(words) - 1 else end
                parts: list[str] = []
                line_chars = 0
                for i, ww in enumerate(words):
                    disp = escape_ass_text(_format_display_word(str(ww.get("word", "")), style, language))
                    if not disp:
                        continue
                    if line_chars and line_chars + 1 + len(disp) > max_chars:
                        parts.append("\\N")
                        line_chars = 0
                    elif parts and not parts[-1].endswith("\\N"):
                        parts.append(" ")
                        line_chars += 1
                    if i == idx and anim != "none":
                        hc = style.highlight_color
                        if anim == "scale":
                            parts.append(f"{{\\fscx110\\fscy110\\c{hc}}}{disp}{{\\r}}")
                        else:
                            parts.append(f"{{\\c{hc}}}{disp}{{\\r}}")
                    else:
                        parts.append(disp)
                    line_chars += len(disp)
                event_text = "".join(parts)
                subs.events.append(
                    pysubs2.SSAEvent(
                        start=pysubs2.make_time(s=max(0.0, w_start)),
                        end=pysubs2.make_time(s=max(w_start + 0.05, w_end)),
                        text=position_tag + event_text,
                        style="Default",
                    )
                )
        else:
            # Simple phrase cue (Suheil default): wrap by max_chars
            tokens = text.split()
            lines: list[str] = []
            buf: list[str] = []
            n = 0
            for tok in tokens:
                disp = _format_display_word(tok, style, language)
                add = len(disp) + (1 if buf else 0)
                if buf and n + add > max_chars:
                    lines.append(" ".join(buf))
                    buf = [disp]
                    n = len(disp)
                else:
                    buf.append(disp)
                    n += add
            if buf:
                lines.append(" ".join(buf))
            # max 2 lines
            body = "\\N".join(escape_ass_text(x) for x in lines[:2])
            subs.events.append(
                pysubs2.SSAEvent(
                    start=pysubs2.make_time(s=max(0.0, start)),
                    end=pysubs2.make_time(s=end),
                    text=position_tag + body,
                    style="Default",
                )
            )

    subs.save(str(out))
    return out


def cues_to_vtt(cues: list[dict]) -> str:
    """WebVTT for in-browser preview track."""

    def ts(sec: float) -> str:
        if sec < 0:
            sec = 0
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = sec % 60
        return f"{h:02d}:{m:02d}:{s:06.3f}"

    lines = ["WEBVTT", ""]
    for i, c in enumerate(cues, 1):
        text = strip_emojis(str(c.get("text") or "")).strip()
        if not text:
            continue
        start, end = render_cue_window(cues, i - 1)
        lines.append(str(i))
        lines.append(f"{ts(start)} --> {ts(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def video_encode_args(
    *,
    preset: str,
    crf: int,
    video_bitrate: str | None = None,
    max_video_bitrate: str | None = None,
) -> list[str]:
    """Build one unambiguous x264 quality profile."""
    args = ["-c:v", "libx264", "-preset", preset]
    if not video_bitrate:
        return [*args, "-crf", str(crf)]

    maxrate = max_video_bitrate or video_bitrate
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([kKmM])", video_bitrate.strip())
    if not match:
        raise ValueError(f"Unsupported video bitrate: {video_bitrate}")
    doubled = float(match.group(1)) * 2
    number = str(int(doubled)) if doubled.is_integer() else f"{doubled:g}"
    bufsize = f"{number}{match.group(2)}"
    return [
        *args,
        "-b:v", video_bitrate,
        "-maxrate", maxrate,
        "-bufsize", bufsize,
    ]


def burn_ass(
    video_path: str | Path,
    ass_path: str | Path,
    output_path: str | Path,
    *,
    crf: int = 18,
    preset: str = "veryfast",
    video_bitrate: str | None = None,
    max_video_bitrate: str | None = None,
    cues: list[dict] | None = None,
    language: str = "ar",
    caption_position: int = 34,
    style_id: str | None = None,
) -> Path:
    """Burn captions into video.

    Prefers libass ``subtitles``/``ass`` filters when available.
    Falls back to ffmpeg ``drawtext`` (Arabic-reshaped) — works on Homebrew
    ffmpeg builds without libass.
    """
    video_path = Path(video_path)
    ass_path = Path(ass_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Bundled caption faces must use the same tested Pillow rendering on
    # every host, independent of libass/font discovery. Legacy word boxes also
    # require Pillow. Other styles retain the existing libass-first behavior.
    effective_style_id = style_id or default_style_id()
    effective_style = get_style(effective_style_id)
    if effective_style.render_mode == "word_box" or effective_style.font_name in {"Alexandria Black", "Changa ExtraBold"}:
        if cues is None:
            cues = _cues_from_ass_file(ass_path)
        if cues:
            return _burn_with_drawtext(
                video_path,
                output_path,
                cues=cues,
                language=language,
                caption_position=caption_position,
                style_id=effective_style_id,
                crf=crf,
                preset=preset,
                video_bitrate=video_bitrate,
                max_video_bitrate=max_video_bitrate,
            )

    # Try libass path first. Note that Homebrew's ffmpeg is commonly built
    # WITHOUT libass, in which case every attempt below fails and the Pillow
    # overlay is what actually renders — so caption styling changes must be
    # made in _burn_with_drawtext too, not only in the ASS style.
    ass_raw = str(ass_path.resolve())
    ass_esc = ass_raw.replace("\\", "\\\\").replace(":", "\\:")
    for vf in (f"subtitles={ass_esc}", f"ass={ass_esc}"):
        cmd = [
            _ffmpeg_bin(), "-y", "-i", str(video_path),
            "-vf", vf,
            *video_encode_args(
                preset=preset,
                crf=crf,
                video_bitrate=video_bitrate,
                max_video_bitrate=max_video_bitrate,
            ),
            "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
            str(output_path),
        ]
        try:
            subprocess.run(cmd, capture_output=True, text=True, check=True)
            if output_path.exists() and output_path.stat().st_size > 1000:
                return output_path
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg not found") from exc
        except subprocess.CalledProcessError:
            continue

    log.info(
        "libass unavailable in %s; burning captions via the Pillow overlay path",
        _ffmpeg_bin(),
    )
    # Fallback: drawtext from cues (or parse ASS events lightly via cues arg)
    if cues is None:
        # minimal parse of Dialogue lines from ASS if cues not provided
        cues = _cues_from_ass_file(ass_path)
    if not cues:
        raise RuntimeError("ffmpeg has no libass and no cues available for drawtext burn")

    return _burn_with_drawtext(
        video_path,
        output_path,
        cues=cues,
        language=language,
        caption_position=caption_position,
        style_id=style_id or default_style_id(),
        crf=crf,
        preset=preset,
        video_bitrate=video_bitrate,
        max_video_bitrate=max_video_bitrate,
    )


def _cues_from_ass_file(ass_path: Path) -> list[dict]:
    try:
        subs = pysubs2.load(str(ass_path))
    except Exception:
        return []
    out = []
    for ev in subs.events:
        text = re.sub(r"\{[^}]*\}", "", ev.text or "")
        text = text.replace("\\N", " ").replace("\\n", " ").strip()
        if not text:
            continue
        out.append(
            {
                "start": ev.start / 1000.0,
                "end": ev.end / 1000.0,
                "text": text,
            }
        )
    return out


_ARABIC_OVERLAY_TRANSLATION = str.maketrans(
    "0123456789%",
    "٠١٢٣٤٥٦٧٨٩٪",
)


def _normalize_arabic_caption_text(text: str) -> str:
    """Use glyphs supported by SF Arabic and remove unstable combining marks."""
    normalized = unicodedata.normalize("NFC", text or "").translate(_ARABIC_OVERLAY_TRANSLATION)
    return "".join(ch for ch in normalized if not unicodedata.category(ch).startswith("M"))


def _shape_arabic(text: str) -> str:
    t = _normalize_arabic_caption_text(strip_emojis(text or ""))
    if not t:
        return ""
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display

        return get_display(arabic_reshaper.reshape(t))
    except Exception:
        return t


def _prepare_pillow_caption_text(
    text: str,
    *,
    language: str,
    raqm_available: bool | None = None,
) -> tuple[str, str | None]:
    """Return text and direction for Pillow without double-shaping Arabic.

    Pillow builds with libraqm accept logical-order Arabic and perform their
    own bidi shaping. Older builds need the manual reshaper+bidi fallback.
    """
    raw = strip_emojis(text or "").strip()
    if not is_rtl_language(language):
        return raw, None

    logical = _normalize_arabic_caption_text(raw)
    if raqm_available is None:
        try:
            from PIL import features

            raqm_available = bool(features.check("raqm"))
        except Exception:
            raqm_available = False
    if raqm_available:
        return logical, "rtl"
    return _shape_arabic(logical), None


def _escape_drawtext(text: str) -> str:
    # ffmpeg drawtext specials
    t = text.replace("\\", "\\\\")
    t = t.replace(":", r"\:")
    t = t.replace("'", r"\'")
    t = t.replace("%", r"\%")
    return t


def _pick_arabic_font() -> str:
    candidates = [
        "/System/Library/Fonts/SFArabicRounded.ttf",
        "/System/Library/Fonts/SFArabic.ttf",
        "/System/Library/Fonts/GeezaPro.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for p in candidates:
        if Path(p).exists():
            return p
    return candidates[0]


def _pick_latin_coverage_font() -> str:
    """Fonts that can render Western A–Z without tofu bars."""
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for p in candidates:
        if Path(p).exists():
            return p
    return _pick_arabic_font()


def _caption_needs_latin_coverage(text: str) -> bool:
    """True when the cue contains Western letters SF Arabic cannot draw."""
    return any(("A" <= ch <= "Z") or ("a" <= ch <= "z") for ch in (text or ""))


def _pick_overlay_font(
    text: str, *, language: str | None = None, style: CaptionStyle | None = None,
) -> str:
    """Pick a Pillow font path for one cue.

    The selected Suheil style uses its bundled static face. Legacy styles
    keep SF Arabic Rounded, and mixed Latin cues keep the existing coverage font.
    """
    if is_rtl_language(language or "ar") and _caption_needs_latin_coverage(text):
        return _pick_latin_coverage_font()
    if is_rtl_language(language or "ar"):
        if style is not None and style.font_name == "Changa ExtraBold":
            return str(Path(__file__).parent / "fonts" / "Changa-ExtraBold.ttf")
        if style is not None and style.font_name == "Alexandria Black":
            return str(Path(__file__).parent / "fonts" / "Alexandria-Black.ttf")
        return _pick_arabic_font()
    # Latin tracks prefer a Latin-capable face when available.
    return _pick_latin_coverage_font()


def _burn_with_drawtext(
    video_path: Path,
    output_path: Path,
    *,
    cues: list[dict],
    language: str,
    caption_position: int,
    style_id: str,
    crf: int,
    preset: str,
    video_bitrate: str | None = None,
    max_video_bitrate: str | None = None,
) -> Path:
    """Burn via Pillow PNG overlays + ffmpeg overlay (no libass/drawtext needed)."""
    from PIL import Image, ImageDraw, ImageFont

    style = get_style(style_id)
    _ = max(5, min(85, int(caption_position)))  # default floor validated in loop

    # Probe size
    probe = subprocess.run(
        [
            _ffprobe_bin(), "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0:s=x",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    wh = (probe.stdout or "1080x1920").strip().split("x")
    width = int(wh[0]) if len(wh) == 2 else 1080
    height = int(wh[1]) if len(wh) == 2 else 1920

    # Always work at max 1080x1920 for burn speed on phone 4K uploads
    target_w, target_h = width, height
    scale_filter = None
    if height >= width:
        if width > 1080 or height > 1920:
            target_w, target_h = 1080, 1920
            scale_filter = f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2"
    else:
        if max(width, height) > 1920:
            target_w, target_h = 1920, 1080
            scale_filter = f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2"

    fontsize = max(52, int(style.font_size * (target_h / 1920.0) * 0.95))
    font_cache: dict[str, ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}

    def font_for(text: str) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        path = _pick_overlay_font(text, language=language, style=style)
        cached = font_cache.get(path)
        if cached is not None:
            return cached
        try:
            loaded: ImageFont.FreeTypeFont | ImageFont.ImageFont = ImageFont.truetype(path, fontsize)
        except Exception:
            loaded = ImageFont.load_default()
        font_cache[path] = loaded
        return loaded

    # word_box draws its own frame, so the glyph stroke only applies elsewhere.
    if style.render_mode == "word_box":
        stroke_width = 0
    else:
        stroke_width = max(0, int(round(style.outline_size * (target_h / 1920.0) * 0.95)))
    stroke_fill = _ass_color_to_rgba(style.outline_color) if stroke_width else None

    tmp_dir = output_path.parent / f".burn_overlays_{output_path.stem}"
    if tmp_dir.exists():
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    default_pos = max(5, min(85, int(caption_position)))
    # overlay_specs: png, start, end, y_frac
    overlay_specs: list[tuple[Path, float, float, float]] = []
    for i, c in enumerate(cues):
        raw = strip_emojis(str(c.get("text") or "")).strip()
        if not raw:
            continue
        shaped, text_direction = _prepare_pillow_caption_text(raw, language=language)
        if style.uppercase and is_latin_language(language):
            shaped = shaped.upper()
        start, end = render_cue_window(cues, i)
        cue_pos = c.get("position")
        try:
            cue_pos = int(cue_pos) if cue_pos is not None and str(cue_pos).strip() != "" else default_pos
        except Exception:
            cue_pos = default_pos
        cue_pos = max(5, min(85, cue_pos))
        y_frac = 1.0 - (cue_pos / 100.0)
        font = font_for(raw)

        dummy = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
        dr = ImageDraw.Draw(dummy)
        bbox = dr.multiline_textbbox(
            (0, 0),
            shaped,
            font=font,
            align="center",
            spacing=8,
            stroke_width=stroke_width,
            direction=text_direction,
        )
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        if style.render_mode == "word_box":
            pad_x = max(8, int(style.box_padding_x * (target_h / 1920.0)))
            pad_y = max(6, int(style.box_padding_y * (target_h / 1920.0)))
        else:
            # Keep the glyph stroke from being clipped by the overlay edge.
            pad_x = stroke_width
            pad_y = stroke_width
        card_w = min(target_w - 40, tw + pad_x * 2)
        card_h = th + pad_y * 2
        img = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        cx = (card_w - tw) / 2 - bbox[0]
        cy = (card_h - th) / 2 - bbox[1]
        if style.render_mode == "word_box":
            border_width = max(1, int(round(style.box_border_size * (target_h / 1920.0))))
            radius = max(border_width + 1, int(round(style.box_radius * (target_h / 1920.0))))
            draw.rounded_rectangle(
                (border_width / 2, border_width / 2, card_w - 1 - border_width / 2, card_h - 1 - border_width / 2),
                radius=radius,
                outline=(0, 0, 0, 255),
                width=border_width,
            )
        # Pillow paints the stroke behind the fill, so adjacent glyphs merge into
        # one continuous outline around the text rather than a ring per letter.
        draw.multiline_text(
            (cx, cy),
            shaped,
            font=font,
            fill=(255, 255, 255, 255),
            align="center",
            spacing=8,
            stroke_width=stroke_width,
            stroke_fill=stroke_fill,
            direction=text_direction,
        )
        png = tmp_dir / f"cue_{i:04d}.png"
        img.save(png)
        overlay_specs.append((png, start, end, y_frac))

    if not overlay_specs:
        raise RuntimeError("No drawable cues for burn")

    cmd = [_ffmpeg_bin(), "-y", "-i", str(video_path)]
    for png, _, _, _ in overlay_specs:
        cmd += ["-i", str(png)]

    parts = []
    if scale_filter:
        parts.append(f"[0:v]{scale_filter}[base]")
        cur = "base"
    else:
        cur = "0:v"
    for i, (_, start, end, y_frac) in enumerate(overlay_specs):
        inp = i + 1
        out = f"v{i}"
        parts.append(
            f"[{cur}][{inp}:v]overlay="
            f"(main_w-overlay_w)/2:"
            f"main_h*{y_frac:.4f}-overlay_h/2:"
            f"enable='{ffmpeg_enable_expression(start, end)}'"
            f"[{out}]"
        )
        cur = out
    fc = ";".join(parts)
    cmd += [
        "-filter_complex", fc,
        "-map", f"[{cur}]",
        "-map", "0:a?",
        *video_encode_args(
            preset=preset,
            crf=crf,
            video_bitrate=video_bitrate,
            max_video_bitrate=max_video_bitrate,
        ),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        str(output_path),
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffmpeg overlay burn failed: {(exc.stderr or '')[-1000:]}") from exc
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
    if not output_path.exists() or output_path.stat().st_size < 1000:
        raise RuntimeError("Burn produced empty output")
    return output_path


def plain_transcript_text(transcript: dict) -> str:
    parts = []
    for seg in transcript.get("segments") or []:
        t = strip_emojis(str(seg.get("text") or "")).strip()
        if t:
            parts.append(t)
    return " ".join(parts)
