#!/usr/bin/env python3
"""Watcher: one cheap model call per 15-min window over a picked take (see pick.py).

Input per window: the app/action timeline, each keyframe's NEW OCR lines (lines already sent in
this window are not repeated), and screenshots depending on --mode:
  ocr     - text only
  images  - every keyframe's JPEG
  mixed   - JPEG only for keyframes whose new OCR text is short (visual screens: a figure, a video,
            a design), text for the rest
The model cites keyframe ids; this script maps ids to take + offset + wall clock, so the model never
writes a timestamp. Calls `claude -p` headless on the user's own login (no API key; any
ANTHROPIC_API_KEY in the environment is stripped so it can never bill a key).

usage: watch.py <pick-out-dir> [--mode mixed] [--model claude-haiku-5-5] [--tag name]
writes <dir>/journal-<mode>.json and .md
"""

import argparse
import base64
import json
import os
import re
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOW_S = 900
MAX_OCR_CHARS = 1200
IMAGE_IF_NEW_CHARS_BELOW = 300
STRIP_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
             "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION")


def mmss(s):
    return f"{int(s // 60):02d}:{int(s % 60):02d}"


def build_window(w, kfs, timeline, take, prev_summary, mode, kdir):
    lo, hi = w * WINDOW_S, (w + 1) * WINDOW_S
    ev = [e for e in timeline["events"] if lo <= e["vt"] < hi]
    tl_lines = []
    for e in ev:
        rest = {k: v for k, v in e.items() if k not in ("vt", "ev")}
        tl_lines.append(f"{mmss(e['vt'])} {e['ev']} " + " ".join(f"{k}={v}" for k, v in rest.items()))
    header = (f"Take {take}, window {mmss(lo)}-{mmss(min(hi, timeline['duration_s']))} "
              f"of {mmss(timeline['duration_s'])}.")
    if prev_summary:
        header += f"\nPrevious window: {prev_summary}"
    content = [{"type": "text", "text": header + "\n\nTIMELINE\n" + "\n".join(tl_lines) + "\n\nKEYFRAMES"}]
    seen, n_images, ocr_chars = set(), 0, 0
    for k in kfs:
        new = [l for l in k["ocr"] if len(l) >= 3 and l not in seen]
        seen.update(k["ocr"])
        text = " | ".join(new)
        if len(text) > MAX_OCR_CHARS:
            text = text[:MAX_OCR_CHARS] + " …"
        ocr_chars += len(text)
        with_image = mode == "images" or (mode == "mixed" and len(text) < IMAGE_IF_NEW_CHARS_BELOW)
        label = f"{k['id']} {mmss(k['vt'])} [{k['app']}] {'+'.join(k['reasons'])}"
        content.append({"type": "text", "text": f"{label}{' (screenshot follows)' if with_image else ''}\nnew text: {text or '(none)'}"})
        if with_image:
            b = base64.b64encode(open(os.path.join(kdir, f"{k['id']}.jpg"), "rb").read()).decode()
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b}})
            n_images += 1
    return content, {"keyframes": len(kfs), "images": n_images, "ocr_chars": ocr_chars, "timeline_events": len(ev)}


def call_model(content, system, model):
    env = {k: v for k, v in os.environ.items() if k not in STRIP_ENV}
    msg = json.dumps({"type": "user", "message": {"role": "user", "content": content}})
    t = time.time()
    res = subprocess.run(["claude", "-p", "--model", model, "--input-format", "stream-json",
                          "--output-format", "stream-json", "--verbose", "--tools", "",
                          "--system-prompt", system, "--setting-sources", "", "--strict-mcp-config",
                          "--no-session-persistence"],
                         input=msg, capture_output=True, text=True, env=env, timeout=600)
    wall = time.time() - t
    result, init = None, None
    for line in res.stdout.splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("type") == "result":
            result = d
        elif d.get("type") == "system" and d.get("subtype") == "init":
            init = d
    if not result:
        raise RuntimeError(f"claude -p gave no result: {res.stderr[-800:]}")
    u = result.get("usage", {})
    usage = {"input_tokens": u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
             + u.get("cache_read_input_tokens", 0),
             "output_tokens": u.get("output_tokens", 0),
             "cost_usd_list": result.get("total_cost_usd"), "model_ms": result.get("duration_ms"),
             "wall_s": round(wall, 1), "api_key_source": (init or {}).get("apiKeySource")}
    return result.get("result", ""), usage


