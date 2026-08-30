#!/usr/bin/env python3
"""
aroll — deterministic A-roll (talking head) cleanup.

One command, run twice. Code does the mechanical work; the agent only makes judgement calls.

    capcutctl cut VIDEO.mp4 [--lang ar]
        Transcribe with word timestamps, build the acoustic energy index, snap every
        boundary acoustically, delete dead air, detect takes and repeated beats, and
        write a handout for the agent to read.

    capcutctl cut VIDEO.mp4 --keep 0,2-9 --project NAME
        Apply the agent's selection, lint every seam, pack the timeline with no gaps,
        and build the CapCut project.

The division of labour that matters:
    Whisper decides WHICH WORDS.  The energy index decides EXACTLY WHERE.
Whisper's word starts are contiguous-filled and lie by up to ~0.7s. Every seam defect in
this project's history came from trusting them. Boundaries here come from onset_after() and
trough(), except that a separately trusted first-word start may protect an IN from eating
an unvoiced consonant.
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from difflib import SequenceMatcher
from itertools import pairwise
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audio_index import SIL, SOFT, AudioIndex, lint, loud_out_finding, source_token

FPS = 30.0
FRAME = 1.0 / FPS
AROLL_INDEX_VERSION = 3
LEAD_FRAMES = 2          # start this many frames before the onset, so the attack survives
AUDIO_RAMP_FRAMES = 2     # native audio fade on both sides of every generated splice
HESITATION = 0.60        # silence longer than this inside a beat is dead air
HESITATION_KEEP = 0.25   # ...trimmed back to this
MIN_BEAT = 0.25          # anything shorter is a fragment, not a beat
DUPE_RATIO = 0.82        # normalised-text similarity that counts as the same line
DUPLICATE_GAP = 2.5      # a source-time gap consistent with a separately recorded retry
WORD_START_MAX_LEAD = 0.35
WORD_START_HARD_SILENCE = 0.30
WORD_START_LOOKBACK = 0.80
WORD_START_MIN_CONFIDENCE = 0.50
FIRST_WORD_CLIP_TOLERANCE = 0.5 * FRAME


# ---------------------------------------------------------------- helpers
def norm(text):
    """Arabic-friendly normalisation for duplicate detection."""
    text = text or ""
    t = unicodedata.normalize("NFKD", text)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[ـً-ٟ]", "", t)          # tatweel + diacritics
    t = t.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي").replace("ة", "ه")
    t = re.sub(r"[^\w\s]", " ", t)
    return re.sub(r"\s+", " ", t).strip().lower()


def quantise(t, fps=FPS):
    """Whole frames at the authoritative project rate, so CapCut never gets a half-frame seam."""
    fps = _number(fps)
    value = _number(t)
    if fps is None or fps <= 0:
        raise ValueError("fps must be finite and positive")
    if value is None:
        raise ValueError("time must be finite")
    return round(value * fps) / fps


DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


CREDIT = re.compile(r"ترجمة|نانسي")


def media_token(media):
    """Public A-roll alias for the shared robust source identity."""
    return source_token(media)


def index_is_current(path, media=None):
    """Only reuse an A-roll index with the current schema and exact source identity."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        source = os.path.abspath(media or data.get("media"))
        if not source or not os.path.isfile(source):
            return False
        token = data.get("source_token", data.get("media_token", data.get("token")))
        return data.get("version", 1) >= AROLL_INDEX_VERSION and token == media_token(source)
    except (OSError, json.JSONDecodeError, AttributeError, TypeError, ValueError):
        return False


