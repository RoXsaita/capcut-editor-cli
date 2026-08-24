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
import wave, struct, math, json, os, subprocess

SPEECH, SOFT, SIL = -28.0, -45.0, -55.0     # dB thresholds, tuned on this user's cam audio


class AudioIndex:
    def __init__(self, db, bin_s, path=""):
        self.db, self.bin, self.path = db, bin_s, path

    # ---------- build / cache ----------
    @staticmethod
    def from_wav(wav, bin_ms=10):
        w = wave.open(wav)
        sr, nch = w.getframerate(), w.getnchannels()
        s = struct.unpack("<%dh" % w.getnframes(), w.readframes(w.getnframes()))
        if nch > 1: s = s[::nch]
        n = int(bin_ms/1000*sr); out = []
        for i in range(0, len(s)-n, n):
            ch = s[i:i+n]
            out.append(round(20*math.log10(math.sqrt(sum(x*x for x in ch)/len(ch))/32768 + 1e-9), 1))
        return AudioIndex(out, bin_ms/1000, wav)

    @staticmethod
    def build_or_load(media, bin_ms=10, cache_dir="~/Downloads/.video-index"):
        cd = os.path.expanduser(cache_dir); os.makedirs(cd, exist_ok=True)
        key = os.path.join(cd, os.path.basename(media).rsplit(".",1)[0] + f".energy{bin_ms}.json")
        if os.path.exists(key):
            d = json.load(open(key)); return AudioIndex(d["db"], d["bin"], media)
        wav = media
        if not media.lower().endswith(".wav"):
            wav = os.path.join(cd, os.path.basename(media).rsplit(".",1)[0] + ".16k.wav")
            if not os.path.exists(wav):
                subprocess.run(["ffmpeg","-v","error","-y","-i",media,"-vn","-ac","1",
                                "-ar","16000","-c:a","pcm_s16le",wav], check=True)
        idx = AudioIndex.from_wav(wav, bin_ms)
        json.dump({"bin": idx.bin, "db": idx.db}, open(key,"w"))
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
            tt = t + i*self.bin; v = self.at(tt)
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


def lint(idx, spans, fps=30.0):
    """
    spans: [(label, src_in, src_out), ...] in source seconds, timeline order.
    Returns findings; empty == clean.

    PURELY ACOUSTIC -- deliberately does not consult Whisper. Whisper's segment starts are
    contiguous-filled and were the original source of the error; gating on them re-imports
    the same lie (a broken seam sat 0.27s from a "sentence start" and got excused).

    Thresholds calibrated on a real cut the user declared flawless, with the one seam he
    caught by ear as the negative control:

        8 good seams   head_silence <= 0.28s,  tail+head <= 0.39s
        the bad seam   head_silence  = 0.35s,  tail = 0.00  (all the hole on one side)

    The margin is thin (0.28 vs 0.35). Treat findings as CANDIDATES to listen to, never as
    proof -- and treat silence with no finding as unproven, not as verified.
    """
    f, frame = [], 1.0/fps
    for i, (lbl, a, b) in enumerate(spans):
        # --- first clip: a lead-in is desirable, only an excessive one is a fault
        if i == 0 and idx.head_silence(a) > 0.60:
            f.append(f"{lbl} IN  {a:.3f}  {idx.head_silence(a):.2f}s before the video starts")
        # --- OUT: cutting an envelope that is still climbing, when a real trough is nearby
        if idx.at(b) > SOFT and idx.rising(b):
            tr = idx.trough(b)
            if abs(tr-b) > 1.5*frame and idx.at(tr) < idx.at(b) - 6.0:
                f.append(f"{lbl} OUT {b:.3f}  cuts a rising envelope ({idx.at(b):.0f}dB) "
                         f"-> trough at {tr:.3f} ({idx.at(tr):.0f}dB)")
        # --- the seam itself
        if i+1 < len(spans):
            nl, na, _ = spans[i+1]
            tail, head = idx.tail_silence(b), idx.head_silence(na)
            if head > 0.30:
                on = idx.onset_after(na)
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
