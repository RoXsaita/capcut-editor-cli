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
FIRST_WORD_CLIP_TOLERANCE_FRAMES = 0.5
SOURCE_SAMPLE_BYTES = 64 * 1024


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
        with wave.open(wav) as w:
            sr, nch = w.getframerate(), w.getnchannels()
            s = struct.unpack(f"<{w.getnframes()}h", w.readframes(w.getnframes()))
        if nch > 1: s = s[::nch]
        n = int(bin_ms/1000*sr); out = []
        for i in range(0, len(s)-n, n):
            ch = s[i:i+n]
            out.append(round(20*math.log10(math.sqrt(sum(x*x for x in ch)/len(ch))/32768 + 1e-9), 1))
        return AudioIndex(out, bin_ms/1000, wav)

    @staticmethod
    def _token(media):
        return source_token(media)

    @staticmethod
    def build_or_load(media, bin_ms=10, cache_dir="~/Downloads/.video-index", force=False):
        media = os.path.abspath(os.fspath(media))
        cd = os.path.abspath(os.path.expanduser(cache_dir))
        os.makedirs(cd, exist_ok=True)
        stem = os.path.basename(media).rsplit(".", 1)[0]
        key = os.path.join(cd, stem + f".energy{bin_ms}.json")
        token = AudioIndex._token(media)
        if not force and os.path.exists(key):
            try:
                d = json.loads(Path(key).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, TypeError):
                d = None
            if (isinstance(d, dict) and d.get("token") == token
                    and isinstance(d.get("db"), list) and d.get("bin") is not None):
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
        _write_json_atomic(key, {"bin": idx.bin, "db": idx.db, "token": token})
        return idx

    # ---------- queries ----------
    def at(self, t):
        i = int(t/self.bin)
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
            sample = int(tt / self.bin)
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
            if head > 0.30:
                on = idx.onset_after(na)
                if on is None:
                    f.append(f"{lbl}->{nl} SEAM  {head:.2f}s dead air on the incoming side "
                             f"(tail {tail:.2f}s) -> no onset in 3s")
                else:
                    f.append(f"{lbl}->{nl} SEAM  {head:.2f}s dead air on the incoming side "
                             f"(tail {tail:.2f}s) -> move {nl} IN to {on-2*frame:.3f}")
            elif tail + head > 0.45:
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
