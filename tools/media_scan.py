"""Measure a finished video in one decode: cuts, builds, black, freezes, flash frames,
silences and loudness.

The raw evidence behind ``capcutctl reference`` (how a reference reel is paced) and
``capcutctl check-export`` (is this render fit to post). It reports measurements only;
the Node side decides what they mean against the style profile. Never touches a draft.

Picture analysis runs on a 320px-wide decode, which is what the scene score and the
luma statistics need; the contact sheet (``--sheet``) pulls full frames separately.
"""
from __future__ import annotations

import argparse
import contextlib
import itertools
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

CUT_THRESHOLD = 0.3     # scene score of a hard cut
BUILD_THRESHOLD = 0.06  # a pop, push or text build inside a shot
EVENT_MERGE = 0.25      # seconds: detections this close are one event
FLASH_JUMP = 30.0       # luma (0-255) a 1-2 frame flash departs from both neighbours
FLASH_SETTLE = 10.0     # ...while the neighbours agree with each other


def probe(media):
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-show_streams',
                                   '-of', 'json', media], timeout=60)
    data = json.loads(out)
    video = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), None)
    audio = next((s for s in data.get('streams', []) if s.get('codec_type') == 'audio'), None)
    if video is None:
        raise ValueError('no video stream')
    try:
        duration = float((data.get('format') or {}).get('duration'))
    except (TypeError, ValueError):
        duration = float('nan')
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('could not read a positive duration')

    def rate(text):
        try:
            num, den = str(text).split('/')
            return float(num) / float(den) if float(den) else None
        except (ValueError, ZeroDivisionError):
            return None

    fps = rate(video.get('avg_frame_rate')) or rate(video.get('r_frame_rate'))
    return {
        'duration': round(duration, 3),
        'width': video.get('width'),
        'height': video.get('height'),
        'fps': round(fps, 3) if fps else None,
        'videoCodec': video.get('codec_name'),
        'pixFmt': video.get('pix_fmt'),
        'hasAudio': audio is not None,
        'audioCodec': audio.get('codec_name') if audio else None,
        'sampleRate': int(audio['sample_rate']) if audio and audio.get('sample_rate') else None,
        'channels': audio.get('channels') if audio else None,
        'formatName': (data.get('format') or {}).get('format_name'),
    }


def read_metadata(path, key):
    """``metadata=print:file=`` output → [(pts_time, value)] for one key."""
    rows, t = [], None
    try:
        text = Path(path).read_text()
    except OSError:
        return rows
    for line in text.splitlines():
        m = re.search(r'pts_time:\s*([-\d.]+)', line)
        if m:
            t = float(m[1])
            continue
        if t is not None and line.startswith(f'{key}='):
            with contextlib.suppress(ValueError):
                rows.append((t, float(line.split('=', 1)[1])))
    return rows


def spans(stderr, prefix, start_key, end_key, duration):
    """Parse ffmpeg detector logs into [{start, end, duration}] and close an open span at EOF."""
    out, start = [], None
    for line in stderr.splitlines():
        if prefix not in line:
            continue
        s = re.search(rf'{start_key}[:=]\s*([-\d.]+)', line)
        e = re.search(rf'{end_key}[:=]\s*([-\d.]+)', line)
        if s and e:
            out.append((float(s[1]), float(e[1])))
            start = None
        elif s:
            start = float(s[1])
        elif e and start is not None:
            out.append((start, float(e[1])))
            start = None
    if start is not None:
        out.append((start, duration))
    return [{'start': round(a, 3), 'end': round(b, 3), 'duration': round(b - a, 3)} for a, b in out if b > a]


def merge_events(rows, low, high, merge=EVENT_MERGE):
    """Frames scoring in [low, high) → events, keeping the strongest frame of each burst."""
    events = []
    for t, score in rows:
        if not (low <= score < high):
            continue
        if events and t - events[-1]['t'] < merge:
            if score > events[-1]['score']:
                events[-1] = {'t': round(t, 3), 'score': round(score, 3)}
            continue
        events.append({'t': round(t, 3), 'score': round(score, 3)})
    return events