def parse_json(text):
    m = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(m.group(0)) if m else None
    except json.JSONDecodeError:
        return None


def where(kid, byid):
    k = byid.get(kid)
    if not k:
        return f"{kid} (unknown id)"
    s = f"{k['take']} @ {mmss(k['vt'])} ({k['vt']:.1f}s)"
    if k.get("wall"):
        s += f", {k['wall'][11:]}"
    return s


def render_md(take, windows, byid, mode):
    out = [f"# Watcher journal: {take} ({mode})", ""]
    for w in windows:
        j, st, u = w["journal"], w["stats"], w["usage"]
        out.append(f"## Window {w['range']}")
        out.append(f"_{st['keyframes']} keyframes, {st['images']} images, {u['input_tokens']:,} input tokens, "
                   f"{u['output_tokens']:,} output, ${u['cost_usd_list']:.4f} list, {u['wall_s']}s_")
        out.append("")
        if not j:
            out += ["(model output did not parse)", "```", w["raw"][:2000], "```", ""]
            continue
        out += [j.get("summary", ""), "", "**What he did**"]
        for a in j.get("activities", []):
            out.append(f"- {mmss(byid[a['from']]['vt']) if a.get('from') in byid else a.get('from')}"
                       f"–{mmss(byid[a['to']]['vt']) if a.get('to') in byid else a.get('to')}: {a.get('what')}")
        out += ["", "**What he looked at**"]
        for a in j.get("looked_at", []):
            out.append(f"- {a.get('k')} ({where(a.get('k'), byid)}): {a.get('what')}")
        out += ["", "**Story moments**"]
        for s in j.get("story_moments", []):
            out.append(f"- **{s.get('title')}** [{s.get('strength')}] {where(s.get('k'), byid)} "
                       f"(keyframes/{s.get('k')}.jpg)  \n  why: {s.get('why')}  \n  proof: {s.get('proof')}")
        out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--mode", choices=("ocr", "images", "mixed"), default="mixed")
    ap.add_argument("--model", default="claude-haiku-5-5")
    a = ap.parse_args()
    kfs = json.load(open(os.path.join(a.dir, "keyframes.json")))
    timeline = json.load(open(os.path.join(a.dir, "timeline.json")))
    system = open(os.path.join(HERE, "prompt.md")).read()
    take = timeline["take"]
    byid = {k["id"]: k for k in kfs}
    windows, prev = [], None
    for w in range(int(timeline["duration_s"] // WINDOW_S) + 1):
        inw = [k for k in kfs if w * WINDOW_S <= k["vt"] < (w + 1) * WINDOW_S]
        if not inw:
            continue
        content, stats = build_window(w, inw, timeline, take, prev, a.mode, os.path.join(a.dir, "keyframes"))
        raw, usage = call_model(content, system, a.model)
        j = parse_json(raw)
        rng = f"{mmss(w * WINDOW_S)}-{mmss(min((w + 1) * WINDOW_S, timeline['duration_s']))}"
        windows.append({"window": w, "range": rng, "stats": stats, "usage": usage, "journal": j, "raw": raw})
        prev = (j or {}).get("summary")
        print(json.dumps({"take": take, "mode": a.mode, "window": rng, **stats, **usage}))
    json.dump({"take": take, "mode": a.mode, "model": a.model, "windows": windows},
              open(os.path.join(a.dir, f"journal-{a.mode}.json"), "w"), indent=1, ensure_ascii=False)
    open(os.path.join(a.dir, f"journal-{a.mode}.md"), "w").write(render_md(take, windows, byid, a.mode))


if __name__ == "__main__":
    main()
