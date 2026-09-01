#!/usr/bin/env python3
"""
aroll — deterministic A-roll (talking head) cleanup.

One command, run twice. Code does the mechanical work; the agent only makes judgement calls.

    capcutctl cut VIDEO.mp4 [--lang ar]
        Transcribe with word timestamps, build the acoustic energy index, snap every
        boundary acoustically, delete dead air, detect takes and repeated beats, and
        write a handout for the agent to read.

    capcutctl cut VIDEO.mp4 --keep 0,2-9 --order 0,2,3 --trim-beat 3:out=-1.16 --project NAME
        Apply the agent's selection/order/boundary hints, lint every seam, pack the timeline
        with no gaps, and build the CapCut project. `--review decisions.json` accepts the same
        decisions as a source-tokened v1 JSON file, and `--into` uses the transactional recut.

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
import shlex
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
AROLL_INDEX_VERSION = 5
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


def word_entries_in(seg, a, b):
    """Words whose timestamps overlap [a, b), retaining any caller metadata."""
    picked = []
    for word in seg.get("words") or []:
        start = _word_start(word)
        if start is None or start >= b:
            continue
        end = _word_end(word)
        overlaps = end > a if end is not None else start >= a - WORD_START_LOOKBACK
        if overlaps:
            picked.append(word)
    return picked


def words_in(seg, a, b):
    """Text whose word timestamps overlap [a, b), not the parent Whisper segment."""
    text = " ".join((word.get("word") or word.get("text") or "").strip()
                    for word in word_entries_in(seg, a, b)).strip()
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

    segments = result.get("segments", [])
    all_words = [
        {**word, "_aroll_segment": segment_id}
        for segment_id, segment in enumerate(segments)
        for word in segment.get("words") or []
    ]
    beats = []
    for segment_id, seg in enumerate(segments):
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
            source_words = word_entries_in({"words": all_words}, src_in, src_out)
            foreign = [entry for entry in source_words
                       if entry.get("_aroll_segment", segment_id) < segment_id]
            beat = {
                "id": len(beats), "text": slice_text, "src_in": src_in, "src_out": src_out,
                "dur": round(src_out - src_in, 3), "take": 0,
                "dupe_group": None, "is_last_of_group": True, "defects": [],
                "first_word": word["text"] if word else "",
                "first_word_start": word["start"] if word else None,
                "first_word_trustworthy": trusted,
            }
            if source_words:
                last = source_words[-1]
                beat["last_word"] = (last.get("word") or last.get("text") or "").strip()
                beat["last_word_end"] = _word_end(last)
            if foreign:
                beat["foreign_lead"] = " ".join(
                    (entry.get("word") or entry.get("text") or "").strip()
                    for entry in foreign
                ).strip()
                if beats:
                    beat["continuation_of"] = beats[-1]["id"]
                    beats[-1]["continued_by"] = beat["id"]
            beats.append(beat)
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
        "words": [
            {
                "text": (word.get("word") or word.get("text") or "").strip(),
                "start": _word_start(word), "end": _word_end(word),
                "segment": word.get("_aroll_segment"),
            }
            for word in all_words
            if _word_start(word) is not None and _word_end(word) is not None
        ],
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
        if b.get("foreign_lead"):
            source = (f"b{b['continuation_of']}" if b.get("continuation_of") is not None
                      else "an unrepresented prior segment")
            flag += f" ⚠ continuous from {source}: {b['foreign_lead']}"
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
          f"  capcutctl cut {shlex.quote(data['media'])} "
          f"--keep {compact(data['default_keep'])} --project NAME")


# ---------------------------------------------------------------- cutting
def _parse_id_part(part, field):
    """Parse one non-negative id or ascending id range."""
    part = str(part).strip()
    if not part:
        raise ValueError(f"{field} contains an empty beat id")
    if "-" in part:
        bits = part.split("-")
        if len(bits) != 2 or not all(re.fullmatch(r"\d+", bit.strip()) for bit in bits):
            raise ValueError(f"bad id range {part!r} in {field}")
        a, b = (int(bit.strip()) for bit in bits)
        if b < a:
            raise ValueError(f"reversed id range {part!r} in {field}")
        return list(range(a, b + 1))
    if not re.fullmatch(r"\d+", part):
        raise ValueError(f"invalid beat id {part!r} in {field}")
    return [int(part)]


def parse_order_spec(spec, field="order"):
    """Parse an ordered id list while preserving order and rejecting duplicates."""
    if isinstance(spec, (list, tuple)):
        values = []
        for value in spec:
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field} must contain non-negative integer beat ids")
            values.append(value)
    elif isinstance(spec, str):
        values = []
        for part in spec.split(","):
            values.extend(_parse_id_part(part, field))
    else:
        raise ValueError(f"{field} must be a comma-separated id list or an array")
    duplicates = sorted({value for value in values if values.count(value) > 1})
    if duplicates:
        raise ValueError(f"{field} contains duplicate beat ids: {duplicates}")
    return values


def parse_ids(spec):
    return set(parse_order_spec(str(spec), field="beat selection"))


def _finite_offset(value, field):
    number = _number(value)
    if number is None:
        raise ValueError(f"{field} must be a finite number of seconds")
    return number


def parse_boundaries(boundaries):
    """Validate the review-file boundary map and return canonical camelCase fields."""
    if boundaries is None:
        return {}
    if not isinstance(boundaries, dict):
        raise ValueError("boundaries must be an object keyed by beat id")
    out = {}
    for raw_id, rule in boundaries.items():
        if not re.fullmatch(r"\d+", str(raw_id)):
            raise ValueError(f"boundaries contains an invalid beat id: {raw_id!r}")
        beat_id = int(raw_id)
        if not isinstance(rule, dict):
            raise ValueError(f"boundaries[{raw_id!r}] must be an object")
        unknown = set(rule) - {"inOffset", "outOffset"}
        if unknown:
            raise ValueError(f"boundaries[{raw_id!r}] has unsupported fields: {sorted(unknown)}")
        if not rule:
            raise ValueError(f"boundaries[{raw_id!r}] must contain inOffset or outOffset")
        parsed = {}
        if "inOffset" in rule:
            value = _finite_offset(rule["inOffset"], f"boundaries[{raw_id!r}].inOffset")
            if value < 0:
                raise ValueError(f"boundaries[{raw_id!r}].inOffset must be non-negative (inward only)")
            parsed["inOffset"] = value
        if "outOffset" in rule:
            value = _finite_offset(rule["outOffset"], f"boundaries[{raw_id!r}].outOffset")
            if value > 0:
                raise ValueError(f"boundaries[{raw_id!r}].outOffset must be non-positive (inward only)")
            parsed["outOffset"] = value
        out[beat_id] = parsed
    return out


def parse_trim_specs(specs):
    """Parse repeated --trim-beat ID:in=SECONDS / ID:out=SECONDS flags."""
    if specs is None:
        return {}
    if isinstance(specs, str):
        specs = [specs]
    if not isinstance(specs, (list, tuple)):
        raise ValueError("--trim-beat expects one or more ID:in=SECONDS or ID:out=SECONDS values")
    out = {}
    pattern = re.compile(r"^\s*(\d+)\s*:\s*(in|out)\s*=\s*"
                         r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*$")
    for raw in specs:
        match = pattern.fullmatch(str(raw))
        if not match:
            raise ValueError(f"bad --trim-beat {raw!r}; use ID:in=SECONDS or ID:out=SECONDS")
        beat_id, side, raw_value = int(match.group(1)), match.group(2), match.group(3)
        value = _finite_offset(raw_value, f"--trim-beat {raw!r}")
        if side == "in" and value < 0:
            raise ValueError(f"--trim-beat {raw!r} expands the beat at IN; inward trims use a positive offset")
        if side == "out" and value > 0:
            raise ValueError(f"--trim-beat {raw!r} expands the beat at OUT; inward trims use a negative offset")
        key = f"{side}Offset"
        if key in out.setdefault(beat_id, {}):
            raise ValueError(f"duplicate {key} adjustment for beat {beat_id}")
        out[beat_id][key] = value
    return out


def parse_recovery_specs(specs):
    """Parse reviewed outward search windows: ID:in=SECONDS / ID:out=SECONDS."""
    if specs is None:
        return {}
    if isinstance(specs, str):
        specs = [specs]
    if not isinstance(specs, (list, tuple)):
        raise ValueError("--recover-beat expects one or more ID:in=SECONDS or ID:out=SECONDS values")
    out = {}
    pattern = re.compile(r"^\s*(\d+)\s*:\s*(in|out)\s*=\s*"
                         r"([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*$")
    for raw in specs:
        match = pattern.fullmatch(str(raw))
        if not match:
            raise ValueError(f"bad --recover-beat {raw!r}; use ID:in=SECONDS or ID:out=SECONDS")
        beat_id, side, raw_value = int(match.group(1)), match.group(2), match.group(3)
        value = _finite_offset(raw_value, f"--recover-beat {raw!r}")
        if value <= 0:
            raise ValueError(f"--recover-beat {raw!r} needs a positive outward search window")
        if side in out.setdefault(beat_id, {}):
            raise ValueError(f"duplicate {side} recovery for beat {beat_id}")
        out[beat_id][side] = value
    return out


def parse_recoveries(value):
    """Validate the review-file recovery map using the CLI's one compact parser."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("recoveries must be an object keyed by beat id")
    specs = []
    for raw_id, rule in value.items():
        if not re.fullmatch(r"\d+", str(raw_id)):
            raise ValueError(f"recoveries contains an invalid beat id: {raw_id!r}")
        if not isinstance(rule, dict) or not rule:
            raise ValueError(f"recoveries[{raw_id!r}] must contain in or out")
        unknown = set(rule) - {"in", "out"}
        if unknown:
            raise ValueError(f"recoveries[{raw_id!r}] has unsupported fields: {sorted(unknown)}")
        specs.extend(f"{raw_id}:{side}={amount}" for side, amount in rule.items())
    return parse_recovery_specs(specs)