def _number(value):
    """Return a finite float, or None for missing/malformed transcript metadata."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def authoritative_fps(data=None, override=None):
    """Resolve the single frame rate used by indexing, repair, and the handoff plan."""
    value = override if override is not None else ((data or {}).get("fps", FPS))
    value = _number(value)
    if value is None or value <= 0:
        raise ValueError("fps must be finite and positive")
    return value


def transcribe(media, lang, model, cache_dir, force=False):
    """
    mlx_whisper on Apple silicon, running large-v3-turbo by default — accuracy matters
    most here because Whisper's Arabic is what duplicate detection reads. Falls back to
    the openai-whisper package if a plain model name is given or mlx is unavailable.
    """
    slug = re.sub(r"[^a-zA-Z0-9._-]", "-", model)
    cache = os.path.join(cache_dir, os.path.basename(media).rsplit(".", 1)[0] + f".whisper-{slug}.json")
    token = media_token(media)
    if not force and os.path.exists(cache):
        try:
            d = json.loads(Path(cache).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            d = None
        if isinstance(d, dict) and d.get("_token") == token:
            print(f"  transcript: cached ({model})", file=sys.stderr)
            return d

    mlx = shutil.which("mlx_whisper")
    if mlx and "/" in model:
        print(f"  transcribing with mlx_whisper {model} (lang={lang or 'auto'}) …", file=sys.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            cmd = [mlx, media, "--model", model, "--word-timestamps", "True",
                   "--output-format", "json", "--output-dir", tmp, "--output-name", "out"]
            if lang:
                cmd += ["--language", lang]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            out = os.path.join(tmp, "out.json")
            if proc.returncode != 0 or not os.path.exists(out):
                raise SystemExit(f"mlx_whisper failed:\n{proc.stderr[-2000:]}")
            result = json.loads(Path(out).read_text())
    else:
        import whisper
        print(f"  transcribing with openai-whisper:{model} (lang={lang or 'auto'}) …", file=sys.stderr)
        result = whisper.load_model(model).transcribe(
            media, language=lang, word_timestamps=True, verbose=False,
            condition_on_previous_text=False,      # stops one hallucination poisoning the rest
        )
    result["_token"] = token
    Path(cache).write_text(json.dumps(result, ensure_ascii=False))
    return result


# ---------------------------------------------------------------- indexing
def split_on_dead_air(idx, start, end):
    """Break a beat wherever it goes quiet for longer than a hesitation.

    Leading silence is dropped, not kept as a 0.25s 'beat' that then snaps
    onto the first syllable (Whisper starts can sit 0.7s early; HESITATION is 0.60).
    """
    on = idx.onset_after(start)
    if on is None or on >= end:
        return []
    start = max(start, on)
    spans, run_start, silence_from = [], start, None
    t = start
    while t < end:
        quiet = idx.at(t) < SOFT
        if quiet and silence_from is None:
            silence_from = t
        elif not quiet and silence_from is not None:
            if t - silence_from > HESITATION:
                spans.append((run_start, silence_from + HESITATION_KEEP))
                run_start = t
            silence_from = None
        t += idx.bin
    spans.append((run_start, end))
    out = []
    for a, b in spans:
        if b - a < MIN_BEAT:
            continue
        u = a
        spoke = False
        while u < b:
            if idx.at(u) >= SOFT:
                spoke = True
                break
            u += idx.bin
        if spoke:
            out.append((a, b))
    return out


def _word_start(word):
    """Whisper/MLX word start, accepting the small schema variants seen in caches."""
    return _number(word.get("start", word.get("start_time")))


def _word_end(word):
    return _number(word.get("end", word.get("end_time")))


def first_word_in(seg, a, b):
    """Return the first word overlapping a beat, including a start just before its IN.

    `split_on_dead_air` deliberately moves a segment start to an acoustic onset. That is
    normally right, but it can land after an unvoiced first consonant. Looking for overlap
    using the word END keeps that word available for the safety check instead of losing it
    merely because its Whisper start is a little before the acoustic onset.
    """
    candidates = []
    for order, word in enumerate(seg.get("words") or []):
        start = _word_start(word)
        if start is None or start >= b:
            continue
        end = _word_end(word)
        if end is not None:
            if end <= a:
                continue
        elif start < a - WORD_START_LOOKBACK:
            continue
        candidates.append((start, order, word))
    if not candidates:
        return None
    start, _, word = min(candidates, key=lambda item: (item[0], item[1]))
    result = {
        "text": (word.get("word") or word.get("text") or "").strip(),
        "start": start,
        "end": _word_end(word),
        "confidence": _number(word.get("probability", word.get("confidence"))),
    }
    # Preserve explicit producer/transcriber trust. Dropping this field here makes a
    # deliberately trusted low-confidence Arabic start look like an ordinary Whisper
    # timestamp and lets the acoustic fallback clip its unvoiced consonant.
    for key in ("trustworthy", "word_start_trustworthy"):
        if key in word:
            result[key] = word[key]
    return result


def words_in(seg, a, b):
    """Text whose word timestamps overlap [a, b), not the parent Whisper segment."""
    picked = []
    for word in seg.get("words") or []:
        start = _word_start(word)
        if start is None or start >= b:
            continue
        end = _word_end(word)
        overlaps = end > a if end is not None else start >= a - WORD_START_LOOKBACK
        if overlaps:
            picked.append((word.get("word") or word.get("text") or "").strip())
    text = " ".join(p for p in picked if p).strip()
    if text:
        return text
    parent = (seg.get("text") or "").strip()
    start, end = _number(seg.get("start")), _number(seg.get("end"))
    dur = max(1e-6, (end if end is not None else b) - (start if start is not None else a))
    return parent if (b - a) >= 0.8 * dur else ""


def trustworthy_word_start(idx, word, acoustic_onset=None, floor=0.0, fps=FPS):
    """Whether an earlier Whisper start is safe enough to protect from acoustic snapping.

    Whisper starts are usually contiguous-filled and can be hundreds of milliseconds early.
    A caller may provide an explicit `trustworthy` flag when a re-transcription or manual
    inspection has established the boundary. Otherwise we only trust a start that is close
    to a real onset and is not preceded by a long *hard* silence. The hard-silence threshold
    is lower than SOFT so a quiet/unvoiced consonant can still protect the word.
    """
    if not word:
        return False
    explicit = word.get("trustworthy")
    if explicit is None:
        explicit = word.get("word_start_trustworthy")
    if explicit is not None:
        return bool(explicit)
    confidence = _number(word.get("confidence"))
    if confidence is not None and confidence < WORD_START_MIN_CONFIDENCE:
        return False
    start = _number(word.get("start"))
    tolerance = 0.5 / float(fps)
    if start is None or start < floor - tolerance:
        return False
    if acoustic_onset is None:
        return False
    lead = acoustic_onset - start
    if lead < -tolerance or lead > WORD_START_MAX_LEAD:
        return False
    try:
        hard_silence = idx.head_silence(start, thresh=SIL, cap=WORD_START_HARD_SILENCE)
    except (AttributeError, TypeError):
        hard_silence = 0.0
    return hard_silence < WORD_START_HARD_SILENCE


def protected_word_in(word_start, floor=0.0, fps=FPS):
    """The frame-safe IN that still includes a trusted word's unvoiced lead-in."""
    start = _number(word_start)
    if start is None:
        return None
    return quantise(max(floor, start - LEAD_FRAMES / float(fps)), fps=fps)


def snap(idx, a, b, floor=0.0, word_start=None, word_start_trustworthy=False, fps=FPS):
    """
    IN on the next real onset (minus a lead). OUT by walking back from the
    next onset (or `b`) to a trough — not a ±0.20s window around Whisper's end.

    A trusted earlier first-word start is the one deliberate exception to the acoustic IN:
    energy thresholds cannot see every unvoiced consonant. Untrusted Whisper timing never
    moves the IN; it remains governed by the acoustic onset.
    """
    on = idx.onset_after(max(floor, a - 0.30))
    if on is None:
        return None
    src_in = max(floor, 0.0, on - LEAD_FRAMES / float(fps))
    if word_start_trustworthy:
        protected = protected_word_in(word_start, floor=floor, fps=fps)
        if protected is not None and protected < src_in:
            src_in = protected
    nxt = idx.onset_after(b)
    anchor = (nxt - 0.04) if nxt is not None and nxt > src_in + MIN_BEAT else b
    src_out = idx.trough(anchor, win=0.45)
    if src_out <= src_in:
        src_out = max(b, src_in + MIN_BEAT)
    return quantise(src_in, fps=fps), quantise(src_out, fps=fps)


