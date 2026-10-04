"""Text, captions, faces and speech for the X-ray (phase 3).

Reads text and faces with macOS Vision (tools/vision/frames.swift, compiled once into the
user cache), on a sweep of exact frames plus the middle of every authored text segment.
Each frame is read twice, Latin-first and Arabic-first, because Vision only reads a script
well when it leads the language list; the better line wins per box.

A caption is text the draft authored (matched by content while it is on screen) or, with no
draft, horizontal text inside the profile's caption bands. Everything else is screen text.
Every number here is measured on the export unless it says otherwise.
"""
import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ARABIC = re.compile(r"[؀-ۿݐ-ݿ]")
TASHKEEL = re.compile(r"[ً-ْٰـ]")
DIGIT = re.compile(r"[0-9٠-٩۰-۹]")

TEXT_POLICY = {
    "stride_frames": 6,          # sweep every 6th frame (0.2 s at 30 fps)
    "caption_min_h_frac": 0.021, # horizontal text at least 2.1% of the frame height (40 px at 1920)
    "size_fail_px": 45,          # caption glyph-box height on a 1920-high frame
    "size_warn_px": 60,
    "dwell_fail_s": 0.2,
    "words_per_s_warn": 5.0,
    "contrast_fail": 3.0,
    "contrast_warn": 4.5,
    "zone_overlap_fail": 0.10,   # share of the caption box inside a platform-UI zone
    "edge_px": 5,
    "face_warn": 0.10,           # share of a face box covered by a caption
    "face_fail": 0.30,
    "hidden_overlap": 0.30,      # share of a screen-text line under a caption box
    "draft_match": 0.6,
    "speech_match": 0.6,
}


class TextUnavailable(Exception):
    pass


# ---------------------------------------------------------------- helper and profile

def vision_helper():
    """Path to the compiled helper, building it into the user cache when the source changes."""
    if sys.platform != "darwin":
        raise TextUnavailable("Vision text and face reading is macOS-only")
    src = HERE / "vision" / "frames.swift"
    digest = hashlib.sha256(src.read_bytes()).hexdigest()[:12]
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / "Library" / "Caches")
    cache = base / "capcutctl" / "vision"
    exe = cache / f"frames-{digest}"
    if exe.exists():
        return exe
    swiftc = shutil.which("swiftc")
    if not swiftc:
        raise TextUnavailable("swiftc is not on PATH (install the Xcode command-line tools)")
    cache.mkdir(parents=True, exist_ok=True)
    tmp = cache / f".frames-{digest}-{os.getpid()}"
    r = subprocess.run([swiftc, "-O", "-o", str(tmp), str(src)], capture_output=True, text=True)
    if r.returncode:
        raise TextUnavailable(f"could not build the Vision helper: {r.stderr.strip()[-300:]}")
    os.replace(tmp, exe)
    return exe


def run_vision(exe, paths, dual=True, languages="en-US,ar"):
    args = [str(exe), "--languages", languages] + (["--dual"] if dual else [])
    r = subprocess.run(args, input="\n".join(str(p) for p in paths) + "\n",
                       capture_output=True, text=True)
    if r.returncode:
        raise TextUnavailable(f"the Vision helper failed: {r.stderr.strip()[-300:]}")
    out = {}
    for line in r.stdout.splitlines():
        if line.strip():
            rec = json.loads(line)
            out[rec["path"]] = rec
    return out


def load_profile_zones():
    """Safe zones and caption bands from the merged profile."""
    zones = load_profile().get("safeZones") or {}
    return zones.get("forbidden") or [], zones.get("textBands") or {}


def load_profile():
    """The repo presets deep-merged with the user's profile, as the Node side layers them."""
    def merge(a, b):
        for k, v in b.items():
            a[k] = merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
        return a
    profile = json.loads((HERE.parent / "presets" / "profile.json").read_text())
    if os.environ.get("CAPCUTCTL_PRESET_DIR"):
        user = Path(os.environ["CAPCUTCTL_PRESET_DIR"]) / "profile.json"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        user = base / "capcutctl" / "profile.json"
    if user.exists():
        with contextlib.suppress(ValueError):
            profile = merge(profile, json.loads(user.read_text()))
    return profile


