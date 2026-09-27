"""Staging word-cue engine, independent of the dashboard/DB. JSON request on stdin."""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from caption_engine.align import align_transcript_bundle
from caption_engine.asr import transcribe_word_level_isolated
from caption_engine.pipeline import generate_cues_from_transcript


def prepare_captions(transcript, *, duration, scenes=(), script='', run_text=None, positioner=None):
    model = str(transcript.get('model', '')).lower()
    if not any(name in model for name in ('large-v3', 'large-v2')):
        raise ValueError('Captions require strong word-level ASR; refusing weak or unstamped transcription')
    if not all(seg.get('words') for seg in transcript.get('segments', [])):
        raise ValueError('Captions require word timestamps, not segment-only transcription')
    cues = generate_cues_from_transcript(transcript, mode='single', style_id='suheil', default_position=20)
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
    prior = script or transcript.get('text') or ' '.join(c['text'] for c in cues)
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
    return {'version':1, 'style':'suheil', 'language':transcript.get('language') or 'ar',
            'cues':cues, 'transcript':transcript,
            'asr':{'backend':transcript.get('backend'), 'model':transcript.get('model'), 'quality':'strong'},
            'text_polish':report, 'placement':placement,
            'review':{'status':'needs_review','native_verified':False,'face_clear':False},
            'clipped_at_eof':clipped, 'warnings':warnings}


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
    positioner = None
    if request.get('visualSource'):
        def positioner(cues):
            from caption_engine.layout import apply_layout_overrides, build_video_face_guard_overrides
            overrides, meta = build_video_face_guard_overrides(
                video_path=Path(request['visualSource']), duration=request['duration'],
                allowed_positions=(20, 50), cues=cues)
            return apply_layout_overrides(cues, overrides, default_position=20), meta
    return prepare_captions(transcript, duration=request['duration'], scenes=request.get('scenes', []),
                            script=request.get('script', ''), run_text=text_callback(), positioner=positioner)


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