def detect_takes(beats, gap=2.5):
    """A long silence, or the opening line coming round again, starts a new take."""
    if not beats:
        return []
    opener = norm(beats[0]["text"])[:40]
    takes, current = [], 0
    for i, beat in enumerate(beats):
        if i:
            silence = beat["src_in"] - beats[i - 1]["src_out"]
            restart = opener and SequenceMatcher(None, opener, norm(beat["text"])[:40]).ratio() > 0.75
            if silence > gap or (restart and i > 2):
                current += 1
        beat["take"] = current
        takes.append(current)
    return takes


def _tokens(text):
    return norm(text).split()


def _text_relation(a, b):
    """Classify textual similarity without deciding whether two beats may be collapsed."""
    left, right = _tokens(a.get("text")), _tokens(b.get("text"))
    if not left or not right:
        return None
    if left == right:
        return "exact"
    text_ratio = SequenceMatcher(None, " ".join(left), " ".join(right)).ratio()
    token_ratio = SequenceMatcher(None, left, right).ratio()
    if max(text_ratio, token_ratio) >= DUPE_RATIO:
        return "similar"
    short, long = (left, right) if len(left) <= len(right) else (right, left)
    if len(short) >= 2 and short == long[:len(short)]:
        return "prefix"
    return None


def _same_scene(a, b):
    """Whether the transcript text is similar; evidence is checked separately."""
    return _text_relation(a, b) is not None


def _retry_marker(beat):
    """Read explicit retry annotations without treating ordinary words as evidence."""
    for key in ("retry", "redo", "retake", "is_retry", "is_redo", "is_retake", "duplicate"):
        if key not in beat:
            continue
        value = beat[key]
        if isinstance(value, str) and value.strip().lower() in {"", "0", "false", "no", "none"}:
            continue
        if value:
            return True
    annotations = " ".join(str(beat.get(key, "")) for key in ("note", "notes", "reason"))
    return bool(re.search(r"\b(?:retry|redo|retake|re-?record)\b", annotations, re.I))


def _take_diff(a, b):
    left, right = a.get("take"), b.get("take")
    return left is not None and right is not None and left != right


def _source_gap(a, b):
    left_start, left_end = _number(a.get("src_in")), _number(a.get("src_out"))
    right_start, right_end = _number(b.get("src_in")), _number(b.get("src_out"))
    if None in (left_start, left_end, right_start, right_end):
        return None
    if left_end <= right_start:
        return right_start - left_end
    if right_end <= left_start:
        return left_start - right_end
    return 0.0


def _prefix_short_attempt(a, b):
    left, right = _tokens(a.get("text")), _tokens(b.get("text"))
    if len(left) == len(right):
        return False
    shorter, longer = (a, b) if len(left) < len(right) else (b, a)
    short_dur, long_dur = _number(shorter.get("dur")), _number(longer.get("dur"))
    if short_dur is not None and long_dur is not None and long_dur > 0:
        return short_dur / long_dur <= 0.65
    return len(min((left, right), key=len)) <= 2


def _strong_duplicate_evidence(a, b, relation):
    """Require retry/take/time evidence before allowing a default keep-list deletion."""
    if relation is None:
        return False
    if _retry_marker(a) or _retry_marker(b):
        return True
    gap = _source_gap(a, b)
    takes_differ = _take_diff(a, b)
    if relation == "prefix":
        # Prefixes are the dangerous case: sequential instructions naturally form a
        # transitive chain. A take change plus a real pause and a clearly short attempt is
        # the minimum evidence for calling one a truncated retry.
        return takes_differ and gap is not None and gap >= DUPLICATE_GAP and _prefix_short_attempt(a, b)
    # Exact text across takes is the strong, common retry signal. A large source gap can
    # also establish a repeated attempt when older caches lack take labels. Similar but
    # non-identical text needs one of those same independent signals.
    return takes_differ or (gap is not None and gap >= DUPLICATE_GAP)


def _explicit_complete(beat):
    """Read optional producer/reviewer completeness annotations without guessing."""
    for key in ("complete", "is_complete", "complete_version"):
        if key in beat:
            value = beat[key]
            if isinstance(value, str):
                return value.strip().lower() not in {"", "0", "false", "no", "incomplete", "truncated"}
            return bool(value)
    if beat.get("truncated") is True or beat.get("incomplete") is True:
        return False
    defects = " ".join(str(d).lower() for d in beat.get("defects") or [])
    if any(marker in defects for marker in ("truncated", "incomplete", "very short")):
        return False
    if norm(beat.get("text")) in {"...", "…"}:
        return False
    return None


def _complete_member(beat, members):
    """Infer incompleteness only when the transcript gives a concrete signal."""
    explicit = _explicit_complete(beat)
    if explicit is False:
        return False
    if explicit is True:
        return True
    words = _tokens(beat.get("text"))
    # If this attempt is a strict prefix of another attempt in the same component, it is
    # the classic short redo. Do not let it replace the later complete sentence.
    if words:
        for other in members:
            if other is beat:
                continue
            other_words = _tokens(other.get("text"))
            if len(other_words) > len(words) and words == other_words[:len(words)]:
                return False
    return True


def _set_group_winners(beats, groups):
    by_id = {beat["id"]: beat for beat in beats}
    for group in groups:
        members = [by_id[bid] for bid in group["members"] if bid in by_id]
        if group.get("status") == "review":
            group["complete_members"] = []
            group["selected"] = None
            for beat in members:
                beat["duplicate_review"] = True
                beat["dupe_group"] = group["id"]
                beat["is_last_of_group"] = False
                beat["is_last_complete_of_group"] = False
            continue
        complete = [beat for beat in members if _complete_member(beat, members)]
        # A group with no inferably complete attempt still needs a reviewable suggestion;
        # use the last source occurrence rather than silently deleting the scene.
        winner = (complete or members)[-1] if members else None
        group["complete_members"] = [beat["id"] for beat in complete]
        group["selected"] = winner["id"] if winner else None
        for beat in members:
            beat["dupe_group"] = group["id"] if len(members) > 1 else None
            # Keep the old field for downstream handouts, but make it mean the selected
            # last COMPLETE attempt rather than blindly the last transcript occurrence.
            beat["is_last_of_group"] = bool(winner and beat["id"] == winner["id"])
            beat["is_last_complete_of_group"] = beat["is_last_of_group"]


