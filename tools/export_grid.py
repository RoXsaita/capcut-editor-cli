"""Build a timestamped QA grid from an actual export, without compositing the draft."""
import argparse
import json
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from frame_qa import contact_sheet
from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--media', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--times')
    args = parser.parse_args()
    media = str(Path(args.media).resolve())
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format',
                                               '-show_streams', '-of', 'json', media]))
    duration = float(probe['format']['duration'])
    times = ([float(t) for t in args.times.split(',')] if args.times else
             [i * max(0, duration - .1) / 15 for i in range(16)])
    if not times or len(times) > 128 or any(not 0 <= t < duration for t in times):
        parser.error('times must contain 1-128 finite timestamps within the export')
    out = Path(args.out).resolve()
    if out == Path(media):
        parser.error('grid cannot overwrite the input video')
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='capcutctl-grid-') as temp:
        def frame(item):
            i, time = item
            dest = str(Path(temp) / f'{i}.png')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(time), '-i', media,
                            '-frames:v', '1', dest], check=True, timeout=60)
            return dest, f'{time:.2f}s'
        with ThreadPoolExecutor(max_workers=4) as pool:
            frames = list(pool.map(frame, enumerate(times)))
        rows = []
        for i in range(0, len(frames), 4):
            sheet = str(Path(temp) / f'row-{i}.png')
            contact_sheet(frames[i:i + 4], sheet, 270)
            with Image.open(sheet) as im:
                rows.append(im.copy())
        grid = Image.new('RGB', (max(r.width for r in rows), sum(r.height for r in rows)), '#121212')
        y = 0
        for row in rows:
            grid.paste(row, (0, y))
            y += row.height
        grid.save(out)
    print(json.dumps({'media': media, 'grid': str(out), 'times': times, 'duration': duration}))


if __name__ == '__main__':
    main()