# ---------------------------------------------------------------- text utilities

def norm(text):
    t = unicodedata.normalize("NFKC", text or "").lower()
    t = TASHKEEL.sub("", t)
    t = re.sub(r"[إأآا]", "ا", t)
    t = t.replace("ى", "ي").replace("ة", "ه")
    return re.sub(r"[^\w\s]", "", t).strip()


def matches(line_text, authored_text):
    """A read line is that authored text: close spelling and comparable length."""
    a, b = norm(line_text), norm(authored_text)
    if not a or not b or min(len(a), len(b)) < 0.5 * max(len(a), len(b)):
        return False
    return similar(a, b) >= TEXT_POLICY["draft_match"]


def similar(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    short, long_ = sorted((a, b), key=len)
    # Containment counts only when the shorter string is a real share of the longer one:
    # a two-letter word is "inside" any URL, which made screen text look like captions.
    if short in long_ and len(short) >= 0.5 * len(long_):
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def px(line, w, h):
    return [line["x"] * w, line["y"] * h, line["w"] * w, line["h"] * h]


def inter(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def merge_reads(rec):
    """One list of lines per frame: the Arabic-first reading replaces a Latin-first one
    wherever it found Arabic in the same place, and adds lines the first pass missed."""
    first = list(rec.get("text") or [])
    for alt in rec.get("text_alt") or []:
        if not ARABIC.search(alt.get("text", "")):
            continue
        a_box = [alt["x"], alt["y"], alt["w"], alt["h"]]
        hits = [i for i, f in enumerate(first)
                if inter(a_box, [f["x"], f["y"], f["w"], f["h"]]) > 0.3 * min(alt["w"] * alt["h"], f["w"] * f["h"])]
        for i in sorted(hits, reverse=True):
            if not ARABIC.search(first[i].get("text", "")):
                first.pop(i)
        if not any(ARABIC.search(first[i].get("text", "")) for i in hits if i < len(first)):
            first.append(alt)
    return first


def contrast_ratio(gray_crop):
    """WCAG-style ratio between the two luminance classes (Otsu split) inside a text box."""
    g = np.asarray(gray_crop, np.float32).ravel()
    if g.size < 16 or g.max() - g.min() < 2:
        return 1.0
    hist, edges = np.histogram(g, bins=64, range=(0, 255))
    p = hist / hist.sum()
    centers = (edges[:-1] + edges[1:]) / 2
    best, thr = -1.0, centers[32]
    for k in range(1, 64):
        w0, w1 = p[:k].sum(), p[k:].sum()
        if w0 == 0 or w1 == 0:
            continue
        m0 = (p[:k] * centers[:k]).sum() / w0
        m1 = (p[k:] * centers[k:]).sum() / w1
        between = w0 * w1 * (m0 - m1) ** 2
        if between > best:
            best, thr = between, edges[k]
    lo, hi = g[g < thr], g[g >= thr]
    if not lo.size or not hi.size:
        return 1.0

    def lum(v):
        c = float(np.median(v)) / 255
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        return c
    a, b = lum(hi), lum(lo)
    return round((max(a, b) + 0.05) / (min(a, b) + 0.05), 2)


# ---------------------------------------------------------------- speech

def transcribe_export(video, cache_dir, lang=None):
    """Words with export-timeline times, from mlx_whisper via aroll's cached transcriber."""
    sys.path.insert(0, str(HERE))
    import aroll  # the same transcriber the A-roll cut uses; heavy, so only with --speech
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    result = aroll.transcribe(str(video), lang, aroll.DEFAULT_MODEL, str(cache_dir))
    words = []
    for seg in result.get("segments") or []:
        for w in seg.get("words") or []:
            if w.get("start") is not None and w.get("end") is not None:
                words.append({"word": w.get("word", "").strip(), "start": float(w["start"]),
                              "end": float(w["end"])})
    return {"language": result.get("language"), "text": result.get("text", ""), "words": words,
            "segments": [{"start": float(s.get("start", 0)), "end": float(s.get("end", 0)),
                          "text": (s.get("text") or "").strip()} for s in result.get("segments") or []]}


# ---------------------------------------------------------------- the pass

def scan_text(video, ledger, info, extract, t_of, frame_at, out_dir, authored=None,
              speech=None, stride=None):
    """Measure every caption and screen-text line on a sweep of exact frames.

    authored: [{"t0", "t1", "text", "track"}] from the draft (export seconds) or None.
    Returns a JSON-able dict with captions, screen text, faces, findings and verdicts.
    """
    P = TEXT_POLICY
    stride = stride or P["stride_frames"]
    W, H = int(info["video"]["width"]), int(info["video"]["height"])
    exe = vision_helper()
    n = ledger["frames"]
    frames = set(range(0, n, stride))
    for a in authored or []:
        mid = frame_at(ledger, min(max(0.0, (a["t0"] + a["t1"]) / 2), ledger["duration_s"] - 1e-6))
        frames.add(mid)
    frames = sorted(frames)
    with tempfile.TemporaryDirectory() as td:
        got = extract(video, ledger, frames, td, ext="jpg")
        reads = run_vision(exe, [p for _, p in got])
        samples = []
        for k, p in got:
            rec = reads.get(str(p), {})
            if rec.get("error"):
                raise TextUnavailable(f"Vision could not read frame {k}: {rec['error']}")
            lines = []
            for ln in merge_reads(rec):
                box = px(ln, W, H)
                lines.append({"text": ln.get("text", ""), "conf": round(float(ln.get("confidence", 0)), 2),
                              "box": [round(v, 1) for v in box]})
            faces = [[round(v, 1) for v in px(f, W, H)] for f in rec.get("faces") or []]
            samples.append({"frame": k, "t": round(t_of(ledger, k), 4), "lines": lines, "faces": faces})
        _classify(samples, authored, W, H)
        contrast = {}
        with_caps = [s for s in samples if any(ln["caption"] for ln in s["lines"])]
        for s in with_caps:
            path = dict(got)[s["frame"]]
            with Image.open(path) as im:
                gray = im.convert("L")
                for i, ln in enumerate(s["lines"]):
                    if ln["caption"]:
                        x, y, w, h = ln["box"]
                        crop = gray.crop((int(max(0, x)), int(max(0, y)), int(min(W, x + w)), int(min(H, y + h))))
                        contrast[(s["frame"], i)] = contrast_ratio(crop)
    for s in samples:
        for i, ln in enumerate(s["lines"]):
            if (s["frame"], i) in contrast:
                ln["contrast"] = contrast[(s["frame"], i)]
    states = _caption_states(samples, ledger, t_of, stride)
    forbidden, _ = load_profile_zones()
    result = _judge(states, samples, authored, speech, forbidden, W, H)
    result.update({"stride_frames": stride, "frames_read": len(samples),
                   "languages": "en-US,ar (both orders)", "samples": samples})
    _atomic_json(Path(out_dir) / "text.json", result)
    return result


def _atomic_json(path, data):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _classify(samples, authored, W, H):
    P = TEXT_POLICY
    _, bands = load_profile_zones()
    sx, sy = W / 1080, H / 1920
    band_boxes = [[b["x"] * sx - 60, b["y"] * sy - 60, b["w"] * sx + 120, b["h"] * sy + 120] for b in bands.values()]
    for s in samples:
        active = [a for a in authored or [] if a["t0"] - 0.1 <= s["t"] <= a["t1"] + 0.1]
        for ln in s["lines"]:
            x, y, w, h = ln["box"]
            horizontal = w > 0.8 * h
            big = h >= P["caption_min_h_frac"] * H
            match = max((similar(ln["text"], a["text"]) for a in active), default=0.0)
            ln["authored"] = round(match, 2) if active else None
            if authored is not None:
                ln["caption"] = bool(horizontal and big and any(matches(ln["text"], a["text"]) for a in active))
                # Read on a neighbouring frame, a caption word is still a caption, not screen text.
                piece = norm(ln["text"])
                ln["authored_nearby"] = bool(piece) and any(
                    matches(ln["text"], a["text"]) or piece in norm(a["text"]) for a in authored
                    if a["t0"] - 1.5 <= s["t"] <= a["t1"] + 1.5)
            else:
                cx, cy = x + w / 2, y + h / 2
                in_band = any(b[0] <= cx <= b[0] + b[2] and b[1] <= cy <= b[1] + b[3] for b in band_boxes)
                ln["caption"] = bool(horizontal and big and in_band)


def _caption_states(samples, ledger, t_of, stride):
    """Runs of samples showing the same caption text: one state per thing a viewer reads."""
    states = []
    cur = None
    for s in samples:
        caps = [ln for ln in s["lines"] if ln["caption"]]
        key = " | ".join(sorted(norm(ln["text"]) for ln in caps))
        if cur and key == cur["key"] and s["frame"] - cur["last"] <= stride:
            cur["last"] = s["frame"]
            cur["samples"].append(s)
            continue
        if cur and cur["key"]:
            states.append(cur)
        cur = {"key": key, "first": s["frame"], "last": s["frame"], "samples": [s]}
    if cur and cur["key"]:
        states.append(cur)
    fps = 1 / (ledger["frame_step_pts"]["median"] * ledger["_tb"])
    out = []
    for st in states:
        caps = [ln for s in st["samples"] for ln in s["lines"] if ln["caption"]]
        best = max(caps, key=lambda ln: ln["conf"])
        frames_seen = st["last"] - st["first"] + 1
        out.append({
            "text": " / ".join(dict.fromkeys(ln["text"] for s in st["samples"][:1] for ln in s["lines"] if ln["caption"])),
            "frames": [st["first"], st["last"]],
            "t": [round(t_of(ledger, st["first"]), 3), round(t_of(ledger, st["last"]), 3)],
            # Seen on every sample in the run: the true dwell is between what was seen and
            # what was seen plus one stride on each side, so it is an estimate.
            "dwell_s": [round(frames_seen / fps, 3), round((frames_seen + 2 * (stride - 1)) / fps, 3)],
            "height_px": round(max(ln["box"][3] for ln in caps), 1),
            "box": _union([ln["box"] for ln in caps]),
            "contrast": min((ln.get("contrast", 99) for ln in caps), default=None),
            "words": len(norm(best["text"]).split()),
            "faces": [f for s in st["samples"] for f in s["faces"]],
            "sample_frames": [s["frame"] for s in st["samples"]],
        })
    return out


def _union(boxes):
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)]