def group_duplicates(beats):
    """Group only evidence-backed retries; keep ambiguous similarity explicitly reviewable.

    This deliberately avoids union-find. A pairwise prefix match is not allowed to bridge
    three sequential instructions into one deletion group, and every member of a safe group
    must have strong retry/take/time evidence with every other member.
    """
    if not beats:
        return []
    for beat in beats:
        beat["dupe_group"] = None
        beat["is_last_of_group"] = True
        beat["is_last_complete_of_group"] = True
        beat["duplicate_review"] = False
    ordered = [beat for beat in beats if _tokens(beat.get("text"))]
    by_id = {beat["id"]: beat for beat in ordered}
    groups = []
    assigned = set()
    # Build disjoint cliques in source order. A beat joins a group only when it has strong
    # evidence with every member; there is no transitive union step.
    for beat in ordered:
        if beat["id"] in assigned:
            continue
        group = {"id": len(groups), "key": norm(beat.get("text")),
                 "members": [beat["id"]], "status": "safe"}
        assigned.add(beat["id"])
        for candidate in ordered:
            if candidate["id"] in assigned:
                continue
            if all((relation := _text_relation(by_id[member_id], candidate)) is not None
                   and _strong_duplicate_evidence(by_id[member_id], candidate, relation)
                   for member_id in group["members"]):
                group["members"].append(candidate["id"])
                assigned.add(candidate["id"])
                group["key"] = norm(max(
                    (by_id[member_id] for member_id in group["members"]),
                    key=lambda item: len(_tokens(item.get("text"))))["text"])
        groups.append(group)

    # Any similar pair that did not meet the evidence bar is surfaced as review-only. It
    # remains in the suggested keep list, including when it touches a safe group.
    review_pairs = []
    seen_pairs = set()
    for i, left in enumerate(ordered):
        for right in ordered[i + 1:]:
            relation = _text_relation(left, right)
            if relation is None or _strong_duplicate_evidence(left, right, relation):
                continue
            pair = (left["id"], right["id"])
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            review_pairs.append({
                "id": len(groups), "key": norm(left.get("text")),
                "members": list(pair), "status": "review",
                "reason": "similar text without strong retry/take/time evidence",
            })
            groups.append(review_pairs[-1])

    # Beats with no usable transcript are intentionally ungrouped and retained by the
    # suggestion function; they should never collapse into one empty duplicate group.
    _set_group_winners(beats, groups)
    return groups


def suggested_keep(beats, groups=None):
    """Return every unique beat plus the last complete attempt of every duplicate group.

    This is intentionally not take-based. A long tutorial can be unique in take 1 while a
    short CTA is re-recorded in take 2; both belong in the suggestion. The agent can still
    edit the printed keep list, but the default must not erase useful ungrouped material.
    """
    if groups is None:
        groups = group_duplicates(beats)
    _set_group_winners(beats, groups)
    winners = {group["selected"] for group in groups
               if group.get("status") != "review" and group.get("selected") is not None}
    grouped = {bid for group in groups for bid in group["members"]}
    retained = {bid for group in groups if group.get("status") == "review" for bid in group["members"]}
    # If an ambiguous pair touches an otherwise safe group, retain the whole group so a
    # reviewer never loses the line that made the relationship ambiguous.
    for group in groups:
        if group.get("status") != "review" and retained.intersection(group["members"]):
            retained.update(group["members"])
    return [beat["id"] for beat in beats
            if beat["id"] not in grouped or beat["id"] in winners or beat["id"] in retained]


def first_word_clipped(beat, tolerance=None, fps=FPS):
    """Return true only for a trusted first word whose audio starts after the IN edge."""
    start = _number(beat.get("first_word_start"))
    source_in = _number(beat.get("src_in"))
    if tolerance is None:
        tolerance = 0.5 / float(fps)
    return bool(beat.get("first_word_trustworthy")) and start is not None and source_in is not None \
        and source_in > start + tolerance


def defects_for(idx, beat, fps=FPS):
    """The three in-take faults worth flagging, from the locked procedure."""
    out = []
    if first_word_clipped(beat, fps=fps):
        out.append("first word clipped")
    if idx.head_silence(beat["src_in"]) > 0.30:
        out.append("dead air at IN")
    if loud_out_finding(idx, beat["src_out"], fps=fps):
        out.append("OUT has a loud boundary")
    words = [norm(w) for w in beat["text"].split()]
    if any(words[i] and words[i] == words[i + 1] for i in range(len(words) - 1)):
        out.append("stutter (repeated word)")
    if beat["src_out"] - beat["src_in"] < 0.45:
        out.append("very short")
    return out