def _ids_known(values, beats, field):
    unknown = sorted(set(values) - set(beats))
    if unknown:
        raise ValueError(f"{field} contains unknown beat ids: {unknown}")


def load_review(path, data):
    """Load a v1 review decision file and reject stale or ambiguous source decisions."""
    review_path = os.path.abspath(os.fspath(path))
    try:
        review = json.loads(Path(review_path).read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"could not read review file {review_path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"review file is not valid JSON: {error}") from error
    if not isinstance(review, dict):
        raise ValueError("review file must contain a JSON object")
    if review.get("version") != 1:
        raise ValueError("review file version must be 1")
    if "sourceToken" not in review:
        raise ValueError("review file requires sourceToken copied from the current A-roll index")
    expected = data.get("source_token", data.get("media_token"))
    if expected is None or review["sourceToken"] != expected:
        raise ValueError("review file sourceToken is stale; re-read the current .aroll.json index")
    for field in ("keep", "order"):
        if field in review and not isinstance(review[field], list):
            raise ValueError(f"review field {field} must be an array of beat ids")
    keep = parse_order_spec(review["keep"], "review.keep") if "keep" in review else None
    order = parse_order_spec(review["order"], "review.order") if "order" in review else None
    return {
        "path": review_path,
        "keep": keep,
        "order": order,
        "boundaries": parse_boundaries(review.get("boundaries")),
        "recoveries": parse_recoveries(review.get("recoveries")),
        "sourceToken": review["sourceToken"],
    }


def resolve_editorial_decisions(data, args):
    """Resolve flags or a review file into a strict keep/order/boundary decision."""
    review_path = getattr(args, "review", None)
    direct = [name for name in ("keep", "drop", "order", "trim_beat", "recover_beat")
              if getattr(args, name, None) not in (None, "", [])]
    if review_path and direct:
        raise ValueError("--review cannot be combined with --keep, --drop, --order, --trim-beat, or --recover-beat")

    beats = {beat["id"]: beat for beat in data.get("beats", [])}
    review = load_review(review_path, data) if review_path else None
    if review:
        kept = list(data.get("default_keep", [])) if review["keep"] is None else review["keep"]
        _ids_known(kept, beats, "review.keep")
        ordered = review["order"] if review["order"] is not None else sorted(set(kept))
        boundaries = review["boundaries"]
        recoveries = review["recoveries"]
    else:
        if getattr(args, "keep", None):
            kept = sorted(parse_ids(args.keep))
        else:
            kept = list(data.get("default_keep", []))
        _ids_known(kept, beats, "keep")
        if getattr(args, "drop", None):
            dropped = parse_ids(args.drop)
            _ids_known(dropped, beats, "drop")
            kept = [beat_id for beat_id in kept if beat_id not in dropped]
        ordered = parse_order_spec(args.order, "order") if getattr(args, "order", None) else sorted(set(kept))
        boundaries = parse_trim_specs(getattr(args, "trim_beat", None))
        recoveries = parse_recovery_specs(getattr(args, "recover_beat", None))

    if not kept:
        raise ValueError("nothing kept")
    _ids_known(ordered, beats, "order")
    if len(ordered) != len(set(kept)) or set(ordered) != set(kept):
        raise ValueError("order must be an exact permutation of the kept beat ids")
    unknown_boundaries = sorted(set(boundaries) - set(beats))
    if unknown_boundaries:
        raise ValueError(f"boundary adjustments contain unknown beat ids: {unknown_boundaries}")
    not_kept = sorted(set(boundaries) - set(kept))
    if not_kept:
        raise ValueError(f"boundary adjustments target beats that are not kept: {not_kept}")
    unknown_recoveries = sorted(set(recoveries) - set(beats))
    if unknown_recoveries:
        raise ValueError(f"outward recoveries contain unknown beat ids: {unknown_recoveries}")
    not_kept = sorted(set(recoveries) - set(kept))
    if not_kept:
        raise ValueError(f"outward recoveries target beats that are not kept: {not_kept}")
    both = sorted(set(boundaries) & set(recoveries))
    if both:
        raise ValueError(f"beats cannot be trimmed and recovered in one decision: {both}")
    return {
        "kept": sorted(set(kept)),
        "order": ordered,
        "boundaries": boundaries,
        "recoveries": recoveries,
        "review": review,
    }


def _trough_before(idx, t, lower, upper, win=0.45):
    """Find the quietest indexed bin at or before t within a bounded trim window."""
    lo = max(float(lower), float(t) - float(win))
    hi = min(float(upper), float(t))
    if hi < lo:
        return None
    step = _number(getattr(idx, "bin", None))
    if step is None or step <= 0:
        return None
    count = max(1, math.floor((hi - lo) / step) + 1)
    candidates = [min(hi, lo + index * step) for index in range(count)]
    candidates.append(hi)
    return min(candidates, key=lambda value: idx.at(value))


def apply_boundary_adjustments(idx, picked, boundaries, fps=FPS):
    """Resolve safe inward boundary hints against the acoustic index.

    `inOffset` is measured from the indexed IN and must move into a quiet lead-in;
    `outOffset` is measured from the indexed OUT and must land on a trough before the
    indexed OUT. Neither form can expand a source range or use a raw Whisper timestamp.
    """
    adjustments = []
    frame = 1.0 / float(fps)
    for beat in picked:
        rule = boundaries.get(beat["id"])
        if not rule:
            continue
        base_in = quantise(beat["src_in"], fps=fps)
        base_out = quantise(beat["src_out"], fps=fps)
        new_in, new_out = base_in, base_out
        resolved = {"src_in": base_in, "src_out": base_out}
        if "inOffset" in rule and abs(rule["inOffset"]) > 0.5 * frame:
            requested = quantise(base_in + rule["inOffset"], fps=fps)
            if requested >= base_out - MIN_BEAT:
                raise ValueError(f"beat {beat['id']} IN trim leaves less than {MIN_BEAT:.2f}s")
            if idx.at(requested) >= SOFT:
                raise ValueError(f"beat {beat['id']} IN trim is inside sound, not a safe lead-in")
            onset = idx.onset_after(requested)
            if onset is None:
                raise ValueError(f"beat {beat['id']} IN trim has no acoustic onset")
            new_in = quantise(onset - LEAD_FRAMES / float(fps), fps=fps)
            if new_in <= base_in + 0.5 * frame:
                raise ValueError(f"beat {beat['id']} IN trim does not move to a later acoustic boundary")
            if new_in >= base_out - MIN_BEAT:
                raise ValueError(f"beat {beat['id']} IN trim leaves less than {MIN_BEAT:.2f}s")
            resolved["src_in"] = new_in
            beat["_manual_min_src_in"] = new_in
            beat["_manual_in"] = True
        if "outOffset" in rule and abs(rule["outOffset"]) > 0.5 * frame:
            requested = quantise(base_out + rule["outOffset"], fps=fps)
            if requested <= base_in + MIN_BEAT:
                raise ValueError(f"beat {beat['id']} OUT trim leaves less than {MIN_BEAT:.2f}s")
            trough = _trough_before(idx, requested, base_in + MIN_BEAT, base_out)
            if trough is None:
                raise ValueError(f"beat {beat['id']} OUT trim has no acoustic trough")
            new_out = quantise(trough, fps=fps)
            if new_out >= base_out - 0.5 * frame:
                raise ValueError(f"beat {beat['id']} OUT trim does not move to an earlier acoustic trough")
            if idx.at(new_out) >= SOFT:
                raise ValueError(f"beat {beat['id']} OUT trim does not land in acoustic silence")
            if new_out <= new_in + MIN_BEAT:
                raise ValueError(f"beat {beat['id']} OUT trim leaves less than {MIN_BEAT:.2f}s")
            resolved["src_out"] = new_out
            beat["_manual_max_src_out"] = new_out
            beat["_manual_out"] = True
        beat["src_in"], beat["src_out"] = new_in, new_out
        adjustments.append({
            "beat": beat["id"],
            "offsets": dict(rule),
            "indexed": {"src_in": base_in, "src_out": base_out},
            "resolved": resolved,
        })
    return adjustments


def _quietest_between(idx, start, end):
    step = _number(getattr(idx, "bin", None))
    if step is None or step <= 0 or end < start:
        return None
    count = max(1, math.floor((end - start) / step) + 1)
    points = [min(end, start + index * step) for index in range(count)] + [end]
    return min(points, key=idx.at)


def _quiet_frame_between(idx, start, end, fps):
    first = math.ceil(float(start) * float(fps) - 1e-9)
    last = math.floor(float(end) * float(fps) + 1e-9)
    if last < first:
        return None
    points = [frame / float(fps) for frame in range(first, last + 1)]
    best = min(points, key=idx.at)
    return best if idx.at(best) < SOFT else None


def _recovery_words(data):
    words = []
    for raw in data.get("words") or []:
        start, end = _number(raw.get("start")), _number(raw.get("end"))
        text = str(raw.get("text") or raw.get("word") or "").strip()
        if start is not None and end is not None and end > start and text:
            words.append({"text": text, "start": start, "end": end,
                          "segment": raw.get("segment")})
    return sorted(words, key=lambda word: (word["start"], word["end"]))


def _refuse_recovery(beat_id, side, amount, reason):
    raise ValueError(f"beat {beat_id} {side.upper()} recovery requested {amount:.3f}s; refused: {reason}")


def _overlap_reason(beat, picked, indexed_beats, start, end, fps):
    tolerance = 0.5 / float(fps)
    for other in picked:
        if other["id"] == beat["id"]:
            continue
        if start < other["src_out"] - tolerance and end > other["src_in"] + tolerance:
            return f"candidate overlaps kept beat {other['id']}"
    for other in indexed_beats:
        if other.get("id") == beat["id"] or other.get("take") == beat.get("take"):
            continue
        if start < float(other.get("src_out", 0)) - tolerance \
                and end > float(other.get("src_in", 0)) + tolerance:
            return f"candidate enters take {other.get('take')} at beat {other.get('id')}"
    return None


def apply_outward_recoveries(idx, picked, recoveries, data, fps=FPS):
    """Apply opt-in word-evidenced expansion to a quiet acoustic boundary."""
    if not recoveries:
        return []
    words = _recovery_words(data)
    if not words:
        raise ValueError("outward recovery requires a v5 A-roll index with word-level evidence")
    source_end = _number(data.get("source_duration"))
    if source_end is None or source_end <= 0:
        raise ValueError("outward recovery requires a finite source duration")
    indexed_beats = data.get("beats") or []
    frame = 1.0 / float(fps)
    adjustments = []

    for beat in picked:
        rule = recoveries.get(beat["id"])
        if not rule:
            continue
        indexed = {"src_in": beat["src_in"], "src_out": beat["src_out"]}
        for side in ("in", "out"):
            if side not in rule:
                continue
            amount = rule[side]
            base_in, base_out = beat["src_in"], beat["src_out"]
            if side == "out":
                limit = quantise(base_out + amount, fps=fps)
                if limit > source_end + 0.5 * frame:
                    _refuse_recovery(beat["id"], side, amount, "candidate exceeds media EOF")
                limit = min(limit, source_end)
                candidates = [word for word in words
                              if word["end"] > base_out + 0.5 * frame
                              and word["end"] <= limit + 0.5 * frame]
                if not candidates:
                    _refuse_recovery(beat["id"], side, amount,
                                     "no complete word-level transcript evidence in the search window")
                continuous = []
                for word in candidates:
                    if not _continuous_source(idx, base_out, word["end"]):
                        break
                    continuous.append(word)
                if not continuous:
                    _refuse_recovery(beat["id"], side, amount,
                                     "candidate is separated by silence or dead air")
                chosen = None
                for index, word in enumerate(continuous):
                    upper = min(limit, continuous[index + 1]["start"] if index + 1 < len(continuous) else limit)
                    trough = _quiet_frame_between(idx, word["end"], upper, fps)
                    if trough is not None:
                        chosen = (index, trough)
                        break
                if chosen is None or chosen[1] <= base_out + 0.5 * frame:
                    _refuse_recovery(beat["id"], side, amount,
                                     "no quiet acoustic OUT boundary after the evidenced word")
                index, resolved = chosen
                evidence = continuous[:index + 1]
                if resolved + 0.5 * frame < max(word["end"] for word in evidence):
                    _refuse_recovery(beat["id"], side, amount, "resolved OUT would clip the protected last word")
                reason = _overlap_reason(beat, picked, indexed_beats, base_out, resolved, fps)
                if reason:
                    _refuse_recovery(beat["id"], side, amount, reason)
                beat["src_out"] = resolved
                beat["text"] = _merge_text((beat.get("text", ""), " ".join(w["text"] for w in evidence)))
                beat["last_word"], beat["last_word_end"] = evidence[-1]["text"], evidence[-1]["end"]
                beat["_manual_max_src_out"] = resolved
                beat["_manual_out"] = beat["_recovered_out"] = True
            else:
                limit = quantise(base_in - amount, fps=fps)
                if limit < -0.5 * frame:
                    _refuse_recovery(beat["id"], side, amount, "candidate precedes media start")
                limit = max(0.0, limit)
                candidates = [word for word in words
                              if word["start"] < base_in - 0.5 * frame
                              and word["start"] >= limit - 0.5 * frame
                              and word["end"] > limit]
                if not candidates:
                    _refuse_recovery(beat["id"], side, amount,
                                     "no complete word-level transcript evidence in the search window")
                evidence = []
                resolved = None
                for word in reversed(candidates):
                    evidence.insert(0, word)
                    lower = max(limit, word["start"] - 0.30)
                    onset = idx.onset_after(lower)
                    if onset is None or onset > word["start"] + 0.10:
                        continue
                    candidate = quantise(max(0.0, onset - LEAD_FRAMES / float(fps)), fps=fps)
                    if candidate < base_in - 0.5 * frame and _continuous_source(idx, onset, base_in):
                        resolved = candidate
                        break
                if resolved is None:
                    _refuse_recovery(beat["id"], side, amount,
                                     "candidate is separated by silence or has no acoustic onset")
                if resolved > min(word["start"] for word in evidence) + 0.5 * frame:
                    _refuse_recovery(beat["id"], side, amount, "resolved IN would clip the protected first word")
                reason = _overlap_reason(beat, picked, indexed_beats, resolved, base_in, fps)
                if reason:
                    _refuse_recovery(beat["id"], side, amount, reason)
                beat["src_in"] = resolved
                beat["text"] = _merge_text((" ".join(w["text"] for w in evidence), beat.get("text", "")))
                beat["first_word"], beat["first_word_start"] = evidence[0]["text"], evidence[0]["start"]
                beat["first_word_trustworthy"] = True
                beat["_manual_min_src_in"] = resolved
                beat["_manual_in"] = beat["_recovered_in"] = True

            adjustments.append({
                "beat": beat["id"], "side": side, "requested": amount,
                "indexed": indexed,
                "resolved": {"src_in": beat["src_in"], "src_out": beat["src_out"]},
                "evidence": [{"word": word["text"], "start": word["start"], "end": word["end"]}
                             for word in evidence],
            })
    return adjustments


def source_overlap_findings(picked, fps=FPS):
    """Check every source-neighbour pair, independent of requested timeline order."""
    tolerance = 0.5 / float(fps)
    ordered = sorted(picked, key=lambda beat: (beat["src_in"], beat["src_out"], beat["id"]))
    findings = []
    for left, right in pairwise(ordered):
        overlap = left["src_out"] - right["src_in"]
        if overlap > tolerance:
            findings.append(f"b{left['id']}->b{right['id']} OVERLAP {overlap:.3f}s of source is used twice")
    return findings


def _merge_text(parts):
    """Join overlapping transcript windows without repeating their shared word."""
    merged = []
    for text in parts:
        words = [word for word in (text or "").split() if word]
        overlap = 0
        for size in range(min(len(merged), len(words)), 0, -1):
            if [norm(word) for word in merged[-size:]] == [norm(word) for word in words[:size]]:
                overlap = size
                break
        merged.extend(words[overlap:])
    return " ".join(merged)


def _continuous_source(idx, start, end):
    """True only when no indexed sample between two ranges is hard silence."""
    step = _number(getattr(idx, "bin", None))
    if step is None or step <= 0 or end < start:
        return False
    samples = math.ceil((end - start) / step)
    return all(idx.at(min(end, start + sample * step)) >= SIL for sample in range(samples + 1))


def coalesce_continuous(idx, picked, boundaries=None):
    """Turn an evidenced cross-segment utterance into one native source clip."""
    for index, beat in enumerate(picked):
        previous = picked[index - 1]["id"] if index else None
        following = picked[index + 1]["id"] if index + 1 < len(picked) else None
        if beat.get("continuation_of") is not None and beat["continuation_of"] != previous \
                and not beat.get("_recovered_in"):
            raise ValueError(f"beat {beat['id']} starts with b{beat['continuation_of']}'s speech; "
                             f"keep b{beat['continuation_of']} immediately before it")
        if beat.get("continued_by") is not None and beat["continued_by"] != following \
                and not beat.get("_recovered_out"):
            raise ValueError(f"beat {beat['id']} ends inside b{beat['continued_by']}'s continuous speech; "
                             f"keep b{beat['continued_by']} immediately after it")
    clips = []
    for beat in picked:
        previous = None if beat.get("_recovered_in") else beat.get("continuation_of")
        if previous is None and beat.get("foreign_lead"):
            raise ValueError(f"beat {beat['id']} starts with unrepresented prior speech "
                             f"({beat['foreign_lead']!r})")
        if previous is not None:
            if not beat.get("foreign_lead"):
                raise ValueError(f"beat {beat['id']} names b{previous} without transcript evidence")
            if not clips or clips[-1]["beats"][-1] != previous:
                detail = beat.get("foreign_lead") or "prior speech"
                raise ValueError(f"beat {beat['id']} starts with b{previous}'s speech ({detail!r}); "
                                 f"keep b{previous} immediately before it")
            if "outOffset" in (boundaries or {}).get(previous, {}) \
                    or "inOffset" in (boundaries or {}).get(beat["id"], {}):
                raise ValueError(f"b{previous}->b{beat['id']} is one continuous source span; "
                                 "trim only its outer IN or OUT")
            clip = clips[-1]
            if not _continuous_source(idx, clip["src_out"], beat["src_in"]):
                raise ValueError(f"b{previous}->b{beat['id']} has no continuous acoustic source span")
            clip["beats"].append(beat["id"])
            clip["src_out"] = beat["src_out"]
            clip["text"] = _merge_text((clip["text"], beat.get("foreign_lead", ""), beat["text"]))
            for key in ("last_word", "last_word_end"):
                if key in beat:
                    clip[key] = beat[key]
            for key in ("_manual_max_src_out", "_manual_out"):
                if key in beat:
                    clip[key] = beat[key]
                else:
                    clip.pop(key, None)
            clip["continuity"].append({
                "from": previous,
                "into": beat["id"],
                "foreign_lead": beat.get("foreign_lead", ""),
            })
            continue
        clips.append({**beat, "beats": [beat["id"]], "continuity": []})
    return clips


def _shell_command(parts):
    return " ".join(shlex.quote(str(part)) for part in parts)


def repair(idx, picked, fps=FPS):
    """
    Apply the lint's own suggestions. These are mechanical — the trough and the onset are
    computed, not judged — so there is no reason to hand them back to a human.
    A boundary is only moved when it cannot collide with the neighbouring kept beat.
    """
    fixed = []
    # Boundary safety is a source-time property. The requested timeline may be reordered,
    # so using the previous/next item in `picked` as a source floor/ceiling would make a
    # perfectly valid reverse-order edit look overlapping or unrepairable.
    source_order = sorted(picked, key=lambda beat: (beat["src_in"], beat["src_out"], beat["id"]))
    source_position = {beat["id"]: index for index, beat in enumerate(source_order)}
    for b in picked:
        position = source_position[b["id"]]
        nxt = source_order[position + 1] if position + 1 < len(source_order) else None
        prev = source_order[position - 1] if position else None
        source_floor = prev["src_out"] if prev else 0.0
        max_out = b.get("_manual_max_src_out", float("inf"))

        # Use the same predicate as lint. A flat loud OUT is intentionally left as a
        # blocking finding; repair must never claim to have fixed a boundary it cannot move.
        loud = loud_out_finding(idx, b["src_out"], fps=fps)
        if loud:
            tr = quantise(loud["trough"], fps=fps)
            ceiling = min(nxt["src_in"] if nxt else b["src_out"] + 0.5, max_out)
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
                                              floor=source_floor,
                                              fps=fps)
                if protected is not None:
                    protected = max(protected, b.get("_manual_min_src_in", 0.0))
                if protected is not None and not b.get("_manual_in") and b["src_in"] > protected:
                    fixed.append(f"b{b['id']} IN {b['src_in']:.3f} -> {protected:.3f} "
                                 "(protects trusted first word)")
                    b["src_in"] = protected
                if protected is not None and b["src_in"] <= protected:
                    continue
            on = idx.onset_after(b["src_in"])
            if on is not None:
                new_in = quantise(max(source_floor,
                                      b.get("_manual_min_src_in", 0.0),
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
        display = list(cmd)
        display[display.index("--spec") + 1] = "<aroll-audio-ramps>"
        print("\n$ " + _shell_command(display))
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        output = getattr(result, "stdout", "") or ""
        if output:
            print(output, end="" if output.endswith("\n") else "\n")
        return result.returncode
    finally:
        if spec_path:
            Path(spec_path).unlink(missing_ok=True)


def cmd_cut(args):
    data = json.loads(Path(args.index).read_text())
    fps = authoritative_fps(data, getattr(args, "fps", None))
    stored_token = data.get("source_token", data.get("media_token"))
    current_token = None
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

    try:
        decisions = resolve_editorial_decisions(data, args)
        if getattr(args, "review", None) and current_token is None:
            # The review token is meaningful only for an index produced by the current
            # cache contract. Do not let an old token-less index masquerade as reviewed.
            raise ValueError("review requires an A-roll index with a source_token")
    except (OSError, TypeError, ValueError) as error:
        print(f"A-roll decision rejected: {error}", file=sys.stderr)
        return 2

    beats = {b["id"]: b for b in data["beats"]}
    keep = decisions["kept"]
    order = decisions["order"]

    idx = AudioIndex.build_or_load(data["media"])
    picked = [dict(beats[i]) for i in order]
    # An index may have been produced at the default rate and later handed to a project
    # with a different FPS. Make the supplied/project rate authoritative before linting or
    # emitting any source boundary; otherwise core would validate a 30fps-looking plan for
    # a 24fps or 29.97fps timeline.
    for beat in picked:
        beat["src_in"] = quantise(beat["src_in"], fps=fps)
        beat["src_out"] = quantise(beat["src_out"], fps=fps)

    try:
        adjustments = apply_boundary_adjustments(idx, picked, decisions["boundaries"], fps=fps)
        recoveries = apply_outward_recoveries(
            idx, picked, decisions["recoveries"], data, fps=fps,
        )
    except (TypeError, ValueError) as error:
        print(f"A-roll boundary decision rejected: {error}", file=sys.stderr)
        return 2

    for p in picked:
        if p["src_out"] - p["src_in"] < MIN_BEAT:
            print(f"A-roll boundary decision rejected: beat {p['id']} is shorter than {MIN_BEAT:.2f}s",
                  file=sys.stderr)
            return 2

    try:
        clips = coalesce_continuous(idx, picked, decisions["boundaries"])
    except ValueError as error:
        print(f"A-roll boundary decision rejected: {error}", file=sys.stderr)
        return 2
    repairs = [] if getattr(args, "no_repair", False) else repair(idx, clips, fps=fps)

    spans = [(f"b{clip['id']}", clip["src_in"], clip["src_out"]) for clip in clips]
    first_words = [
        {
            "start": clip.get("first_word_start"),
            "word": clip.get("first_word", ""),
            "trustworthy": bool(clip.get("first_word_trustworthy")),
        }
        for clip in clips
    ]
    findings = lint(idx, spans, fps=fps, first_word_starts=first_words)
    overlap_findings = source_overlap_findings(clips, fps=fps)
    findings.extend(overlap_findings)

    # pack the timeline with no gaps — this is the dead-space removal
    timeline, cursor = [], 0.0
    for clip in clips:
        dur = quantise(clip["src_out"] - clip["src_in"], fps=fps)
        tl_in = quantise(cursor, fps=fps)
        tl_out = quantise(tl_in + dur, fps=fps)
        timeline.append({"beat": clip["id"], "beats": clip["beats"],
                         "tl_in": round(tl_in, 6), "tl_out": round(tl_out, 6),
                         "src_in": round(clip["src_in"], 6), "src_out": round(clip["src_out"], 6),
                         "src_dur": round(dur, 6), "dur": round(dur, 6),
                         "text": clip["text"],
                         **({"continuity": clip["continuity"]} if clip["continuity"] else {})})
        cursor = tl_out

    timeline = add_audio_ramps(timeline, fps=fps)
    destination = getattr(args, "into", None) or getattr(args, "project", None)
    handoff_mode = "into" if getattr(args, "into", None) else ("new" if args.project else "plan")
    blocking_findings = [f for f in findings if "FIRST_WORD_CLIPPED" in f]

    scenes = ",".join(f"{t['tl_in']:.6f}:{t['tl_out']:.6f}@{t['src_in']:.6f}" for t in timeline)
    editorial = {
        "kept": keep,
        "order": order,
        "boundaries": decisions["boundaries"],
        "recoveries": decisions["recoveries"],
    }
    if decisions["review"]:
        editorial["reviewFile"] = decisions["review"]["path"]
    plan = {"media": data["media"], "fps": fps,
            **({"source_token": stored_token, "sourceToken": stored_token} if stored_token is not None else {}),
            "fps_contract": {"fps": fps, "quantized": True, "authority": "input"},
            "kept": keep, "order": order, "editorial": editorial,
            "adjustments": adjustments, "recoveries": recoveries,
            "repairs": repairs,
            "timeline": timeline,
            "duration": round(cursor, 6), "lint": findings, "blocking_lint": blocking_findings,
            "scenes": scenes, "handoff": cut_handoff(destination, timeline, mode=handoff_mode, fps=fps)}
    plan_path = getattr(args, "plan", None) or args.index.replace(".aroll.json", ".plan.json")
    Path(plan_path).write_text(json.dumps(plan, ensure_ascii=False, indent=1))

    print(f"kept {len(keep)} beats -> {cursor:.2f}s (source {data['source_duration']:.1f}s)")
    print("order: " + ",".join(str(beat_id) for beat_id in order))
    if adjustments:
        print("\nboundary adjustments:")
        for adjustment in adjustments:
            offsets = ", ".join(
                f"{key}={value:+.6f}s" for key, value in sorted(adjustment["offsets"].items())
            )
            indexed = adjustment["indexed"]
            resolved = adjustment["resolved"]
            print(f"  b{adjustment['beat']}: {offsets}; "
                  f"indexed {indexed['src_in']:.6f}->{indexed['src_out']:.6f}; "
                  f"resolved {resolved['src_in']:.6f}->{resolved['src_out']:.6f}")
    else:
        print("\nboundary adjustments: none")
    if recoveries:
        print("\noutward recoveries:")
        for recovery in recoveries:
            resolved = recovery["resolved"]
            evidence = " ".join(word["word"] for word in recovery["evidence"])
            print(f"  b{recovery['beat']} {recovery['side'].upper()} requested "
                  f"{recovery['requested']:.6f}s; resolved "
                  f"{resolved['src_in']:.6f}->{resolved['src_out']:.6f}; "
                  f"word evidence: {evidence}")
    else:
        print("\noutward recoveries: none")
    print("\nrepairs:")
    if getattr(args, "no_repair", False):
        print("  disabled (--no-repair)")
    elif repairs:
        for repair_note in repairs:
            print("  " + ("note: " if " remains blocking " in repair_note else "fixed: ") + repair_note)
    else:
        print("  none")
    for t in timeline:
        # never slice the text: [:46] cut Arabic mid-word, and this is the table he actually
        # reads back after choosing beats. Text is the last field, so the numbers still line up.
        label = "+".join(f"b{beat}" for beat in t["beats"])
        print(f"  {label:<7} {t['tl_in']:>9.6f}->{t['tl_out']:>9.6f}  "
              f"src {t['src_in']:>9.6f}->{t['src_out']:>9.6f}  "
              f"dur {t['dur']:>8.6f}  {t['text']}")
        if t.get("continuity"):
            evidence = ", ".join(
                f"b{item['from']}→b{item['into']}: {item['foreign_lead']}" for item in t["continuity"]
            )
            print(f"          coalesced continuous source ({evidence})")
    print(f"\nseam lint: {'CLEAN' if not findings else str(len(findings)) + ' findings'}")
    for f in findings:
        print("  ! " + f)
    print(f"wrote {plan_path}")

    if destination:
        # First-word clipping is a safety failure, not a subjective seam warning. Keep
        # `--force` useful for exploratory acoustic overrides, but never let it build a
        # cut that is known to remove the start of a trusted Arabic word.
        if blocking_findings:
            print("\nrefusing to build with first-word clipping findings", flush=True)
            return 1
        if overlap_findings:
            print("\nrefusing to build with overlapping source ranges", flush=True)
            return 1
        if findings and not getattr(args, "force", False):
            print("\nrefusing to build with unresolved seam findings; re-run with --force to override",
                  flush=True)
            return 1
        if getattr(args, "project", None):
            cmd = ["capcutctl", "new", "--project", args.project,
                   "--media", data["media"], "--scenes", scenes]
            if getattr(args, "dry_run", False):
                cmd.append("--dry-run")
            print("\n$ " + _shell_command(cmd))
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            output = getattr(result, "stdout", "") or ""
            if output:
                print(output, end="" if output.endswith("\n") else "\n")
            if result.returncode:
                return result.returncode
            # `new` creates the editable 1x content track; apply all fades in one follow-up
            # transaction so root and active-timeline mirrors receive the same extras.
            if getattr(args, "dry_run", False):
                return 0
            return apply_audio_ramps(args.project, timeline, track="content", fps=fps)
        return apply_audio_ramps(args.into, timeline, dry_run=getattr(args, "dry_run", False), track="content", fps=fps)
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
    ap.add_argument("--order", help="final beat order; must be an exact permutation of kept ids")
    ap.add_argument("--trim-beat", dest="trim_beat", action="append",
                    help="safe inward trim, ID:in=SECONDS or ID:out=SECONDS; repeatable")
    ap.add_argument("--recover-beat", dest="recover_beat", action="append",
                    help="reviewed outward recovery window, ID:in=SECONDS or ID:out=SECONDS; repeatable")
    ap.add_argument("--review", help="v1 JSON decision file with sourceToken, keep/order, boundaries, and recoveries")
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

    def editorial_requested():
        return any((args.keep, args.drop, args.order, args.trim_beat,
                    args.recover_beat, args.review, args.project, args.into))

    # index once, reuse thereafter — the expensive half never runs twice
    if args.reindex or not os.path.exists(args.index) or not index_is_current(args.index, media):
        cmd_index(args)
        if not editorial_requested():
            sys.exit(0)
        print()
    elif not editorial_requested():
        print_handout(json.loads(Path(args.index).read_text()), args.index)
        sys.exit(0)

    args.plan = None
    sys.exit(cmd_cut(args))


if __name__ == "__main__":
    main()
