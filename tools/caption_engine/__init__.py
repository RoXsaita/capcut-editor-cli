"""On-screen caption engine for Suheil AI dashboard.

Adapted from ai-video-captions (MIT). See NOTICE.md.
"""

from .pipeline import (
    burn_ass,
    build_ass_from_cues,
    cues_to_vtt,
    default_style_id,
    generate_cues_from_transcript,
    list_styles,
    transcribe_word_level,
)
from .align import align_transcript_bundle

__all__ = [
    "align_transcript_bundle",
    "burn_ass",
    "build_ass_from_cues",
    "cues_to_vtt",
    "default_style_id",
    "generate_cues_from_transcript",
    "list_styles",
    "transcribe_word_level",
]
