"""Script-aware caption correction.

Whisper timestamps are the backbone. Script is a vocabulary/meaning prior.
Weight Whisper higher when the speaker ad-libs; use script to fix names/tools/numbers.
"""

from __future__ import annotations

import json
import logging
import re
from difflib import SequenceMatcher
from typing import Callable

log = logging.getLogger("dashboard.caption_align")

_AR_DIAC = re.compile(r"[\u064B-\u065F\u0670]")
_NON_WORD = re.compile(r"[^\w\u0600-\u06FF%]+", re.UNICODE)


def _norm(s: str) -> str:
    s = (s or "").strip().lower()
    s = _AR_DIAC.sub("", s)
    s = s.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ة", "ه").replace("ى", "ي")
    s = _NON_WORD.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def _tokens(s: str) -> list[str]:
    return [t for t in _norm(s).split(" ") if t]


def script_to_windows(script_text: str, window: int = 12) -> list[list[str]]:
    toks = _tokens(script_text)
    if not toks:
        return []
    wins = []
    for i in range(0, len(toks)):
        wins.append(toks[i : i + window])
    return wins


def align_cues_with_script(
    cues: list[dict],
    script_text: str,
    *,
    whisper_weight: float = 0.65,
) -> list[dict]:
    """Align in spoken order; never print lossy matching keys as Arabic text."""
    out = [dict(c) for c in cues]
    spoken = [token for c in cues for token in str(c.get("text") or "").split()]
    prior = str(script_text or "").split()
    if not spoken or not prior:
        return out
    corrected = list(spoken)
    matcher = SequenceMatcher(None, [_norm(t) for t in spoken], [_norm(t) for t in prior], autojunk=False)
    for tag, i, j, x, y in matcher.get_opcodes():
        # Equal blocks need no rewrite. Insert/delete blocks are script ad-libs,
        # not permission to add/remove/reallocate words at locked timestamps.
        if tag != "replace" or j - i != y - x or i == 0 or j == len(spoken):
            continue
        for k, candidate in zip(range(i, j), prior[x:y]):
            if SequenceMatcher(None, _norm(spoken[k]), _norm(candidate)).ratio() >= max(0.8, whisper_weight):
                corrected[k] = candidate
    offset = 0
    for cue in out:
        count = len(str(cue.get("text") or "").split())
        text = " ".join(corrected[offset:offset + count])
        cue["align_source"] = "script+whisper" if text != cue.get("text") else "whisper"
        cue["text"] = text
        offset += count
    return out


# Narrow, unambiguous tech spelling variants only. Do not globally collapse
# repeated Arabic letters: prefixes such as ببرومبت are legitimate speech.
_PROMPT_TYPO = re.compile(r"(?<![\w])((?:و)?(?:ب|ل)?(?:ال)?)(?:برومت|بررومبت|برومببت)(?![\w])")


def normalize_caption_terms(text: str) -> str:
    return _PROMPT_TYPO.sub(lambda match: match.group(1) + "برومبت", text)


def llm_polish_cues(
    cues: list[dict],
    script_text: str,
    *,
    run_text: Callable[[str], tuple[str, str]] | None,
    report: dict | None = None,
) -> list[dict]:
    """Bounded sparse corrections, with observable failure and locked timing."""
    meta = report if report is not None else {}
    fallback = [dict(c, text=normalize_caption_terms(str(c.get("text") or ""))) for c in cues]
    meta.update(status="skipped", changed=0)
    if not run_text or not cues:
        return fallback
    payload = [{"id": c.get("id"), "text": c.get("text")} for c in cues]
    prompt = f"""Proofread spoken Jordanian Arabic on-screen captions, not social post copy.
Read ALL neighboring cues as one spoken utterance before correcting a word.
ASR WORD SEQUENCE is the spoken evidence. CONTEXT is only a potentially stale spelling prior.
Do not import facts, phrases, names or numbers from an unrelated/stale script.
Preserve dialect, meaning, repetitions, fillers, prefixes and English tool identifiers.
Fix clear ASR mistakes, missing/doubled letters, hamza and taa marbuta, not style.
Tech spelling: prompt = برومبت (not برومت or بررومبت), Claude = كلود,
Codex = كودكس, terminal = ترمينال. Keep inflected prefixes, e.g. والبرومبت / ببرومبت.
Never invent words, expand one word into two, move words between cue IDs, or translate speech.
Keep each cue's token count, maximum 2. No timestamps or positions in output.
Return ONLY {{"fixes":[{{"id":1,"before":"exact input text","text":"corrected text"}}]}}.
Include ONLY changed cues. No changes: {{"fixes":[]}}. No explanation.

CONTEXT (may be stale):
{(script_text or '')[:5000]}

ASR WORD SEQUENCE / CUES_JSON:
{json.dumps(payload, ensure_ascii=False)}
"""
    try:
        raw, backend = run_text(prompt)
        meta["backend"] = backend
        from .layout import parse_layout_agent_output
        data = parse_layout_agent_output(raw)
        sparse = isinstance(data, dict)
        if sparse:
            fixes = data.get("fixes")
            if not isinstance(fixes, list):
                raise ValueError("missing fixes array")
            by_id = {str(c.get("id")): c for c in cues}
            seen = set()
            for fixed in fixes:
                if not isinstance(fixed, dict):
                    raise ValueError("invalid correction")
                key = str(fixed.get("id"))
                if key not in by_id or key in seen:
                    raise ValueError("unknown/duplicate correction id")
                if fixed.get("before") != by_id[key].get("text"):
                    raise ValueError("stale correction text")
                seen.add(key)
            replacements = {str(f["id"]): f for f in fixes}
        else:
            # Accept the old full-array contract for existing callers/tests,
            # but never use a greedy regex that mistakes an inner fixes array.
            if not isinstance(data, list) or len(data) != len(cues) or any(
                not isinstance(f, dict) or str(f.get("id")) != str(c.get("id"))
                for c, f in zip(cues, data)
            ):
                raise ValueError("cue identity/order/count mismatch")
            replacements = {str(f["id"]): f for f in data}
        out = []
        for src in cues:
            fixed = replacements.get(str(src.get("id")))
            nc = dict(src)
            if fixed:
                text = fixed.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > 60:
                    raise ValueError("invalid caption text")
                if len(text.split()) > min(2, len(str(src.get("text") or "").split())):
                    raise ValueError("correction adds words")
                nc["text"] = text.strip()
            nc["text"] = normalize_caption_terms(str(nc.get("text") or ""))
            nc["align_source"] = (nc.get("align_source") or "whisper") + "+llm"
            out.append(nc)
        meta.update(status="completed", changed=sum(a["text"] != b["text"] for a, b in zip(cues, out)))
        return out
    except Exception as exc:
        log.warning("llm polish failed: %s", exc)
        meta.update(status="failed", error=str(exc)[:400])
        return fallback


def align_transcript_bundle(
    cues: list[dict],
    script_text: str,
    *,
    run_text: Callable[[str], tuple[str, str]] | None = None,
    use_llm: bool = True,
    report: dict | None = None,
) -> list[dict]:
    aligned = align_cues_with_script(cues, script_text, whisper_weight=0.65)
    aligned = llm_polish_cues(aligned, script_text, run_text=run_text if use_llm else None, report=report)
    return aligned
