#!/usr/bin/env python3
"""
Audio energy index — the acoustic half of the source index.

Whisper says WHERE WORDS ARE (semantic, and its word starts are contiguous-filled so they
lie).  This says WHERE SOUND ACTUALLY IS (acoustic, sample-accurate).  Cut points must satisfy
BOTH.  Every seam defect so far came from trusting Whisper alone.

Build once, cache, then lint every cut plan before rendering.

    idx = AudioIndex.build_or_load("cam.wav")          # ~1s for 4 min, cached after
    print(idx.strip(13.0, 14.0))                       # eyeball a seam
    for f in lint(idx, spans): print(f)                # machine-check the whole plan
"""
import contextlib
import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

SPEECH, SOFT, SIL = -28.0, -45.0, -55.0     # dB thresholds, tuned on this user's cam audio
# Seam dead air (see lint): incoming-side silence, and tail + head together. SOFT and these two
# are mirrored in src/stress.mjs (SOFT_DB, SEAM_HEAD_MAX_S, SEAM_TOTAL_MAX_S) for the gate's
# draft-level seam-silence check; change them together.
SEAM_HEAD_MAX_S, SEAM_TOTAL_MAX_S = 0.30, 0.45
FIRST_WORD_CLIP_TOLERANCE_FRAMES = 0.5
SOURCE_SAMPLE_BYTES = 64 * 1024
ENERGY_INDEX_VERSION = 2