def flash_frames(luma, max_frames=2):
    """Runs of 1-2 frames whose luma departs from both neighbours while the neighbours agree:
    a stray frame from a clip that ends a frame early, or a flash nobody put there."""
    out, i = [], 1
    while i < len(luma) - 1:
        hit = None
        for k in range(1, max_frames + 1):
            if i + k >= len(luma):
                break
            a, c = luma[i - 1][1], luma[i + k][1]
            run = [v for _, v in luma[i:i + k]]
            if abs(a - c) < FLASH_SETTLE and all(abs(v - a) > FLASH_JUMP and abs(v - c) > FLASH_JUMP for v in run):
                hit = {'t': round(luma[i][0], 3), 'frames': k, 'luma': round(sum(run) / k, 1),
                       'neighbours': round((a + c) / 2, 1)}
                break
        if hit:
            out.append(hit)
            i += hit['frames'] + 1
        else:
            i += 1
    return out


def micro_shots(scores, cut, fps, flashes):
    """Shots only 1-2 frames long: two hard cuts that close together are a stray frame
    between clips (a clip ending a frame early, a leftover frame), which a viewer sees as
    a glitch. A same-scene flash is already reported by ``flash_frames``."""
    if not fps:
        return []
    raw = [t for t, s in scores if s >= cut]
    flash_times = [f['t'] for f in flashes]
    out = []
    for a, b in itertools.pairwise(raw):
        frames = round((b - a) * fps)
        if 1 <= frames <= 2 and all(abs(a - t) > 0.5 / fps for t in flash_times):
            out.append({'t': round(a, 3), 'frames': frames})
    return out


def loudness(stderr):
    summary = stderr.split('Summary:')[-1]
    i = re.search(r'\bI:\s*([+-]?[\d.]+|-inf)\s*LUFS', summary)
    lra = re.search(r'\bLRA:\s*([+-]?[\d.]+)\s*LU\b', summary)
    peak = re.search(r'\bPeak:\s*([+-]?(?:[\d.]+|inf))\s*dBFS', summary)

    def num(m):
        if not m:
            return None
        try:
            v = float(m[1])
        except ValueError:
            return None
        return round(v, 2) if math.isfinite(v) else None

    return {'lufs': num(i), 'truePeak': num(peak), 'lra': num(lra)}


def scan(media, cut=CUT_THRESHOLD, build=BUILD_THRESHOLD, silence_db=-40.0, silence_min=0.5, freeze_min=0.5):
    info = probe(media)
    with tempfile.TemporaryDirectory(prefix='capcutctl-scan-') as tmp:
        scene_file = Path(tmp) / 'scene.txt'
        luma_file = Path(tmp) / 'luma.txt'
        esc = lambda p: str(p).replace('\\', '/').replace(':', r'\:').replace("'", r"\'")  # noqa: E731
        vf = ','.join([
            'scale=320:-2',
            'blackdetect=d=0:pix_th=0.10:pic_th=0.98',
            f'freezedetect=n=0.003:d={freeze_min}',
            'signalstats',
            f"metadata=print:key=lavfi.signalstats.YAVG:file='{esc(luma_file)}'",
            r"select='gte(scene\,0)'",
            f"metadata=print:key=lavfi.scene_score:file='{esc(scene_file)}'",
        ])
        cmd = ['ffmpeg', '-hide_banner', '-nostats', '-v', 'info', '-i', media, '-map', '0:v:0', '-vf', vf]
        if info['hasAudio']:
            cmd += ['-map', '0:a:0', '-af', f'silencedetect=n={silence_db}dB:d={silence_min},ebur128=peak=true']
        cmd += ['-f', 'null', '-']
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if run.returncode != 0:
            raise RuntimeError(run.stderr.strip().splitlines()[-1] if run.stderr.strip() else 'ffmpeg failed')
        stderr = run.stderr
        scores = read_metadata(scene_file, 'lavfi.scene_score')
        luma = read_metadata(luma_file, 'lavfi.signalstats.YAVG')

    duration = info['duration']
    # The first frame has no predecessor; ffmpeg scores it 0 or garbage. It is never a cut.
    scores = [(t, s) for t, s in scores if t > 1e-6]
    result = dict(info)
    result.update({
        'media': media,
        'frames': len(luma),
        'thresholds': {'cut': cut, 'build': build, 'silenceDb': silence_db, 'silenceMin': silence_min,
                       'freezeMin': freeze_min},
        'cuts': merge_events(scores, cut, math.inf),
        'builds': merge_events(scores, build, cut),
        'black': spans(stderr, 'blackdetect', 'black_start', 'black_end', duration),
        'freezes': spans(stderr, 'freezedetect', 'freeze_start', 'freeze_end', duration),
        'flashes': flash_frames(luma),
        'silences': spans(stderr, 'silencedetect', 'silence_start', 'silence_end', duration) if info['hasAudio'] else [],
        'loudness': loudness(stderr) if info['hasAudio'] else None,
    })
    result['microShots'] = micro_shots(scores, cut, info['fps'], result['flashes'])
    # A build detected right beside a cut is the cut's own second frame, not a build.
    cut_times = [c['t'] for c in result['cuts']]
    result['builds'] = [b for b in result['builds'] if all(abs(b['t'] - t) >= EVENT_MERGE for t in cut_times)]
    return result