def cmd_index(args):
    media = os.path.abspath(args.media)
    fps = authoritative_fps(override=getattr(args, "fps", None))
    cache_dir = os.path.expanduser("~/Downloads/.video-index")
    os.makedirs(cache_dir, exist_ok=True)

    print(f"aroll index {os.path.basename(media)}", file=sys.stderr)
    idx = AudioIndex.build_or_load(media, force=getattr(args, "reindex", False))
    print(f"  energy index: {len(idx.db)} bins @ {int(idx.bin*1000)}ms = {len(idx.db)*idx.bin:.1f}s", file=sys.stderr)
    result = transcribe(media, args.lang, args.model, cache_dir, force=getattr(args, "reindex", False))

    beats = []
    for seg in result.get("segments", []):
        text = seg.get("text", "").strip()
        if not text or CREDIT.search(text):
            continue
        for a, b in split_on_dead_air(idx, seg["start"], seg["end"]):
            floor = beats[-1]["src_out"] if beats else 0.0
            word = first_word_in(seg, a, b)
            acoustic_onset = idx.onset_after(max(floor, a - 0.30))
            trusted = trustworthy_word_start(idx, word, acoustic_onset, floor=floor, fps=fps)
            snapped = snap(
                idx, a, b, floor=floor,
                word_start=word["start"] if word else None,
                word_start_trustworthy=trusted,
                fps=fps,
            )
            if snapped is None:
                continue
            src_in, src_out = snapped
            if src_out - src_in < MIN_BEAT:
                continue
            slice_text = words_in(seg, src_in, src_out) or text
            beats.append({
                "id": len(beats), "text": slice_text, "src_in": src_in, "src_out": src_out,
                "dur": round(src_out - src_in, 3), "take": 0,
                "dupe_group": None, "is_last_of_group": True, "defects": [],
                "first_word": word["text"] if word else "",
                "first_word_start": word["start"] if word else None,
                "first_word_trustworthy": trusted,
            })
    detect_takes(beats)
    groups = group_duplicates(beats)
    for beat in beats:
        beat["defects"] = defects_for(idx, beat, fps=fps)

    # The default selection is scene-based, not take-based: retain every unique beat and
    # choose the last complete attempt for each duplicate group across all takes.
    keep = suggested_keep(beats, groups)

    raw = sum(b["dur"] for b in beats)
    token = media_token(media)
    out = {
        "version": AROLL_INDEX_VERSION, "media": media, "fps": fps,
        "source_token": token, "media_token": token,
        "source_duration": round(len(idx.db) * idx.bin, 3),
        "beats": beats,
        "takes": [{"id": t, "beats": [b["id"] for b in beats if b["take"] == t],
                   "duration": round(sum(b["dur"] for b in beats if b["take"] == t), 2)}
                  for t in sorted({b["take"] for b in beats})],
        "duplicate_groups": [g for g in groups
                             if len(g["members"]) > 1 and g.get("status") != "review"],
        "duplicate_review": [g for g in groups
                             if len(g["members"]) > 1 and g.get("status") == "review"],
        "default_keep": keep,
        "stats": {
            "beats": len(beats), "speech": round(raw, 2),
            "dead_air_removed": round(len(idx.db) * idx.bin - raw, 2),
            "default_cut_duration": round(sum(beats[i]["dur"] for i in keep), 2),
        },
    }
    path = args.out or os.path.join(os.path.dirname(media),
                                    os.path.basename(media).rsplit(".", 1)[0] + ".aroll.json")
    Path(path).write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print_handout(out, path)
    return 0


def compact(ids):
    """[0,2,3,4,5,9] -> '0,2-5,9' so the suggested command is short enough to edit."""
    if not ids:
        return ""
    runs, start, prev = [], ids[0], ids[0]
    for i in ids[1:]:
        if i == prev + 1:
            prev = i
            continue
        runs.append((start, prev)); start = prev = i
    runs.append((start, prev))
    return ",".join(str(a) if a == b else f"{a}-{b}" for a, b in runs)


def print_handout(data, path):
    s = data["stats"]
    print(f"\n{'='*78}\nA-ROLL HANDOUT — {os.path.basename(data['media'])}")
    print(f"source {data['source_duration']:.1f}s | speech {s['speech']:.1f}s | "
          f"dead air removed {s['dead_air_removed']:.1f}s | {s['beats']} beats")
    print("takes: " + ", ".join(f"#{t['id']} ({len(t['beats'])} beats, {t['duration']:.1f}s)"
                                 for t in data["takes"]))
    print(f"default keep: {len(data['default_keep'])} beats = {s['default_cut_duration']:.1f}s "
          f"(all unique beats, last complete instance of every repeat)")
    if data["duplicate_groups"]:
        print("\nrepeated lines — LAST COMPLETE instance wins:")
        for g in data["duplicate_groups"]:
            print(f"   beats {g['members']}  -> beat {g.get('selected')}  \"{g['key']}\"")
    if data.get("duplicate_review"):
        print("\nsimilar lines — REVIEW (all retained; no retry evidence):")
        for g in data["duplicate_review"]:
            print(f"   beats {g['members']}  {g.get('reason', 'ambiguous duplicate')}")
    head = f"{'id':>3} {'take':>4} {'in':>8} {'out':>8} {'dur':>6}  {'keep':>4}  text"
    rows = []
    for b in data["beats"]:
        mark = "KEEP" if b["id"] in data["default_keep"] else "  · "
        flag = (" ⚠ " + "; ".join(b["defects"])) if b["defects"] else ""
        rows.append(f"{b['id']:>3} {b['take']:>4} {b['src_in']:>8.3f} {b['src_out']:>8.3f} "
                    f"{b['dur']:>6.2f}  {mark}  {b['text']}{flag}")
    # untruncated text runs past 78 columns, so size the rules to the table instead of
    # leaving rows hanging off the end of a rule that no longer means anything
    rule = "-" * max([78] + [len(r) for r in rows])
    print(f"\n{head}")
    print(rule)
    for r in rows:
        print(r)
    print(rule)
    print(f"wrote {path}")
    print(f"\nreview the text above, then build with your selection:\n"
          f"  capcutctl cut {os.path.basename(data['media'])} "
          f"--keep {compact(data['default_keep'])} --project NAME")


# ---------------------------------------------------------------- cutting
def parse_ids(spec):
    out = set()
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            bits = part.split("-")
            if len(bits) != 2:
                raise ValueError(f"bad id range {part!r}")
            a, b = int(bits[0]), int(bits[1])
            if b < a:
                raise ValueError(f"reversed id range {part!r}")
            out.update(range(a, b + 1))
        else:
            out.add(int(part))
    return out