def _content_hash(media, stat_result=None, sample_bytes=SOURCE_SAMPLE_BYTES):
    """Hash enough stable bytes to catch fast same-size overwrites without reading a video twice."""
    st = stat_result or os.stat(media)
    size = int(st.st_size)
    if size <= sample_bytes:
        offsets = [0]
    else:
        offsets = sorted({
            0,
            max(0, size // 4 - sample_bytes // 2),
            max(0, size // 2 - sample_bytes // 2),
            max(0, (size * 3) // 4 - sample_bytes // 2),
            max(0, size - sample_bytes),
        })
    digest = hashlib.blake2b(digest_size=20)
    digest.update(struct.pack("<Q", size))
    with open(media, "rb") as handle:
        for offset in offsets:
            handle.seek(offset)
            chunk = handle.read(min(sample_bytes, max(0, size - offset)))
            digest.update(struct.pack("<QQ", offset, len(chunk)))
            digest.update(chunk)
    return digest.hexdigest()


def source_token(media):
    """Return a cache identity that survives same-path, same-size, same-second replacement."""
    st = os.stat(media)
    mtime_ns = int(getattr(st, "st_mtime_ns", round(st.st_mtime * 1_000_000_000)))
    content_hash = _content_hash(media, st)
    return {
        "ino": int(st.st_ino),
        "inode": int(st.st_ino),
        "size": int(st.st_size),
        "mtime_ns": mtime_ns,
        "content_hash": content_hash,
        # Keep a plainly named alias for cache readers written against the field-report
        # vocabulary. Both values are derived from the same digest.
        "fingerprint": content_hash,
    }


def _token_hash(token):
    if not isinstance(token, dict):
        return None
    value = token.get("content_hash", token.get("fingerprint"))
    return value if isinstance(value, str) and value else None


def _token_int(token, *keys):
    for key in keys:
        value = token.get(key)
        if isinstance(value, bool):
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def same_source(stored, current):
    """Whether a cache stamped with `stored` describes the media whose token is `current`.

    Always: the same size and the same content hash. On the same inode (the file itself) the
    mtime_ns must match too: the content hash only samples five 64 KiB windows, so a same-size
    rewrite in place (a re-rendered stem with a muted or ducked stretch) can keep it, and the
    mtime is what catches that. src/video-index.mjs applies the same rule. A different inode
    is a copy or a relink (a project's `Downloads__take.mp4`), which carries no mtime of its
    own; the bytes are its evidence.
    """
    if not isinstance(stored, dict) or not isinstance(current, dict):
        return False
    digest = _token_hash(stored)
    if digest is None or digest != _token_hash(current):
        return False
    try:
        if int(stored.get("size")) != int(current.get("size")):
            return False
    except (TypeError, ValueError):
        return False
    stored_ino, current_ino = _token_int(stored, "ino", "inode"), _token_int(current, "ino", "inode")
    if stored_ino is not None and stored_ino == current_ino:
        stored_mtime, current_mtime = _token_int(stored, "mtime_ns"), _token_int(current, "mtime_ns")
        if stored_mtime is not None and stored_mtime != current_mtime:
            return False
    return True


def source_key(token):
    """The short content key in a cache file name: `<stem>.<kind>.<key>.json`.

    Two takes both named screen.mp4 get two files instead of overwriting one, and a copy of a
    take finds the original's file by this key without reading any JSON.
    """
    digest = _token_hash(token)
    if digest is None:
        raise ValueError("source token has no content hash")
    return digest[:16]


def _write_json_atomic(path, value):
    """Publish a cache record only after its complete JSON has been written."""
    parent = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".audio-index-", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)


class AudioIndex:
    def __init__(self, db, bin_s, path="", token=None):
        self.db, self.bin, self.path, self.token = db, bin_s, path, token

    # ---------- build / cache ----------
    @staticmethod
    def from_wav(wav, bin_ms=10):
        if not math.isfinite(bin_ms) or bin_ms <= 0:
            raise ValueError("energy bin size must be finite and positive")
        with wave.open(os.fspath(wav)) as w:
            sr, nch = w.getframerate(), w.getnchannels()
            width = w.getsampwidth()
            raw = w.readframes(w.getnframes())
        if not raw:
            raise ValueError("audio contains no samples")
        if len(raw) % (width * nch):
            raise ValueError("audio ends with an incomplete PCM frame")
        if width == 3:
            s = [int.from_bytes(raw[i:i+3], "little", signed=True) for i in range(0, len(raw), 3)]
        else:
            s = struct.unpack(f"<{len(raw) // width}{ {1: 'B', 2: 'h', 4: 'i'}[width]}", raw)
            if width == 1: s = [sample - 128 for sample in s]
        frames = max(1, round(bin_ms / 1000 * sr))
        n = frames * nch; out = []
        peak = 2 ** (width * 8 - 1)
        # Include every channel and the final partial bin so trailing speech remains visible.
        for i in range(0, len(s), n):
            ch = s[i:i+n]
            out.append(round(20*math.log10(math.sqrt(sum(x*x for x in ch)/len(ch))/peak + 1e-9), 1))
        return AudioIndex(out, frames / sr, wav)

    @staticmethod
    def _token(media):
        return source_token(media)

    @staticmethod
    def build_or_load(media, bin_ms=10, cache_dir="~/Downloads/.video-index", force=False):
        media = os.path.abspath(os.fspath(media))
        cd = os.path.abspath(os.path.expanduser(cache_dir))
        os.makedirs(cd, exist_ok=True)
        stem = os.path.basename(media).rsplit(".", 1)[0]
        token = AudioIndex._token(media)
        # `<stem>.energy10.<key>.json`: the kind marker stays right after the stem so the
        # `${stem}.energy10` prefix readers in src/video-index.mjs still match. The legacy
        # `<stem>.energy10.json` is read when its token matches and is never overwritten:
        # it may belong to another take of the same name.
        key = os.path.join(cd, stem + f".energy{bin_ms}.{source_key(token)}.json")
        legacy = os.path.join(cd, stem + f".energy{bin_ms}.json")
        for candidate in ([] if force else [key, legacy]):
            if not os.path.exists(candidate):
                continue
            try:
                d = json.loads(Path(candidate).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, TypeError):
                d = None
            if (isinstance(d, dict) and d.get("version") == ENERGY_INDEX_VERSION and same_source(d.get("token"), token)
                    and isinstance(d.get("db"), list) and d["db"]
                    and all(isinstance(value, (int, float)) and math.isfinite(value) for value in d["db"])
                    and isinstance(d.get("bin"), (int, float)) and math.isfinite(d["bin"]) and d["bin"] > 0):
                if candidate != key or d.get("token") != token:
                    # A legacy unkeyed file (or a keyed one stamped by a copy): write the keyed
                    # file with the current token. The legacy file is left alone.
                    _write_json_atomic(key, {**d, "token": token})
                return AudioIndex(d["db"], d["bin"], media, token=token)

        wav = media
        derived = None
        temp_dir = None
        if not media.lower().endswith(".wav"):
            derived = os.path.join(cd, stem + ".16k.wav")
            # A stale shared WAV is never used for a cache miss. Generate privately, read
            # that exact file, and publish it only after the index has been built.
            temp_dir = tempfile.mkdtemp(prefix=".audio-index-", dir=cd)
            wav = os.path.join(temp_dir, stem + ".16k.wav")
            try:
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", media, "-vn", "-ac", "1",
                                "-ar", "16000", "-c:a", "pcm_s16le", wav], check=True)
                if not os.path.isfile(wav):
                    raise RuntimeError(f"ffmpeg did not create the derived audio file: {wav}")
                idx = AudioIndex.from_wav(wav, bin_ms)
                os.replace(wav, derived)
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)
        else:
            idx = AudioIndex.from_wav(wav, bin_ms)

        idx.path = media
        idx.token = token
        if not same_source(token, source_token(media)):
            raise RuntimeError("media changed while its energy index was being built; rerun indexing")
        _write_json_atomic(key, {"version": ENERGY_INDEX_VERSION, "bin": idx.bin, "db": idx.db, "token": token})
        return idx

    # ---------- queries ----------
    def at(self, t):
        i = math.floor(t/self.bin)
        return self.db[i] if 0 <= i < len(self.db) else -99.0

    def rising(self, t, span=0.10):
        """True if level climbs over the next `span` — the signature of cutting into a word."""
        return self.at(t+span) - self.at(t) > 6.0

    def head_silence(self, t, thresh=SOFT, cap=2.0):
        """Seconds of silence starting AT t (dead air you just stitched in)."""
        n = 0
        while n*self.bin < cap and self.at(t + n*self.bin) < thresh: n += 1
        return n*self.bin

    def tail_silence(self, t, thresh=SOFT, cap=2.0):
        """Seconds of silence ending AT t."""
        n = 0
        while n*self.bin < cap and self.at(t - (n+1)*self.bin) < thresh: n += 1
        return n*self.bin

    def onset_after(self, t, thresh=SOFT, cap=3.0):
        """Next moment real sound starts. The only safe place to put an IN point."""
        n = 0
        while n*self.bin < cap:
            if self.at(t + n*self.bin) >= thresh: return t + n*self.bin
            n += 1
        return None

    def trough(self, t, win=0.20):
        """Quietest instant within +/- win — the safe place to put an OUT point."""
        lo, best = 1e9, t
        n = int(win/self.bin)
        for i in range(-n, n+1):
            tt = t + i*self.bin
            sample = math.floor(tt / self.bin)
            if sample < 0 or sample >= len(self.db):
                continue
            v = self.at(tt)
            if v < lo: lo, best = v, tt
        return best

    def strip(self, a, b, bin_s=0.05, marks=()):
        """ASCII energy strip.  # speech   o soft   . silence   | mark"""
        out, t = [], a
        mk = {round(m/bin_s) for m in marks}
        i = 0
        while t < b:
            out.append('|' if i in mk else
                       ('#' if self.at(t) > SPEECH else ('o' if self.at(t) > SOFT else '.')))
            t += bin_s; i += 1
        return "".join(out)