def _judge(states, samples, authored, speech, forbidden, W, H):
    P = TEXT_POLICY
    sx, sy = W / 1080, H / 1920
    zones = [(z["name"], [z["x"] * sx, z["y"] * sy, z["w"] * sx, z["h"] * sy]) for z in forbidden]
    nine_sixteen = abs(W / H - 9 / 16) < 0.01
    issues = {k: [] for k in ("size", "dwell", "rate", "contrast", "zone", "edge", "face", "hidden", "draft", "speech")}
    for st in states:
        h1920 = st["height_px"] * 1920 / H
        st["height_px_1920"] = round(h1920, 1)
        if h1920 < P["size_warn_px"]:
            issues["size"].append((st, "FAIL" if h1920 < P["size_fail_px"] else "UNKNOWN", f"{h1920:.0f}px"))
        lo, hi = st["dwell_s"]
        if hi < P["dwell_fail_s"]:
            issues["dwell"].append((st, "FAIL", f"on screen {lo:.2f}-{hi:.2f}s"))
        rate = st["words"] / max(hi, 1e-3)
        st["words_per_s"] = round(rate, 2)
        if rate > P["words_per_s_warn"] and st["words"] >= 3:
            issues["rate"].append((st, "UNKNOWN", f"{st['words']} words in ≤{hi:.2f}s"))
        c = st["contrast"]
        if c is not None and c < P["contrast_warn"]:
            issues["contrast"].append((st, "FAIL" if c < P["contrast_fail"] else "UNKNOWN", f"{c}:1"))
        box = st["box"]
        area = max(1.0, box[2] * box[3])
        if nine_sixteen:
            for name, z in zones:
                share = inter(box, z) / area
                if share >= P["zone_overlap_fail"]:
                    issues["zone"].append((st, "FAIL", f"{share:.0%} in {name}"))
        if box[0] <= P["edge_px"] or box[0] + box[2] >= W - P["edge_px"]:
            issues["edge"].append((st, "FAIL", "touches the frame edge"))
        cover = max((inter(box, f) / max(1.0, f[2] * f[3]) for f in st["faces"]), default=0.0)
        st["face_cover"] = round(cover, 3)
        if cover >= P["face_warn"]:
            issues["face"].append((st, "FAIL" if cover >= P["face_fail"] else "UNKNOWN", f"covers {cover:.0%} of a face"))
        # Screen text the caption sits on, in the same frame or just before/after it.
        t0, t1 = st["t"]
        hidden = set()
        for s in samples:
            if not (t0 - 0.4 <= s["t"] <= t1 + 0.4):
                continue
            for ln in s["lines"]:
                if ln["caption"] or ln.get("authored_nearby"):
                    continue
                if len(re.sub(r"\s", "", ln["text"])) < 2 or ln["conf"] < 0.3:
                    continue
                # Caption-sized text is a caption OCR misread, more often than screen text under
                # one. Limit: large screen text sitting under a caption is not checked here.
                if ln["box"][3] >= P["caption_min_h_frac"] * H:
                    continue
                b = ln["box"]
                if inter(box, b) >= P["hidden_overlap"] * max(1.0, b[2] * b[3]):
                    hidden.add(ln["text"])
        if hidden:
            digits = [t for t in hidden if DIGIT.search(t)]
            issues["hidden"].append((st, "FAIL" if digits else "UNKNOWN",
                                     "sits on screen text " + ", ".join(f'"{t[:30]}"' for t in sorted(hidden)[:4])))
        if authored:
            active = [a for a in authored if a["t0"] - 0.1 <= (t0 + t1) / 2 <= a["t1"] + 0.1]
            m = max((similar(st["text"], a["text"]) for a in active), default=0.0)
            st["draft_match"] = round(m, 2)
            if m < 0.8:
                issues["draft"].append((st, "UNKNOWN", f"reads \"{st['text'][:30]}\", draft has "
                                        + (f"\"{active[0]['text'][:30]}\"" if active else "nothing")))
        if speech:
            spoken = [w["word"] for w in speech["words"] if w["end"] >= t0 - 0.5 and w["start"] <= t1 + 0.5]
            missing = [wd for wd in norm(st["text"]).split()
                       if max((similar(wd, s) for s in spoken), default=0.0) < P["speech_match"]]
            st["unspoken_words"] = missing
            if missing:
                issues["speech"].append((st, "UNKNOWN", "not heard nearby: " + ", ".join(missing[:4])))
            st["speech_rank"] = True

    # Authored text that never showed up on any frame read in its window.
    missing_authored = []
    if authored:
        for a in authored:
            seen = any(a["t0"] - 0.05 <= s["t"] <= a["t1"] + 0.05 and
                       any(matches(ln["text"], a["text"]) for ln in s["lines"])
                       for s in samples)
            looked = any(a["t0"] - 0.05 <= s["t"] <= a["t1"] + 0.05 for s in samples)
            if looked and not seen:
                missing_authored.append(a)

    def verdict(prop, key, ok_detail, label):
        hits = issues[key]
        if not hits:
            return {"property": prop, "verdict": "PASS", "detail": ok_detail, "origin": "M"}
        worst = "FAIL" if any(v == "FAIL" for _, v, _ in hits) else "UNKNOWN"
        where = "; ".join(f"{_fmt(st['t'][0])} \"{st['text'][:24]}\" {d}" for st, _, d in hits[:5])
        return {"property": prop, "verdict": worst, "origin": "M",
                "detail": f"{len(hits)} caption(s) {label}: {where}" + (" …" if len(hits) > 5 else ""),
                "where": [st["frames"] for st, _, _ in hits]}

    v = []
    if not states:
        reason = (f"no caption text found on {len(samples)} frames read "
                  f"({sum(len(s['lines']) for s in samples)} screen-text lines)")
        for prop in ("captions.size", "captions.dwell", "captions.contrast", "layout.safe_zones",
                     "layout.edge", "layout.caption_over_face", "layout.caption_over_text"):
            v.append({"property": prop, "verdict": "NOT CHECKED", "detail": reason, "origin": "M"})
    else:
        cnt = len(states)
        v.append(verdict("captions.size", "size", f"all {cnt} captions ≥{P['size_warn_px']}px tall (1920 scale)", "small"))
        v.append(verdict("captions.dwell", "dwell", f"all {cnt} captions on screen ≥{P['dwell_fail_s']}s", "too brief"))
        v.append(verdict("captions.reading_rate", "rate", f"all ≤{P['words_per_s_warn']} words/s", "fast to read"))
        v.append(verdict("captions.contrast", "contrast", f"all ≥{P['contrast_warn']}:1", "low contrast"))
        if nine_sixteen:
            v.append(verdict("layout.safe_zones", "zone", "no caption in the platform UI zones", "in platform UI"))
        else:
            v.append({"property": "layout.safe_zones", "verdict": "NOT CHECKED", "origin": "-",
                      "detail": f"safe zones are defined for 9:16; this export is {W}x{H}"})
        v.append(verdict("layout.edge", "edge", "no caption touches the frame edge", "cut by the edge"))
        v.append(verdict("layout.caption_over_face", "face", f"no caption covers ≥{P['face_warn']:.0%} of a face", "over a face"))
        v.append(verdict("layout.caption_over_text", "hidden", "no caption sits on screen text", "over screen text"))
    if authored is None:
        v.append({"property": "captions.text_vs_draft", "verdict": "NOT CHECKED", "origin": "A",
                  "detail": "no --project given"})
    else:
        d = verdict("captions.text_vs_draft", "draft", "every caption read matches the draft", "differ from the draft")
        if missing_authored:
            # OCR misses real text (Arabic ligatures, effects), so an unread caption is a
            # question for a look, never a failure on its own.
            d["verdict"] = "UNKNOWN" if d["verdict"] == "PASS" else d["verdict"]
            d["detail"] += (f"; {len(missing_authored)} authored text(s) not read on any frame in their window "
                            "(OCR may have missed them): "
                            + ", ".join(f"{_fmt(a['t0'])} \"{a['text'][:20]}\"" for a in missing_authored[:4]))
        v.append(d)
    if speech is None:
        v.append({"property": "captions.text_vs_speech", "verdict": "NOT CHECKED", "origin": "-",
                  "detail": "pass --speech to transcribe the export and compare"})
    else:
        v.append(verdict("captions.text_vs_speech", "speech", "every caption word was heard nearby",
                         "with words not heard"))
    screen_lines = sum(1 for s in samples for ln in s["lines"] if not ln["caption"])
    return {"captions": states, "verdicts": v, "missing_authored": missing_authored,
            "screen_text_lines": screen_lines,
            "issues": {k: [{"frames": st["frames"], "verdict": vv, "detail": d} for st, vv, d in items]
                       for k, items in issues.items()}}


def _fmt(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"
