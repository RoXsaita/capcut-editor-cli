"""Staging word-cue engine, independent of the dashboard/DB. JSON request on stdin."""
from __future__ import annotations

import contextlib
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from caption_engine.align import align_transcript_bundle
from caption_engine.asr import transcribe_word_level_isolated
from caption_engine.pipeline import generate_cues_from_transcript

# A wordless ASR segment that is only a sound label ("[موسيقى]", "(Music)", "♪") or punctuation
# carries no speech to caption; anything else might be narration Whisper failed to time.
_SOUND_LABEL = re.compile(r'^\s*[\[(（{【♪].*[\])）}】♪]?\s*$|^\s*(موسيقى|music|applause|تصفيق|laughter|ضحك)\s*$',
                          re.IGNORECASE)
_SUSPECT_SHARE = 0.10


def _segment_range(seg):
    words = seg.get('words') or []
    start = seg.get('start', words[0].get('start') if words else None)
    end = seg.get('end', words[-1].get('end') if words else None)
    try:
        start, end = float(start), float(end)
    except (TypeError, ValueError):
        return None, None
    return start, end


def _filter_wordless_segments(transcript, duration):
    """Keep the worded segments; drop sound labels; refuse wordless narration that matters."""
    kept, dropped, suspect = [], [], []
    for seg in transcript.get('segments', []):
        if seg.get('words'):
            kept.append(seg)
            continue
        text = str(seg.get('text') or '').strip()
        start, end = _segment_range(seg)
        if not text or not re.search(r'\w', text) or _SOUND_LABEL.match(text):
            reason = 'empty' if not text else 'sound label' if re.search(r'\w', text) else 'punctuation'
            dropped.append({'start': start, 'end': end, 'text': text, 'reason': reason})
        else:
            suspect.append({'start': start, 'end': end, 'text': text, 'reason': 'no word timestamps'})
    if not kept:
        raise ValueError('Captions require word timestamps, not segment-only transcription')
    if suspect:
        ranges = [_segment_range(seg) for seg in kept]
        first = min(a for a, _b in ranges if a is not None) if any(a is not None for a, _b in ranges) else 0.0
        last = max(b for _a, b in ranges if b is not None) if any(b is not None for _a, b in ranges) else 0.0
        total = 0.0
        for seg in suspect:
            if seg['start'] is None or seg['end'] is None:
                raise ValueError(f"ASR segment {seg['text']!r} has no word timestamps and no time range")
            if seg['start'] < last and seg['end'] > first:
                raise ValueError(f"ASR segment {seg['start']:.2f}-{seg['end']:.2f} ({seg['text']!r}) has no word "
                                 'timestamps in the middle of the narration; re-run ASR or import --cues')
            total += max(0.0, seg['end'] - seg['start'])
        if duration and total > _SUSPECT_SHARE * float(duration):
            raise ValueError(f'{total:.2f}s of narration has no word timestamps (over {_SUSPECT_SHARE:.0%} of the '
                             'video); re-run ASR or import --cues')
        dropped += suspect
    filtered = dict(transcript, segments=kept)
    return filtered, dropped


def _range_label(seg):
    if seg['start'] is None or seg['end'] is None:
        return 'an untimed segment'
    return f"{seg['start']:.2f}-{seg['end']:.2f}"


