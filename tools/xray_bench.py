"""Seeded-defect benchmark for the X-ray (phase 5).

Plants known defects into re-encoded copies of a real export, scans each copy, and reports
what the detectors caught: recall per defect family, how often at FAIL rather than UNKNOWN,
recall near cuts, and false alarms that the clean copy did not have.

It measures the video and audio detectors only. Passing it says those detectors find these
planted families at these positions; it says nothing about meaning, captions or taste.
"""
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np

FAMILIES = ("black1", "white2", "local1", "dup1", "click", "clip")
ACCEPT = {
    "black1": ({"black_frames", "glitch"}, 2),
    "white2": ({"white_frames", "glitch"}, 2),
    "local1": ({"glitch"}, 1),
    "dup1": ({"duplicate_in_motion"}, 1),
}


def _plant_plan(x, ledger, base_vid, base_audio, rng, per_family):
    n = ledger["frames"]
    fps = 1 / (ledger["frame_step_pts"]["median"] * ledger["_tb"])
    busy = set()
    for f in base_vid["findings"]:
        busy.update(range(f["frames"][0] - 10, f["frames"][1] + 11))
    for f in base_audio.get("findings") or []:
        k = int(f["t"] * fps)
        busy.update(range(k - 10, k + 11))
    cuts = base_vid["cuts"]
    plan = []
    # Transitions are where detectors struggle: plant next to cuts on purpose, beside the
    # random positions, wherever the clean scan found nothing there already.
    near = [c for c in cuts if 30 <= c <= n - 30 and not any(i in busy for i in range(c - 3, c + 4))]
    for fam, offset in (("black1", 1), ("local1", -1)):
        if near:
            c = near.pop(int(rng.integers(0, len(near))))
            k = c + offset
            busy.update(range(k - 20, k + 21))
            item = {"family": fam, "frame": k, "t": round(x.t_of(ledger, k), 4), "near_cut": True}
            if fam == "local1":
                item["box"] = [int(rng.integers(0, 700)), int(rng.integers(200, 1500)), 160, 160]
            plan.append(item)
    for fam in FAMILIES:
        for _ in range(per_family):
            for _try in range(400):
                k = int(rng.integers(20, n - 20))
                if any(i in busy for i in range(k - 20, k + 21)):
                    continue
                busy.update(range(k - 20, k + 21))
                item = {"family": fam, "frame": k, "t": round(x.t_of(ledger, k), 4),
                        "near_cut": any(abs(k - c) <= 3 for c in cuts)}
                if fam == "local1":
                    item["box"] = [int(rng.integers(0, 700)), int(rng.integers(200, 1500)), 160, 160]
                plan.append(item)
                break
    return plan


def _filters(plan, w, h):
    vf, af_inputs = [], []
    for p in plan:
        k = p["frame"]
        if p["family"] == "black1":
            vf.append(f"drawbox=x=0:y=0:w={w}:h={h}:color=black:t=fill:enable='eq(n\\,{k})'")
        elif p["family"] == "white2":
            vf.append(f"drawbox=x=0:y=0:w={w}:h={h}:color=white:t=fill:enable='between(n\\,{k}\\,{k + 1})'")
        elif p["family"] == "local1":
            x0, y0, bw, bh = p["box"]
            vf.append(f"drawbox=x={x0}:y={y0}:w={bw}:h={bh}:color=white:t=fill:enable='eq(n\\,{k})'")
        elif p["family"] in ("click", "clip"):
            af_inputs.append(p)
    return vf, af_inputs


