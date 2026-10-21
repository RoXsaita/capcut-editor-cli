"""Measure edited audio and the full mix; reuse preview's speed/gain/fade renderer.

Reads a document from stdin. Writes only temporary PCM, never project media.
"""
import json
import math
import re
import subprocess
import sys
import tempfile

from frame_qa import FrameExtractionError, _material_index, _timeline_audio, resolve, source_span


def measure(file):
    result = subprocess.run([
        "ffmpeg", "-v", "info", "-nostats", "-i", file, "-af", "ebur128=peak=true",
        "-f", "null", "-",
    ], capture_output=True, text=True, check=True, timeout=120)
    summary = result.stderr.split("Summary:")[-1]
    loudness = re.search(r"\bI:\s*([+-]?[\d.]+)\s*LUFS", summary)
    peak = re.search(r"\bPeak:\s*([+-]?(?:[\d.]+|inf))\s*dBFS", summary)
    if not loudness or not peak:
        raise ValueError("ffmpeg returned no loudness/true-peak summary")
    tp = float(peak[1])
    return {"lufs": float(loudness[1]), "truePeak": tp if math.isfinite(tp) else None}


def analyze(payload):
    doc, project = payload["doc"], payload["projectDir"]
    if isinstance(doc.get("loudnesses"), dict) and doc["loudnesses"].get("enable"):
        raise ValueError("native loudness processing requires native playback measurement")
    materials = _material_index(doc)
    audio_effect_ids = {m["id"] for m in doc.get("materials", {}).get("audio_effects", [])}
    sources, probes, keyed = [], {}, set()
    # Parked parts-bin clips past the edit are not in the video. Without the field
    # (an older caller, or a project with no parked range) every clip is measured.
    content_end = payload.get("contentEndUs")
    content_end = float(content_end) if isinstance(content_end, (int, float)) and content_end > 0 else None
    for track in doc.get("tracks", []):
        if track.get("type") not in ("video", "audio"):
            continue
        for segment in track.get("segments", []):
            if content_end is not None and \
                    float(segment.get("target_timerange", {}).get("start", 0)) >= content_end - 1000:
                continue
            raw_volume = segment.get("volume", 1)
            # A NaN volume from a bad flag reaches the draft as null; name the clip instead of
            # dying in float(None) with a traceback.
            try:
                volume = float(raw_volume)
            except (TypeError, ValueError):
                raise ValueError(f"invalid clip volume {raw_volume!r} on segment {segment.get('id')}") from None
            if not math.isfinite(volume) or volume < 0:
                raise ValueError(f"invalid clip volume {volume} on segment {segment.get('id')}")
            if volume == 0:
                continue
            material = materials.get(segment.get("material_id"), {})
            if track["type"] == "video" and material.get("type") in ("photo", "image"):
                continue
            file = resolve(project, material.get("path", ""))
            # Compound motion layers are nested drafts, not media files. They carry no audio.
            if not file:
                if track["type"] == "audio":
                    raise ValueError(f"audio track has no media path: {segment['id']}")
                continue
            if file not in probes:
                result = subprocess.run(["ffprobe", "-v", "error", "-show_streams",
                                         "-show_format", "-of", "json", file],
                                        capture_output=True, text=True, check=True, timeout=30)
                probes[file] = json.loads(result.stdout)
            if not any(s.get("codec_type") == "audio" for s in probes[file]["streams"]):
                if track["type"] == "audio":
                    raise ValueError(f"audio track has no audio stream: {segment['id']}")
                continue
            start, duration = source_span(segment)
            tt = segment["target_timerange"]
            if not all(math.isfinite(v) for v in (start, duration, tt["start"], tt["duration"])) \
                    or start < 0 or duration <= 0 or tt["start"] < 0 or tt["duration"] <= 0:
                raise ValueError("invalid audio timerange")
            media_duration = float(probes[file]["format"]["duration"])
            if start + duration > media_duration + 0.05:
                raise ValueError(f"audio range exceeds media: {segment['id']}")
            refs = [materials.get(ref, {}) for ref in segment.get("extra_material_refs", [])]
            if segment.get("reverse") or any(ref in audio_effect_ids for ref in segment.get("extra_material_refs", [])) \
                    or any(r.get("curve_speed") or r.get("audio_channel_mapping", 0) != 0
                           or (r.get("type") == "vocal_separation" and r.get("choice", 0) != 0) for r in refs) \
                    or any(r.get("type") in ("audio_effect", "audio_effects", "voice_changer") for r in refs):
                raise ValueError("audio automation/effects require native playback measurement")
            # Volume keys (build's duck) are rendered as gain automation by the shared
            # renderer; a curve other than Line refuses there.
            if any(k.get("property_type") == "KFTypeVolume" and k.get("keyframe_list")
                   for k in segment.get("common_keyframes") or []):
                keyed.add(segment.get("id"))
            sources.append(segment)
    end = max((s["target_timerange"]["start"] + s["target_timerange"]["duration"]
               for s in sources), default=0) / 1e6
    if content_end is not None:
        end = min(end, content_end / 1e6)
    if not sources:
        return {"segments": {}, "mix": {"lufs": None, "truePeak": None}, "silent": True}
    with tempfile.TemporaryDirectory(prefix="capcutctl-levels-") as tmp:
        slices = []
        wav = _timeline_audio(project, doc, tmp, end, sources=sources,
                              strict=True, slices_out=slices)
        if not wav:
            return {"segments": {}, "mix": {"lufs": None, "truePeak": None}, "silent": True,
                    "scope": "Edited ranges, constant speed, clip gain, fades and stereo sum; native DSP is not emulated."}
        rows = {}
        if not payload.get("mixOnly"):
            for segment, file in slices:
                measured = measure(file)
                gain = 20 * math.log10(float(segment.get("volume", 1)))
                rows[segment["id"]] = {
                    "lufs": measured["lufs"] - gain if measured["lufs"] > -69.9 else -70,
                    "truePeak": measured["truePeak"] - gain if measured["truePeak"] is not None else None,
                }
                if segment["id"] in keyed:
                    # Measured with its keys, so the static gain does not undo it.
                    rows[segment["id"]]["keyed"] = True
        return {"segments": rows, "mix": measure(wav),
                "scope": "Edited ranges, constant speed, clip gain, fades and stereo sum; native DSP is not emulated."}


if __name__ == "__main__":
    try:
        print(json.dumps(analyze(json.load(sys.stdin)), allow_nan=False))
    except (ValueError, KeyError, OSError, subprocess.SubprocessError, FrameExtractionError) as exc:
        print(f"audio measurement failed: {exc}", file=sys.stderr)
        sys.exit(1)