def cut_sheet(media, cuts, out, duration, limit=40, per_row=8):
    """The first frame of every shot (0s, then just after each cut), labelled, as one PNG."""
    from frame_qa import contact_sheet
    from PIL import Image

    times = [0.0] + [c['t'] for c in cuts]
    times = [min(max(0.0, t + 0.04), max(0.0, duration - 0.05)) for t in times][:limit]
    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='capcutctl-sheet-') as tmp:
        tiles = []
        for i, t in enumerate(times):
            dest = Path(tmp) / f'{i}.png'
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', media, '-frames:v', '1',
                            '-vf', 'scale=270:-2', str(dest)], check=True, timeout=60)
            tiles.append((str(dest), f'shot {i + 1} @ {t:.2f}s'))
        rows = []
        for i in range(0, len(tiles), per_row):
            row = Path(tmp) / f'row-{i}.png'
            contact_sheet(tiles[i:i + per_row], str(row), 180)
            with Image.open(row) as im:
                rows.append(im.copy())
        sheet = Image.new('RGB', (max(r.width for r in rows), sum(r.height for r in rows)), '#121212')
        y = 0
        for row in rows:
            sheet.paste(row, (0, y))
            y += row.height
        sheet.save(out)
    return {'path': str(out), 'shots': len(times), 'truncated': len(cuts) + 1 > limit}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--media', required=True)
    parser.add_argument('--cut-threshold', type=float, default=CUT_THRESHOLD)
    parser.add_argument('--build-threshold', type=float, default=BUILD_THRESHOLD)
    parser.add_argument('--silence-db', type=float, default=-40.0)
    parser.add_argument('--silence-min', type=float, default=0.5)
    parser.add_argument('--freeze-min', type=float, default=0.5)
    parser.add_argument('--sheet', help='write a contact sheet of every shot here (PNG)')
    args = parser.parse_args()
    if not 0 < args.build_threshold < args.cut_threshold <= 1:
        parser.error('thresholds must satisfy 0 < --build-threshold < --cut-threshold <= 1')
    if args.silence_min <= 0 or args.freeze_min <= 0:
        parser.error('--silence-min and --freeze-min must be positive')
    media = str(Path(args.media).resolve())
    if not Path(media).is_file():
        parser.error(f'no such media: {media}')
    try:
        result = scan(media, args.cut_threshold, args.build_threshold, args.silence_db, args.silence_min,
                      args.freeze_min)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f'media_scan: {error}', file=sys.stderr)
        sys.exit(2)
    if args.sheet:
        result['sheet'] = cut_sheet(media, result['cuts'], args.sheet, result['duration'])
    print(json.dumps(result))


if __name__ == '__main__':
    main()