def _render(video, out, plan, info, duration):
    w, h = int(info["video"]["width"]), int(info["video"]["height"])
    vf, audio_events = _filters(plan, w, h)
    cmd = ["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(video)]
    expr = [f"0.7*between(t\\,{p['t']:.6f}\\,{p['t'] + 1 / 48000:.6f})"
            for p in audio_events if p["family"] == "click"]
    # Clipping the way it happens: a stretch of the real programme pushed 20 dB too hot.
    boosts = [f"volume=10:enable='between(t\\,{p['t']:.6f}\\,{p['t'] + 0.2:.6f})'"
              for p in audio_events if p["family"] == "clip"]
    filters = []
    dups = [p["frame"] for p in plan if p["family"] == "dup1"]
    if vf or dups:
        filters.append(f"[0:v]{','.join(vf) or 'null'}[v0]")
        # freezeframes takes the stream twice: the picture and the source of the repeat.
        for i, k in enumerate(dups):
            filters.append(f"[v{i}]split[m{i}][r{i}];[m{i}][r{i}]freezeframes=first={k}:last={k}:replace={k - 1}[v{i + 1}]")
        filters.append(f"[v{len(dups)}]null[v]")
    audio_mapped = bool(expr or boosts)
    if audio_mapped:
        chain = ",".join(["aresample=48000", *boosts])
        filters.append(f"[0:a]{chain}[base]")
        if expr:
            filters.append(f"aevalsrc='{'+'.join(expr)}':s=48000:d={duration:.3f}[spike]")
            filters.append("[base][spike]amix=inputs=2:normalize=0:duration=first[a]")
        else:
            filters.append("[base]anull[a]")
    if filters:
        cmd += ["-filter_complex", ";".join(filters)]
    cmd += ["-map", "[v]" if (vf or dups) else "0:v:0", "-map", "[a]" if audio_mapped else "0:a:0",
            "-c:v", "libx264", "-crf", "14", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-fps_mode", "passthrough", "-c:a", "aac", "-b:a", "256k", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"could not render the planted copy: {r.stderr.strip()[-400:]}")


def _scan(x, video):
    info = x.probe_streams(video)
    ledger = x.build_ledger(video, info)
    vid = x.detect_video(x.scan_video(video, ledger, info), ledger)
    audio = {}
    if "audio" in info:
        samples, rate = x.decode_audio(video)
        audio = x.detect_audio(samples, rate)
    return info, ledger, vid, audio


def _hard(f):
    if f["kind"] in ("black_frames", "white_frames"):
        return f["count"] <= 3 and not f.get("dip") and not f.get("near_cut")
    return f["kind"] == "glitch" and not f.get("near_cut")


def run_bench(x, video, rounds=3, per_family=2, seed=7, out_dir=None):
    info, ledger, base_vid, base_audio = _scan(x, video)
    duration = ledger["duration_s"]
    rng = np.random.default_rng(seed)
    results = []
    false_alarms = []
    with tempfile.TemporaryDirectory() as td:
        clean = Path(td) / "clean.mp4"
        _render(video, clean, [], info, duration)
        _, _, clean_vid, clean_audio = _scan(x, str(clean))
        for r in range(rounds):
            plan = _plant_plan(x, ledger, base_vid, base_audio, rng, per_family)
            copy = Path(td) / f"planted-{r}.mp4"
            _render(video, copy, plan, info, duration)
            _, _, vid, audio = _scan(x, str(copy))
            used = set()
            for p in plan:
                hit = None
                if p["family"] in ACCEPT:
                    kinds, tol = ACCEPT[p["family"]]
                    for i, f in enumerate(vid["findings"]):
                        if f["kind"] in kinds and f["frames"][0] - tol <= p["frame"] <= f["frames"][1] + tol:
                            hit = ("v", i, f)
                            break
                    if p["family"] == "dup1" and hit is None:
                        p["observable"] = bool(_motion_near(x, video, ledger, p["frame"], x.POLICY["dup_motion"]))
                    if p["family"] == "local1" and hit is None:
                        p["observable"] = _patch_visible(x, video, ledger, p)
                else:
                    tol = 0.006 if p["family"] == "click" else 0.21
                    kind = "click" if p["family"] == "click" else "clipping"
                    for i, f in enumerate(audio.get("findings") or []):
                        if f["kind"] == kind and (abs(f["t"] - p["t"]) <= tol if kind == "click"
                                                  else p["t"] - 0.02 <= f["t"] <= p["t"] + tol):
                            hit = ("a", i, f)
                            break
                if p["family"] == "clip" and hit is None:
                    p["observable"] = _loud_enough(x, video, p["t"])
                p["caught"] = hit is not None
                if hit:
                    p["hit"] = {k: hit[2].get(k) for k in ("kind", "frames", "near_cut", "dip", "at_cut", "declared")
                                if k in hit[2]}
                p["at_fail"] = bool(hit and ((hit[0] == "a" and p["family"] == "clip") or (hit[0] == "v" and _hard(hit[2]))))
                if hit:
                    used.add(hit[:2])
                results.append(dict(p, round=r))
            # anything new that the clean re-encode did not have, and no planted defect explains
            for i, f in enumerate(vid["findings"]):
                if ("v", i) in used:
                    continue
                if any(abs(c["frames"][0] - f["frames"][0]) <= 2 and c["kind"] == f["kind"]
                       for c in clean_vid["findings"] + base_vid["findings"]):
                    continue
                false_alarms.append({"round": r, "kind": f["kind"], "frames": f["frames"]})
            hot = [p["t"] for p in plan if p["family"] == "clip"]
            for i, f in enumerate(audio.get("findings") or []):
                if ("a", i) in used or f["kind"] not in ("click", "clipping"):
                    continue
                if any(t - 0.05 <= f["t"] <= t + 0.26 for t in hot):
                    continue  # the planted hot stretch itself: its edges click and both channels clip
                if any(abs(c["t"] - f["t"]) <= 0.01 and c["kind"] == f["kind"]
                       for c in (clean_audio.get("findings") or []) + (base_audio.get("findings") or [])):
                    continue
                false_alarms.append({"round": r, "kind": f["kind"], "t": f["t"]})
    summary = {}
    for fam in FAMILIES:
        rows = [p for p in results if p["family"] == fam and p.get("observable", True)]
        unobservable = [p for p in results if p["family"] == fam and not p.get("observable", True)]
        near = [p for p in rows if p["near_cut"]]
        summary[fam] = {
            "planted": len(rows), "caught": sum(p["caught"] for p in rows),
            "at_fail": sum(p["at_fail"] for p in rows),
            "near_cut": f"{sum(p['caught'] for p in near)}/{len(near)}",
            "unobservable": len(unobservable),
            "missed_at": [p["frame"] for p in rows if not p["caught"]],
        }
    minutes = rounds * duration / 60
    doc = {"video": str(video), "rounds": rounds, "per_family": per_family, "seed": seed,
           "summary": summary, "false_alarms": false_alarms,
           "false_alarms_per_minute": round(len(false_alarms) / max(minutes, 1e-6), 2),
           "clean_reencode_findings": len(clean_vid["findings"]) - len(base_vid["findings"]),
           "planted": results}
    if out_dir:
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        (Path(out_dir) / "bench.json").write_text(json.dumps(doc, indent=1))
    return doc


def _motion_near(x, video, ledger, k, threshold):
    """Was the picture moving around frame k? A repeated frame in a still shot is invisible."""
    with tempfile.TemporaryDirectory() as td:
        got = dict(x.extract(video, ledger, [k - 2, k - 1, k], td, width=270))
        from PIL import Image
        a, b, c = (np.asarray(Image.open(got[i]).convert("L"), np.float32) / 255 for i in (k - 2, k - 1, k))
        return float(np.abs(b - a).mean()) > threshold and float(np.abs(c - b).mean()) > threshold


def _loud_enough(x, video, t):
    """+20 dB only clips where the original already peaks above -18 dBFS."""
    samples, rate = x.decode_audio(video)
    seg = samples[int(t * rate):int((t + 0.2) * rate)]
    return bool(seg.size and float(np.abs(seg).max()) * 10 >= 1.25)


def _patch_visible(x, video, ledger, p):
    """A white patch on a near-white region of the original changes nothing a detector could see."""
    with tempfile.TemporaryDirectory() as td:
        [(_, path)] = x.extract(video, ledger, [p["frame"]], td)
        from PIL import Image
        g = np.asarray(Image.open(path).convert("L"), np.float32) / 255
        x0, y0, w, h = p["box"]
        return float(g[y0:y0 + h, x0:x0 + w].mean()) < 0.85


def render_summary(doc):
    lines = [f"BENCH  {Path(doc['video']).name}  {doc['rounds']} round(s) × {doc['per_family']} per family, seed {doc['seed']}",
             f"  {'family':<8} {'caught':>9} {'at FAIL':>8} {'near cut':>9} {'unobservable':>13}  missed at frames"]
    for fam, s in doc["summary"].items():
        lines.append(f"  {fam:<8} {s['caught']:>4}/{s['planted']:<4} {s['at_fail']:>8} {s['near_cut']:>9} "
                     f"{s['unobservable']:>13}  {s['missed_at'] or '-'}")
    lines.append(f"  false alarms not in the clean re-encode: {len(doc['false_alarms'])} "
                 f"({doc['false_alarms_per_minute']}/min)")
    lines.append("  scope: video and audio detectors on planted defects; captions, meaning and taste are not measured here")
    return "\n".join(lines)