def repair(idx, picked, fps=FPS):
    """
    Apply the lint's own suggestions. These are mechanical — the trough and the onset are
    computed, not judged — so there is no reason to hand them back to a human.
    A boundary is only moved when it cannot collide with the neighbouring kept beat.
    """
    fixed = []
    for i, b in enumerate(picked):
        nxt = picked[i + 1] if i + 1 < len(picked) else None
        prev = picked[i - 1] if i else None

        # Use the same predicate as lint. A flat loud OUT is intentionally left as a
        # blocking finding; repair must never claim to have fixed a boundary it cannot move.
        loud = loud_out_finding(idx, b["src_out"], fps=fps)
        if loud:
            tr = quantise(loud["trough"], fps=fps)
            ceiling = nxt["src_in"] if nxt else b["src_out"] + 0.5
            can_repair = (loud["repairable"] and b["src_in"] < tr <= ceiling
                          and idx.at(tr) < loud["level"] - 6.0 and tr != b["src_out"])
            if can_repair:
                fixed.append(f"b{b['id']} OUT {b['src_out']:.3f} -> {tr:.3f} (trough, {idx.at(tr):.0f}dB)")
                b["src_out"] = tr
            elif loud["repairable"]:
                fixed.append(f"b{b['id']} OUT remains blocking at {b['src_out']:.3f} "
                             f"(trough {tr:.3f} is outside the safe neighbouring range)")
            else:
                fixed.append(f"b{b['id']} OUT remains blocking at {b['src_out']:.3f} "
                             "(no safe trough in the repair window)")

        # dead air at the head -> slide IN forward to the real onset
        head = idx.head_silence(b["src_in"])
        if head > 0.30:
            # A quiet/unvoiced first consonant can look like dead air to the envelope. Once
            # Whisper's first word start passed the trust check, never slide beyond its
            # protected two-frame lead; doing so recreates the Arabic first-word crop.
            protected = None
            if b.get("first_word_trustworthy"):
                protected = protected_word_in(b.get("first_word_start"),
                                              floor=prev["src_out"] if prev else 0.0,
                                              fps=fps)
                if protected is not None and b["src_in"] > protected:
                    fixed.append(f"b{b['id']} IN {b['src_in']:.3f} -> {protected:.3f} "
                                 "(protects trusted first word)")
                    b["src_in"] = protected
                if protected is not None and b["src_in"] <= protected:
                    continue
            on = idx.onset_after(b["src_in"])
            if on is not None:
                new_in = quantise(max(prev["src_out"] if prev else 0.0,
                                      on - LEAD_FRAMES / float(fps)), fps=fps)
                if b["src_in"] < new_in < b["src_out"] - MIN_BEAT:
                    fixed.append(f"b{b['id']} IN {b['src_in']:.3f} -> {new_in:.3f} (cuts {head:.2f}s dead air)")
                    b["src_in"] = new_in
    return fixed


def audio_ramp_seconds(frames=AUDIO_RAMP_FRAMES, fps=FPS):
    """Return a frame-exact duration suitable for CapCut's seconds-based fade operation."""
    if not isinstance(frames, int) or frames < 1 or frames > 2:
        raise ValueError("audio ramps must be one or two frames")
    if not _number(fps) or fps <= 0:
        raise ValueError("fps must be positive")
    return frames / float(fps)


def add_audio_ramps(timeline, frames=AUDIO_RAMP_FRAMES, fps=FPS):
    """Annotate each generated A-roll scene with two-frame in/out audio ramps and 1x speed."""
    seconds = audio_ramp_seconds(frames, fps)
    return [
        {
            **scene,
            "speed": 1.0,
            "audio_fade": {
                "in": round(seconds, 6),
                "out": round(seconds, 6),
                "in_frames": frames,
                "out_frames": frames,
            },
        }
        for scene in timeline
    ]


def audio_ramp_operations(timeline, track="content", frames=AUDIO_RAMP_FRAMES, fps=FPS):
    """Build the existing capcutctl `clip.fade` operations for a cut handoff."""
    seconds = round(audio_ramp_seconds(frames, fps), 6)
    return [
        {
            "op": "clip.fade",
            "at": round(scene["tl_in"], 6),
            "track": track,
            "in": seconds,
            "out": seconds,
        }
        for scene in timeline
    ]


def cut_handoff(destination, timeline, mode="plan", track="content", frames=AUDIO_RAMP_FRAMES, fps=FPS):
    """Describe the stable Python-to-CLI handoff without changing the JS argument parser.

    `mode=new` means `capcutctl new --project DEST --scenes ...` has created the content
    track and the caller should apply the returned operations. `mode=into` means DEST is an
    existing project and the operations target its named `content` track. The operations do
    not change source windows or target durations, so the principal remains exactly 1x.
    """
    return {
        "mode": mode,
        "project": destination,
        "track": track,
        "fps": fps,
        "principal_speed": 1.0,
        "audio_ramp_frames": frames,
        "operations": audio_ramp_operations(timeline, track=track, frames=frames, fps=fps),
    }


def apply_audio_ramps(destination, timeline, dry_run=False, track="content", frames=AUDIO_RAMP_FRAMES, fps=FPS):
    """Apply all native fades in one transactional capcutctl spec, then remove the temp file."""
    spec = {"version": 1, "name": "aroll-audio-ramps", "operations":
            audio_ramp_operations(timeline, track=track, frames=frames, fps=fps)}
    spec_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", encoding="utf-8", delete=False) as handle:
            json.dump(spec, handle, ensure_ascii=False, indent=1)
            spec_path = handle.name
        cmd = ["capcutctl", "apply", "--project", str(destination), "--spec", spec_path]
        if dry_run:
            cmd.append("--dry-run")
        print("\n$ capcutctl apply --project <destination> --spec <aroll-audio-ramps>")
        result = subprocess.run(cmd, capture_output=True, text=True)
        print(result.stdout or result.stderr)
        return result.returncode
    finally:
        if spec_path:
            Path(spec_path).unlink(missing_ok=True)


