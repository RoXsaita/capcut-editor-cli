"""Intent for the X-ray (phase 4): does what is on screen back up what is being said?

Beats are the export's own transcript sentences (--speech), or the draft's captions grouped
at pauses. Each beat gets the screen text read during it. Two checks:

- numbers (deterministic): a number said aloud while a screen recording is up, that the
  screen never shows within two seconds, is a question for a look.
- Jev (opt-in, --jev): a typed judgement per beat (supported / contradicted / unrelated /
  insufficient evidence), and a noticeability rank for every UNKNOWN in the queue.

Jev reads text only. It cannot see a picture, so "insufficient evidence" is a real answer
and nothing here becomes a FAIL on a classifier's word.
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
JEV_PACKAGE = "pydantic-ai-slim[typesafe]==2.54.0"
NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


class JevUnavailable(Exception):
    pass


# ---------------------------------------------------------------- Jev environment

def jev_home():
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "capcutctl" / "jev-venv"


def jev_python():
    py = jev_home() / "bin" / "python"
    return py if py.exists() else None


def setup_jev():
    """Build the private environment Jev runs in; the CLI's own Python is never touched."""
    home = jev_home()
    home.parent.mkdir(parents=True, exist_ok=True)
    if not jev_python():
        r = subprocess.run([sys.executable, "-m", "venv", str(home)], capture_output=True, text=True)
        if r.returncode:
            raise JevUnavailable(f"could not create {home}: {r.stderr.strip()[-300:]}")
    r = subprocess.run([str(jev_python()), "-m", "pip", "install", "-q", JEV_PACKAGE],
                       capture_output=True, text=True)
    if r.returncode:
        raise JevUnavailable(f"pip could not install {JEV_PACKAGE}: {r.stderr.strip()[-300:]}")
    return {"venv": str(home), "package": JEV_PACKAGE, "key": "set" if api_key() else "missing"}


def secrets_file():
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "capcutctl" / "secrets.env"


def api_key():
    if os.environ.get("TYPESAFE_API_KEY"):
        return os.environ["TYPESAFE_API_KEY"]
    path = secrets_file()
    if path.exists():
        for line in path.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "TYPESAFE_API_KEY" and value.strip():
                return value.strip().strip("'\"")
    return None


def ask_jev(beats=None, triage=None, model="typesafe:jev-latest"):
    py = jev_python()
    if not py:
        raise JevUnavailable("Jev is not set up; run `capcutctl xray jev-setup`")
    key = api_key()
    if not key:
        raise JevUnavailable(f"no TYPESAFE_API_KEY in the environment or {secrets_file()}")
    env = dict(os.environ, TYPESAFE_API_KEY=key, PYDANTIC_AI_NO_BANNER="1")
    payload = json.dumps({"model": model, "beats": beats or [], "triage": triage or []}, ensure_ascii=False)
    r = subprocess.run([str(py), str(HERE / "xray_jev.py")], input=payload, capture_output=True,
                       text=True, env=env, timeout=600)
    if r.returncode:
        # Never echo the environment; the key lives there.
        raise JevUnavailable(f"Jev call failed: {r.stderr.strip().replace(key, '***')[-300:]}")
    return json.loads(r.stdout)


# ---------------------------------------------------------------- beats

def build_beats(speech, authored, samples):
    """[(t0, t1, said)] from the transcript, else from authored captions grouped at pauses."""
    beats = []
    if speech and speech.get("segments"):
        beats = [(s["start"], s["end"], s["text"]) for s in speech["segments"] if s["text"].strip()]
    elif authored:
        cur = None
        for a in sorted(authored, key=lambda a: a["t0"]):
            if cur and a["t0"] - cur[1] <= 0.6:
                cur = (cur[0], a["t1"], cur[2] + " " + a["text"])
            else:
                if cur:
                    beats.append(cur)
                cur = (a["t0"], a["t1"], a["text"])
        if cur:
            beats.append(cur)
    out = []
    for i, (t0, t1, said) in enumerate(beats):
        screen = []
        seen = set()
        for s in samples:
            if not (t0 - 0.2 <= s["t"] <= t1 + 0.2):
                continue
            for ln in s["lines"]:
                key = re.sub(r"\s+", " ", ln["text"].strip().lower())
                if ln["caption"] or ln.get("authored_nearby") or ln["conf"] < 0.3 or len(key) < 3 or key in seen:
                    continue
                seen.add(key)
                screen.append(ln["text"].strip())
        out.append({"id": f"b{i:03d}", "t": [round(t0, 3), round(t1, 3)], "said": said.strip(),
                    "screen_text": screen[:40]})
    return out


def numbers_in(text):
    return {n.replace(",", ".") for n in NUMBER.findall((text or "").translate(ARABIC_DIGITS))}