def snap_word_starts(idx, words, max_lead=0.7, min_gap=0.05, lead=1/30, min_dur=0.08):
    """Move Whisper word starts that sit in silence to just before the sound begins.

    Whisper stretches a word's start back into the pause before it, so a one-word caption
    shows before the word is said. When at least ``min_gap`` of silence follows a start and
    sound begins within ``max_lead``, the start moves to ``onset - lead`` (never earlier than
    it was, never closer than ``min_dur`` to the word's end). The original start is kept as
    ``start_whisper``. Mutates ``words`` in place and returns how many moved.
    """
    moved = 0
    for word in words:
        try:
            start, end = float(word["start"]), float(word["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(end)) or end <= start:
            continue
        if idx.at(start) >= SOFT or idx.head_silence(start, cap=max_lead) < min_gap:
            continue
        onset = idx.onset_after(start, cap=max_lead)
        if onset is None:
            continue
        snapped = max(start, onset - lead)
        if snapped <= start + 1e-9 or snapped > end - min_dur:
            continue
        word.setdefault("start_whisper", start)
        word["start"] = round(snapped, 3)
        moved += 1
    return moved


def _span_fields(span):
    """Accept the original triples plus dict/metadata-rich spans from the A-roll builder."""
    if isinstance(span, dict):
        return span.get("label", span.get("id", "?")), span.get("src_in"), span.get("src_out"), span
    if len(span) < 3:
        raise ValueError(f"a lint span needs label, in, out: {span!r}")
    return span[0], span[1], span[2], span[3] if len(span) > 3 else None


def _word_meta(first_word_starts, index, label, span_meta):
    """Resolve first-word metadata from a list, label map, or an enriched span."""
    value = None
    if first_word_starts is not None:
        if isinstance(first_word_starts, dict):
            value = first_word_starts.get(label, first_word_starts.get(index))
        else:
            try:
                value = first_word_starts[index]
            except (IndexError, KeyError, TypeError):
                value = None
    if value is None and isinstance(span_meta, dict) and "first_word_start" in span_meta:
        value = {
            "start": span_meta.get("first_word_start"),
            "word": span_meta.get("first_word", ""),
            "trustworthy": span_meta.get("first_word_trustworthy", True),
        }
    if isinstance(value, (int, float)):
        return {"start": value, "word": "", "trustworthy": True}
    if isinstance(value, dict):
        start = value.get("start", value.get("word_start"))
        return {
            "start": start,
            "word": value.get("word", value.get("text", "")),
            "trustworthy": value.get("trustworthy", value.get("word_start_trustworthy", True)),
        }
    return None


def first_word_clipped(src_in, word_start, trustworthy=True, fps=30.0,
                       tolerance_frames=FIRST_WORD_CLIP_TOLERANCE_FRAMES):
    """Whether a trusted word begins materially before the generated source IN."""
    try:
        src_in, word_start, fps = float(src_in), float(word_start), float(fps)
    except (TypeError, ValueError):
        return False
    if not all(math.isfinite(value) for value in (src_in, word_start, fps)) or fps <= 0:
        return False
    return bool(trustworthy) and src_in > word_start + tolerance_frames / fps


def loud_out_finding(idx, boundary, fps=30.0, loud_threshold=SOFT, min_drop_db=6.0):
    """Describe a loud OUT with the same repairability decision used by lint and repair."""
    try:
        boundary, fps = float(boundary), float(fps)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(boundary) or not math.isfinite(fps) or fps <= 0:
        return None
    level = idx.at(boundary)
    if level < loud_threshold:
        return None
    trough = idx.trough(boundary)
    trough_level = idx.at(trough)
    repairable = (abs(trough - boundary) > 1.5 / fps
                  and trough_level < loud_threshold
                  and trough_level < level - min_drop_db)
    return {
        "boundary": boundary,
        "level": level,
        "trough": trough,
        "trough_level": trough_level,
        "repairable": repairable,
        "rising": bool(idx.rising(boundary)),
    }


def lint(idx, spans, fps=30.0, first_word_starts=None, loud_threshold=SOFT):
    """
    spans: [(label, src_in, src_out), ...] in source seconds, timeline order.
    Returns findings; empty == clean.

    Seam placement remains acoustic by default -- Whisper's segment starts are contiguous-filled
    and were the original source of the error. The optional first_word_starts argument is only
    for an independently trusted first-word edge; untrusted metadata is ignored.

    Thresholds calibrated on a real cut the user declared flawless, with the one seam he
    caught by ear as the negative control:

        8 good seams   head_silence <= 0.28s,  tail+head <= 0.39s
        the bad seam   head_silence  = 0.35s,  tail = 0.00  (all the hole on one side)

    The margin is thin (0.28 vs 0.35). Treat findings as CANDIDATES to listen to, never as
    proof -- and treat silence with no finding as unproven, not as verified.
    """
    f, frame = [], 1.0/fps
    for i, raw_span in enumerate(spans):
        lbl, a, b, span_meta = _span_fields(raw_span)
        word = _word_meta(first_word_starts, i, lbl, span_meta)
        if word and first_word_clipped(a, word.get("start"), word.get("trustworthy", True), fps=fps):
            shown = str(word.get("word") or "first word").strip()
            f.append(f"{lbl} IN FIRST_WORD_CLIPPED  {a:.3f} starts "
                     f"{a - float(word['start']):.3f}s after trusted {shown!r} at {float(word['start']):.3f}")
        # --- IN inside sound: a later clip that starts loud, with no quiet frame before it,
        # was cut mid-word (a recovery or snap that landed inside continuous speech). The
        # first clip is exempt: the video starting on speech is not a splice.
        if i > 0 and idx.at(a) >= loud_threshold and idx.tail_silence(a) < frame:
            f.append(f"{lbl} IN LOUD_BOUNDARY  {a:.3f}  boundary is loud ({idx.at(a):.0f}dB) "
                     f"with no quiet frame before it; this IN cuts into a word")
        # --- first clip: a lead-in is desirable, only an excessive one is a fault
        if i == 0 and idx.head_silence(a) > 0.60:
            f.append(f"{lbl} IN  {a:.3f}  {idx.head_silence(a):.2f}s before the video starts")
        # --- OUT: lint and repair share this exact loud/repairable predicate.
        loud = loud_out_finding(idx, b, fps=fps, loud_threshold=loud_threshold)
        if loud:
            if loud["repairable"]:
                detail = (f"boundary is loud ({loud['level']:.0f}dB); move OUT into trough at "
                          f"{loud['trough']:.3f} ({loud['trough_level']:.0f}dB)")
            else:
                detail = (f"blocking loud boundary ({loud['level']:.0f}dB) has no safe trough "
                          f"within the repair window")
            f.append(f"{lbl} OUT LOUD_BOUNDARY  {b:.3f}  {detail}")
        # --- the seam itself
        if i+1 < len(spans):
            nl, na, _, _ = _span_fields(spans[i+1])
            tail, head = idx.tail_silence(b), idx.head_silence(na)
            if head > SEAM_HEAD_MAX_S:
                on = idx.onset_after(na)
                if on is None:
                    f.append(f"{lbl}->{nl} SEAM  {head:.2f}s dead air on the incoming side "
                             f"(tail {tail:.2f}s) -> no onset in 3s")
                else:
                    f.append(f"{lbl}->{nl} SEAM  {head:.2f}s dead air on the incoming side "
                             f"(tail {tail:.2f}s) -> move {nl} IN to {on-2*frame:.3f}")
            elif tail + head > SEAM_TOTAL_MAX_S:
                f.append(f"{lbl}->{nl} SEAM  {tail+head:.2f}s total stitched pause "
                         f"(tail {tail:.2f} + head {head:.2f})")
    return f


if __name__ == "__main__":
    import sys
    idx = AudioIndex.build_or_load(sys.argv[1])
    print(f"{len(idx.db)} bins @ {int(idx.bin*1000)}ms = {len(idx.db)*idx.bin:.1f}s")
    if len(sys.argv) > 3:
        a, b = float(sys.argv[2]), float(sys.argv[3])
        print(f"{a:.2f}s {idx.strip(a,b)} {b:.2f}s")