def cmd_cut(args):
    data = json.loads(Path(args.index).read_text())
    fps = authoritative_fps(data, getattr(args, "fps", None))
    stored_token = data.get("source_token", data.get("media_token"))
    if stored_token is not None:
        try:
            current_token = media_token(data["media"])
        except (KeyError, OSError, TypeError, ValueError):
            print("A-roll index source is missing or unreadable", file=sys.stderr)
            return 2
        if stored_token != current_token:
            print("A-roll index is stale for the current media; re-index before cutting",
                  file=sys.stderr)
            return 2
    beats = {b["id"]: b for b in data["beats"]}
    keep = parse_ids(args.keep) if args.keep else set(data["default_keep"])
    if args.drop:
        keep -= parse_ids(args.drop)
    keep = [i for i in sorted(keep) if i in beats]
    if not keep:
        print("nothing kept", file=sys.stderr)
        return 2

    idx = AudioIndex.build_or_load(data["media"])
    picked = [dict(beats[i]) for i in keep]
    # An index may have been produced at the default rate and later handed to a project
    # with a different FPS. Make the supplied/project rate authoritative before linting or
    # emitting any source boundary; otherwise core would validate a 30fps-looking plan for
    # a 24fps or 29.97fps timeline.
    for beat in picked:
        beat["src_in"] = quantise(beat["src_in"], fps=fps)
        beat["src_out"] = quantise(beat["src_out"], fps=fps)

    if not args.no_repair:
        repairs = repair(idx, picked, fps=fps)
        for r in repairs:
            print("  " + ("note: " if " remains blocking " in r else "fixed: ") + r)
        for b, p in zip(keep, picked, strict=True):
            beats[b]["src_in"], beats[b]["src_out"] = p["src_in"], p["src_out"]
    else:
        for b, p in zip(keep, picked, strict=True):
            beats[b]["src_in"], beats[b]["src_out"] = p["src_in"], p["src_out"]

    spans = [(f"b{p['id']}", p["src_in"], p["src_out"]) for p in picked]
    first_words = [
        {
            "start": p.get("first_word_start"),
            "word": p.get("first_word", ""),
            "trustworthy": bool(p.get("first_word_trustworthy")),
        }
        for p in picked
    ]
    findings = lint(idx, spans, fps=fps, first_word_starts=first_words)
    for (la, _, ea), (lb, sb, _) in pairwise(spans):
        if sb < ea:
            findings.append(f"{la}->{lb} OVERLAP {ea - sb:.3f}s of source is used twice")

    # pack the timeline with no gaps — this is the dead-space removal
    timeline, cursor = [], 0.0
    for p in picked:
        i = p["id"]
        b = p
        dur = quantise(b["src_out"] - b["src_in"], fps=fps)
        tl_in = quantise(cursor, fps=fps)
        tl_out = quantise(tl_in + dur, fps=fps)
        timeline.append({"beat": i, "tl_in": round(tl_in, 6), "tl_out": round(tl_out, 6),
                         "src_in": round(b["src_in"], 6), "dur": round(dur, 6), "text": b["text"]})
        cursor = tl_out

    timeline = add_audio_ramps(timeline, fps=fps)
    destination = getattr(args, "into", None) or getattr(args, "project", None)
    handoff_mode = "into" if getattr(args, "into", None) else ("new" if args.project else "plan")
    blocking_findings = [f for f in findings if "FIRST_WORD_CLIPPED" in f]

    scenes = ",".join(f"{t['tl_in']:.6f}:{t['tl_out']:.6f}@{t['src_in']:.6f}" for t in timeline)
    plan = {"media": data["media"], "fps": fps,
            "fps_contract": {"fps": fps, "quantized": True, "authority": "input"},
            "kept": keep, "timeline": timeline,
            "duration": round(cursor, 6), "lint": findings, "blocking_lint": blocking_findings,
            "scenes": scenes, "handoff": cut_handoff(destination, timeline, mode=handoff_mode, fps=fps)}
    plan_path = getattr(args, "plan", None) or args.index.replace(".aroll.json", ".plan.json")
    Path(plan_path).write_text(json.dumps(plan, ensure_ascii=False, indent=1))

    print(f"kept {len(keep)} beats -> {cursor:.2f}s (source {data['source_duration']:.1f}s)")
    for t in timeline:
        # never slice the text: [:46] cut Arabic mid-word, and this is the table he actually
        # reads back after choosing beats. Text is the last field, so the numbers still line up.
        print(f"  {t['tl_in']:>9.6f}->{t['tl_out']:>9.6f}  src {t['src_in']:>9.6f}  {t['text']}")
    print(f"\nseam lint: {'CLEAN' if not findings else str(len(findings)) + ' findings'}")
    for f in findings:
        print("  ! " + f)
    print(f"wrote {plan_path}")

    if destination:
        # First-word clipping is a safety failure, not a subjective seam warning. Keep
        # `--force` useful for exploratory acoustic overrides, but never let it build a
        # cut that is known to remove the start of a trusted Arabic word.
        if blocking_findings:
            print("\nrefusing to build with first-word clipping findings", file=sys.stderr)
            return 1
        if findings and not args.force:
            print("\nrefusing to build with unresolved seam findings; re-run with --force to override",
                  file=sys.stderr)
            return 1
        if args.project:
            cmd = ["capcutctl", "new", "--project", args.project,
                   "--media", data["media"], "--scenes", scenes]
            if args.dry_run:
                cmd.append("--dry-run")
            print("\n$ " + " ".join(cmd[:6]) + f" --scenes <{len(timeline)} scenes>")
            result = subprocess.run(cmd, capture_output=True, text=True)
            print(result.stdout or result.stderr)
            if result.returncode:
                return result.returncode
            # `new` creates the editable 1x content track; apply all fades in one follow-up
            # transaction so root and active-timeline mirrors receive the same extras.
            if args.dry_run:
                return 0
            return apply_audio_ramps(args.project, timeline, track="content", fps=fps)
        return apply_audio_ramps(args.into, timeline, dry_run=args.dry_run, track="content", fps=fps)
    return 0