def check_numbers(beats, samples):
    """A number said while a screen recording is up, that the screen never shows nearby."""
    issues = []
    for b in beats:
        said = {n for n in numbers_in(b["said"]) if len(n) >= 2}
        if not said:
            continue
        t0, t1 = b["t"]
        nearby = [ln for s in samples if t0 - 2.0 <= s["t"] <= t1 + 2.0 for ln in s["lines"] if not ln["caption"]]
        if len(nearby) < 5:
            continue  # no screen recording to check against
        shown = set().union(*(numbers_in(ln["text"]) for ln in nearby))
        missing = sorted(said - shown)
        b["numbers"] = {"said": sorted(said), "shown_nearby": sorted(said & shown), "not_shown": missing}
        if missing:
            issues.append(b)
    return issues


def beat_state(b):
    screen = "; ".join(b["screen_text"]) or "(no readable text on screen)"
    return (f"The speaker says: \"{b['said']}\"\n"
            f"Text readable on screen at the same moment: {screen}")


# ---------------------------------------------------------------- the pass

def intent_pass(text_result, speech, authored, unknown_items, use_jev):
    """Returns verdicts, beats and an optional noticeability rank for UNKNOWN queue items."""
    samples = text_result.get("samples") or []
    beats = build_beats(speech, authored, samples)
    verdicts = []
    if not beats:
        verdicts.append({"property": "intent.claims", "verdict": "NOT CHECKED", "origin": "-",
                         "detail": "no beats: pass --speech, or --project with captions"})
        return {"beats": [], "verdicts": verdicts, "triage": {}}
    num_issues = check_numbers(beats, samples)
    checked = [b for b in beats if "numbers" in b]
    if num_issues:
        verdicts.append({"property": "intent.numbers", "verdict": "UNKNOWN", "origin": "M",
                         "detail": f"{len(num_issues)} beat(s) say a number the screen never shows nearby: "
                                   + "; ".join(f"{_fmt(b['t'][0])} said {', '.join(b['numbers']['not_shown'])}"
                                               for b in num_issues[:5]),
                         "where_t": [b["t"] for b in num_issues]})
    elif checked:
        verdicts.append({"property": "intent.numbers", "verdict": "PASS", "origin": "M",
                         "detail": f"every number said in {len(checked)} beat(s) with a screen recording is on screen"})
    else:
        verdicts.append({"property": "intent.numbers", "verdict": "NOT CHECKED", "origin": "M",
                         "detail": "no number is said while a screen recording is up"})
    triage = {}
    if not use_jev:
        verdicts.append({"property": "intent.claims", "verdict": "NOT CHECKED", "origin": "-",
                         "detail": f"{len(beats)} beats built; pass --jev to judge them (sends transcript and screen text to TypeSafe)"})
        return {"beats": beats, "verdicts": verdicts, "triage": triage}
    try:
        judged = [b for b in beats if b["screen_text"]]
        reply = ask_jev(beats=[{"id": b["id"], "state": beat_state(b)} for b in judged],
                        triage=[{"id": it["id"], "state": it["state"]} for it in unknown_items])
    except (JevUnavailable, subprocess.TimeoutExpired, ValueError) as e:
        verdicts.append({"property": "intent.claims", "verdict": "NOT CHECKED", "origin": "-",
                         "detail": f"Jev unavailable: {e}"})
        return {"beats": beats, "verdicts": verdicts, "triage": triage}
    for b in beats:
        if b["id"] in reply.get("beats", {}):
            b["jev"] = reply["beats"][b["id"]]
    counts = {}
    for b in beats:
        if "jev" in b:
            counts[b["jev"]["answer"]] = counts.get(b["jev"]["answer"], 0) + 1
    against = [b for b in beats if b.get("jev", {}).get("answer") == "contradicted"]
    summary = ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in sorted(counts.items()))
    no_screen = len(beats) - len([b for b in beats if b["screen_text"]])
    detail = (f"Jev estimate (uncalibrated, text only) on {sum(counts.values())} beat(s) with screen text: "
              f"{summary or 'no answers'}")
    if no_screen:
        detail += f"; {no_screen} beat(s) had no screen text to judge"
    if reply.get("errors"):
        detail += f"; {len(reply['errors'])} call(s) failed"
    if against:
        detail += "; contradicted: " + "; ".join(
            f"{_fmt(b['t'][0])} \"{b['said'][:40]}\" ({b['jev']['confidence']})" for b in against[:4])
    verdicts.append({"property": "intent.claims", "verdict": "UNKNOWN" if against or reply.get("errors") else "PASS",
                     "origin": "E", "detail": detail, "where_t": [b["t"] for b in against]})
    triage = reply.get("triage", {})
    return {"beats": beats, "verdicts": verdicts, "triage": triage, "jev_errors": reply.get("errors", [])}


def _fmt(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


def which_python():
    return shutil.which("python3")