def prepare_captions(transcript, *, duration, scenes=(), script='', run_text=None, positioner=None, onsets=None):
    model = str(transcript.get('model', '')).lower()
    if not any(name in model for name in ('large-v3', 'large-v2')):
        raise ValueError('Captions require strong word-level ASR; refusing weak or unstamped transcription')
    filtered, dropped = _filter_wordless_segments(transcript, duration)
    onset_snapped = 0
    if onsets is not None:
        # Snap a copy: the transcript in the bundle keeps Whisper's own times for audit.
        filtered = copy.deepcopy(filtered)
        from audio_index import snap_word_starts
        for seg in filtered['segments']:
            onset_snapped += snap_word_starts(onsets, seg['words'])
    cues = generate_cues_from_transcript(filtered, mode='single', style_id='suheil', default_position=20)
    if not cues:
        raise ValueError('No speech cues detected')
    if len(cues) == 1 and cues[0]['text'].strip('[]() ') in ('موسيقى', 'Music', 'music'):
        raise ValueError('Music-only asset; refusing to caption an ASR music label')
    # The timeline already knows the layout of its edited shots. Use actual, not wanted, layout.
    for cue in cues:
        for i, scene in enumerate(scenes):
            if scene['at'] <= cue['start'] < scene['end']:
                cue.update(position=50 if scene['is'] == 'split-screen' else 20,
                           scene_id=i, scene_start=scene['at'], scene_end=scene['end'])
                break
    placement = {'backend':'native-timeline-layout', 'presets':[20,50]}
    if positioner:
        cues, placement = positioner(cues)
    report = {}
    kept_text = ' '.join(str(seg.get('text') or ' '.join(str(w.get('word', '')) for w in seg['words'])).strip()
                         for seg in filtered['segments'])
    prior = script or (kept_text if dropped else transcript.get('text')) or ' '.join(c['text'] for c in cues)
    cues = align_transcript_bundle(cues, prior, run_text=run_text, use_llm=bool(run_text), report=report)
    clipped = 0
    for cue in cues:
        if cue['start'] >= duration:
            raise ValueError('ASR emitted a cue beyond edited narration; inspect the transcript')
        if cue['end'] > duration:
            cue['end'] = round(duration, 3)
            clipped += 1
    warnings = ['Native CapCut font/stroke appearance and face safety require visual review.']
    if report.get('status') != 'completed':
        warnings.append('Text needs review: the model typo pass did not complete (see text_polish).')
    elif report.get('rejected'):
        warnings.append(f"Text needs review: {report['rejected']} proposed typo fix(es) were rejected (see text_polish).")
    for seg in dropped:
        warnings.append(f"Dropped wordless ASR segment {_range_label(seg)} ({seg['reason']}): {seg['text']!r}")
    return {'version':1, 'style':'suheil', 'language':transcript.get('language') or 'ar',
            'cues':cues, 'transcript':transcript,
            'asr':{'backend':transcript.get('backend'), 'model':transcript.get('model'), 'quality':'strong'},
            'text_polish':report, 'placement':placement,
            'review':{'status':'needs_review','native_verified':False,'face_clear':False},
            'clipped_at_eof':clipped, 'dropped_segments':dropped, 'onset_snapped':onset_snapped,
            'warnings':warnings}


def text_callback():
    """Explicit provider hook when set; otherwise the cheapest signed-in CLI (caption_text_llm)."""
    raw = os.environ.get('CAPCUTCTL_CAPTION_TEXT_COMMAND')
    if not raw:
        from caption_text_llm import default_text_callback
        return default_text_callback()
    argv = json.loads(raw)
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x for x in argv):
        raise ValueError('CAPCUTCTL_CAPTION_TEXT_COMMAND must be a JSON argv array')

    def run(prompt):
        result = subprocess.run(argv, input=prompt, text=True, capture_output=True, timeout=90, check=True)
        return result.stdout, 'configured-text-command'
    return run


def generate(request):
    # Import only for real generation; pure cue/contract tests stay lightweight.
    from frame_qa import _timeline_audio
    doc = request['document']
    sources = doc['tracks'][request['trackIndex']]['segments']
    for seg in sources:
        if seg.get('reverse') or any(s.get('curve_speed') for s in doc.get('materials', {}).get('speeds', [])
                                     if s.get('id') in seg.get('extra_material_refs', [])):
            raise ValueError('Reverse/curve-speed narration requires an explicit verified cue import')
    with tempfile.TemporaryDirectory(prefix='capcut-captions-') as work:
        audio = _timeline_audio(request['projectDir'], doc, work, request['duration'],
                                sources=sources, strict=True)
        if not audio:
            raise ValueError('No audible narration in the selected track')
        transcript = transcribe_word_level_isolated(audio, language=request.get('language') or 'ar', timeout=600)
        onsets, onset_warning = _audio_onsets(audio, work)
    positioner = None
    if request.get('visualSource'):
        def positioner(cues):
            from caption_engine.layout import apply_layout_overrides, build_video_face_guard_overrides
            overrides, meta = build_video_face_guard_overrides(
                video_path=Path(request['visualSource']), duration=request['duration'],
                allowed_positions=(20, 50), cues=cues)
            return apply_layout_overrides(cues, overrides, default_position=20), meta
    bundle = prepare_captions(transcript, duration=request['duration'], scenes=request.get('scenes', []),
                              script=request.get('script', ''), run_text=text_callback(), positioner=positioner,
                              onsets=onsets)
    if onset_warning:
        bundle['warnings'].append(onset_warning)
    return bundle


def _audio_onsets(audio, work):
    """An energy index of the narration mix, so word starts can be snapped to real sound."""
    try:
        from audio_index import AudioIndex
        wav = os.path.join(work, 'onsets-16k.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(audio), '-vn', '-ac', '1', '-ar', '16000',
                        '-c:a', 'pcm_s16le', wav], check=True, capture_output=True, timeout=300)
        return AudioIndex.from_wav(wav), None
    except Exception as exc:  # snapping is an improvement, never a reason to refuse captions
        return None, f'Word starts were not snapped to the audio onsets: {str(exc)[:200]}'


def main():
    request = json.load(sys.stdin)
    # MLX/FFmpeg progress must never corrupt machine-readable stdout.
    with contextlib.redirect_stdout(sys.stderr):
        result = generate(request)
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
    print()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'CAPTION_GENERATION: {exc}', file=sys.stderr)
        sys.exit(2)