def cmd_selftest(args):
    """Guards the pure logic. The overlap bug below shipped silently once already."""
    ok = []
    def check(name, cond):
        ok.append(cond)
        print(f"  {'PASS' if cond else 'FAIL'}  {name}")

    check("parse_ids ranges", parse_ids("1,3-5,9") == {1, 3, 4, 5, 9})
    try:
        parse_ids("9-2")
        check("parse_ids rejects reversed ranges", False)
    except ValueError:
        check("parse_ids rejects reversed ranges", True)
    check("quantise snaps to frames", abs(quantise(1.0 / 30 * 2.4) - 2 / 30) < 1e-9)
    check("norm folds arabic orthography", norm("أَحْلَى") == norm("احلى"))
    check("norm strips punctuation", norm("hello, world!") == "hello world")
    check("credit line is dropped", bool(CREDIT.search("ترجمة نانسي قنقر")))
    demo = [
        {"id": 0, "text": "شرح طويل لكل خطوات الربط", "take": 0},
        {"id": 1, "text": "اكتبوا دليل بالتعليقات", "take": 0},
        {"id": 2, "text": "اكتبوا دليل بالتعليقات", "take": 1},
    ]
    demo_groups = group_duplicates(demo)
    check("default keep retains an early unique beat and late duplicate winner",
          suggested_keep(demo, demo_groups) == [0, 2])
    check("flat loud boundary is linted", any(
        "LOUD_BOUNDARY" in f for f in lint(AudioIndex([-20.0] * 120, 0.01), [("a", 0.2, 0.8)])))
    check("generated splice ramp is two frames and principal is 1x",
          add_audio_ramps([{"tl_in": 0.0, "tl_out": 1.0}])[0]["speed"] == 1.0
          and add_audio_ramps([{"tl_in": 0.0, "tl_out": 1.0}])[0]["audio_fade"]["in_frames"] == 2)

    class Fake:
        """silence, speech 1.0-2.0, silence, speech 3.0-4.0, silence"""
        bin = 0.01
        def at(self, t): return -20.0 if (1.0 <= t < 2.0 or 3.0 <= t < 4.0) else -70.0
        def rising(self, t, span=0.10): return False
        def head_silence(self, t, thresh=SOFT, cap=2.0):
            n = 0
            while n * self.bin < cap and self.at(t + n * self.bin) < thresh: n += 1
            return n * self.bin
        def tail_silence(self, t, thresh=SOFT, cap=2.0):
            n = 0
            while n * self.bin < cap and self.at(t - (n + 1) * self.bin) < thresh: n += 1
            return n * self.bin
        def onset_after(self, t, thresh=SOFT, cap=3.0):
            n = 0
            while n * self.bin < cap:
                if self.at(t + n * self.bin) >= thresh: return t + n * self.bin
                n += 1
            return None
        def trough(self, t, win=0.20): return t

    fake = Fake()
    spans = split_on_dead_air(fake, 0.5, 4.5)
    check("dead air splits one beat into two", len(spans) == 2)
    check("leading silence is not its own beat", abs(spans[0][0] - 1.0) < 0.02)

    a1, b1 = snap(fake, 0.9, 2.1)
    a2, _ = snap(fake, 2.9, 4.1, floor=b1)
    check("snap finds the onset", abs(a1 - (1.0 - LEAD_FRAMES * FRAME)) < 0.05)
    check("consecutive beats never overlap", a2 >= b1)

    seg = {"start": 0.5, "end": 4.5, "text": "hello world and more",
           "words": [{"start": 1.1, "word": "hello"}, {"start": 3.2, "word": "world"}]}
    check("words_in uses the window not the parent", words_in(seg, 1.0, 2.2) == "hello")

    from audio_index import lint as lint_seams
    findings = lint_seams(fake, [("a", 3.5, 4.5), ("b", 8.0, 8.5)])
    check("lint reports no-onset rather than crashing",
          any("no onset" in f for f in findings))

    print("selftest:", "all passed" if all(ok) else "FAILURES")
    return 0 if all(ok) else 1


def main():
    ap = argparse.ArgumentParser(
        prog="capcutctl cut",
        description="One command. Run it on a video to get a review table; run it again "
                    "with --keep to build the project.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("media", nargs="?", help="the talking-head recording")
    ap.add_argument("--keep", help="beat ids to keep, e.g. 0,2,3,7-16")
    ap.add_argument("--drop", help="beat ids to remove from the default selection")
    destination = ap.add_mutually_exclusive_group()
    destination.add_argument("--project", help="build this new CapCut project from the selection")
    destination.add_argument("--into", help="apply the cut handoff to an existing project")
    destination.add_argument("--in-place", dest="into", action="store_const", const=".",
                             help="alias for --into . (existing project in the current directory)")
    ap.add_argument("--lang", default=None, help="e.g. ar; omit to auto-detect")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"default {DEFAULT_MODEL}")
    ap.add_argument("--fps", type=float, default=None,
                    help="authoritative project FPS (for example 24 or 29.97)")
    ap.add_argument("--reindex", action="store_true", help="ignore the cached index")
    ap.add_argument("--no-repair", action="store_true", help="do not auto-fix seam faults")
    ap.add_argument("--force", action="store_true", help="build despite seam findings")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true", help="check the pure logic")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(cmd_selftest(args))
    if not args.media:
        ap.error("a media path is required")

    media = os.path.abspath(args.media)
    if not os.path.exists(media):
        ap.error(f"no such file: {media}")
    args.index = os.path.join(os.path.dirname(media),
                              os.path.basename(media).rsplit(".", 1)[0] + ".aroll.json")
    args.out = args.index
    args.media = media

    # index once, reuse thereafter — the expensive half never runs twice
    if args.reindex or not os.path.exists(args.index) or not index_is_current(args.index, media):
        cmd_index(args)
        if not (args.keep or args.drop or args.project or args.into):
            sys.exit(0)
        print()
    elif not (args.keep or args.drop or args.project or args.into):
        print_handout(json.loads(Path(args.index).read_text()), args.index)
        sys.exit(0)

    args.plan = None
    sys.exit(cmd_cut(args))


if __name__ == "__main__":
    main()
