import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonForTool } from '../src/python.mjs';
import assert from 'node:assert/strict';
import {
  loadBoxesAtTimes, tokenize, sentencesFromWords, timelineSentence, textScore, scorePair,
  alignMonotone, matchShots, shotsToSpec, writersAccept, MATCH_WRITER_OPS,
  SKIP_SCORE, DEFAULT_MIN_MARGIN,
} from '../src/match.mjs';
import { UPSCALE_REFUSE } from '../src/crispness.mjs';

const box = (text, region, extra = {}) => ({
  text, region, conf: 0.9, x: extra.x ?? 0.3, y: extra.y ?? 0.4, w: extra.w ?? 0.2, h: extra.h ?? 0.06,
});

function words(pairs) {
  let t = 0;
  return pairs.map(([word, dur = 0.25]) => {
    const start = t;
    t += dur;
    const end = t;
    t += 0.05;
    return { word, start, end };
  });
}

function moment(start, boxes, extra = {}) {
  return { start, end: extra.end ?? start + 0.4, peak: extra.peak ?? 0.8, boxes };
}

test('tokenize drops stopwords and keeps content', () => {
  assert.deepEqual(tokenize('Look at the gold wave.'), ['gold', 'wave']);
  assert.ok(tokenize('I hit Publish.').includes('publish'));
  assert.ok(tokenize('I hit Publish.').includes('hit'));
});

test('sentencesFromWords splits on punctuation and pauses', () => {
  const rows = sentencesFromWords([
    { word: 'Hit', start: 0, end: 0.2 },
    { word: 'Publish.', start: 0.2, end: 0.5 },
    { word: 'Then', start: 2.0, end: 2.2 },
    { word: 'scroll.', start: 2.2, end: 2.5 },
  ]);
  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /Publish/);
  assert.match(rows[1].text, /scroll/);
});

test('dropped words stay on the face (mapper → null)', () => {
  const sentence = sentencesFromWords(words([['Hello'], ['there.']]))[0];
  const dropped = timelineSentence(sentence, () => null);
  assert.equal(dropped.dropped, true);
  const result = matchShots({
    words: words([['Hello'], ['there.']]),
    moments: [moment(10, [box('Hello', 'canvas')])],
    mapper: () => null,
  });
  assert.equal(result.shots[0].decision, 'none');
  assert.ok(result.shots[0].reasons.includes('dropped-words'));
  assert.equal(result.shots[0].ops.length, 0);
});

test('correct alignment picks the moment whose canvas shows the words', () => {
  const result = matchShots({
    words: words([['I'], ['hit'], ['Publish.']]),
    moments: [
      moment(8, [box('Cancel', 'canvas')]),
      moment(20, [box('Publish', 'canvas')]),
    ],
    clicks: [{ type: 'click', vt: 20.0, nx: 0.4, ny: 0.5 }],
    mapper: t => t,
    screen: '/screen.mp4',
    width: 1920,
    height: 1080,
    mediaDuration: 60e6,
  });
  assert.equal(result.placed, 1);
  assert.equal(result.shots[0].decision, 'place');
  assert.equal(result.shots[0].moment.start, 20);
  assert.ok(result.shots[0].ops.some(op => op.op === 'layout.screen'));
});

test('describes-vs-shows: chat text about gold wave loses to the canvas that shows it', () => {
  const chat = moment(12, [box('gold wave', 'chat', { x: 0.78, y: 0.2 })]);
  const canvas = moment(44, [
    box('GOLD', 'canvas', { x: 0.35, y: 0.4 }),
    box('WAVE', 'canvas', { x: 0.35, y: 0.52 }),
  ]);
  const result = matchShots({
    words: words([['Look'], ['at'], ['the'], ['gold'], ['wave.']]),
    moments: [chat, canvas],
    mapper: t => t,
    screen: '/screen.mp4',
  });
  assert.equal(result.shots[0].decision, 'place');
  assert.equal(result.shots[0].moment.start, 44);
  const chatScore = textScore('gold wave', chat.boxes);
  const canvasScore = textScore('gold wave', canvas.boxes);
  assert.ok(canvasScore.score > chatScore.score, { canvas: canvasScore, chat: chatScore });
  assert.equal(chatScore.chatOnly, true);
});

test('chat-only gold wave is not placed (no-B-roll beats a description)', () => {
  const result = matchShots({
    words: words([['Look'], ['at'], ['the'], ['gold'], ['wave.']]),
    moments: [moment(12, [box('gold wave', 'chat', { x: 0.8, y: 0.2 })])],
    mapper: t => t,
  });
  assert.equal(result.shots[0].decision, 'none');
  assert.ok(result.shots[0].ops.length === 0);
});

test('monotone DP refuses a backwards jump in the recording', () => {
  const result = matchShots({
    words: [
      { word: 'First', start: 0, end: 0.3 },
      { word: 'Publish.', start: 0.3, end: 0.6 },
      { word: 'Then', start: 4, end: 4.2 },
      { word: 'Cancel.', start: 4.2, end: 4.5 },
    ],
    moments: [
      moment(30, [box('Cancel', 'canvas')]),
      moment(80, [box('Publish', 'canvas')]),
    ],
    clicks: [
      { type: 'click', vt: 30 },
      { type: 'click', vt: 80 },
    ],
    mapper: t => t,
    screen: '/screen.mp4',
  });
  const placed = result.shots.filter(shot => shot.decision === 'place');
  const starts = placed.map(shot => shot.moment.start);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] >= starts[i - 1], starts);
  }
  // Taking Publish@80 then Cancel@30 would jump backwards — at most one of those lands.
  assert.ok(placed.length <= 1 || starts[0] <= starts[1]);
  const cancelAfterPublish = placed.length === 2 && starts[0] === 80 && starts[1] === 30;
  assert.equal(cancelAfterPublish, false);
});

test('a moment is used at most once', () => {
  const shared = moment(15, [box('Publish', 'canvas')]);
  const result = matchShots({
    words: [
      { word: 'Hit', start: 0, end: 0.2 },
      { word: 'Publish.', start: 0.2, end: 0.5 },
      { word: 'Hit', start: 3, end: 3.2 },
      { word: 'Publish.', start: 3.2, end: 3.5 },
    ],
    moments: [shared],
    clicks: [{ type: 'click', vt: 15 }],
    mapper: t => t,
    screen: '/screen.mp4',
  });
  const placed = result.shots.filter(shot => shot.decision === 'place' && shot.moment?.start === 15);
  assert.equal(placed.length, 1, result.shots.map(s => s.decision));
  assert.equal(result.shots.filter(shot => shot.decision === 'none' || shot.decision === 'flag').length, 1);
});

test('two equally good moments are flagged, not placed', () => {
  const result = matchShots({
    words: words([['I'], ['hit'], ['Publish.']]),
    moments: [
      moment(10, [box('Publish', 'canvas')]),
      moment(40, [box('Publish', 'canvas')]),
    ],
    clicks: [{ type: 'click', vt: 10 }, { type: 'click', vt: 40 }],
    mapper: t => t,
    minMargin: DEFAULT_MIN_MARGIN,
    screen: '/screen.mp4',
  });
  assert.equal(result.shots[0].decision, 'flag');
  assert.ok(result.shots[0].reasons.includes('low-margin'));
  assert.ok(result.shots[0].score.margin < DEFAULT_MIN_MARGIN);
  assert.equal(result.shots[0].ops.length, 0);
});

test('no matching OCR means no B-roll', () => {
  const result = matchShots({
    words: words([['I'], ['think'], ['so.']]),
    moments: [moment(9, [box('Settings', 'toolbar')])],
    mapper: t => t,
  });
  assert.equal(result.none, result.sentences);
  assert.equal(result.placed, 0);
  assert.ok(result.shots.every(shot => shot.decision === 'none' && shot.ops.length === 0));
});

test('a shot that would exceed UPSCALE_REFUSE is demoted to flag', () => {
  const result = matchShots({
    words: words([['I'], ['hit'], ['Publish.']]),
    moments: [moment(20, [box('Publish', 'canvas')])],
    clicks: [{ type: 'click', vt: 20 }],
    mapper: t => t,
    screen: '/screen.mp4',
    canvas: { width: 1080, height: 1920 },
    sourceDims: { width: 320, height: 180 },
  });
  assert.equal(result.shots[0].decision, 'flag');
  assert.ok(result.shots[0].reasons.includes('UPSCALE_REFUSE'));
  assert.ok(UPSCALE_REFUSE < 4);
});

test('a shot that would trip BROLL_IN_MOTION is demoted to flag', () => {
  const result = matchShots({
    words: words([['I'], ['hit'], ['Publish.']]),
    moments: [moment(0, [box('Publish', 'canvas')], { end: 6, peak: 0.9 })],
    clicks: [{ type: 'click', vt: 0.1 }],
    mapper: t => t,
    screen: '/screen.mp4',
    canvas: { width: 1080, height: 1920 },
    sourceDims: { width: 1920, height: 1080 },
  });
  assert.equal(result.shots[0].decision, 'flag');
  assert.ok(result.shots[0].reasons.includes('BROLL_IN_MOTION'), result.shots[0].reasons);
});

test('--apply produces only ops the existing writers accept (dry-run path)', () => {
  const result = matchShots({
    words: words([['I'], ['hit'], ['Publish.']]),
    moments: [moment(20, [box('Publish', 'canvas')])],
    clicks: [{ type: 'click', vt: 20 }],
    mapper: t => t,
    screen: '/durable/screen.mp4',
    width: 1920,
    height: 1080,
    mediaDuration: 120e6,
    canvas: { width: 1080, height: 1920 },
    sourceDims: { width: 1920, height: 1080 },
  });
  assert.equal(result.shots[0].decision, 'place');
  const spec = shotsToSpec(result);
  assert.ok(spec.operations.length >= 1);
  for (const op of spec.operations) {
    assert.ok(MATCH_WRITER_OPS.includes(op.op), op.op);
  }
  const check = writersAccept(spec.operations);
  assert.equal(check.ok, true, check.rejected);
  assert.ok(!spec.operations.some(op => !MATCH_WRITER_OPS.includes(op.op)));
});

test('shotsToSpec never places a flagged shot even if leftover ops remain', () => {
  const spec = shotsToSpec({
    shots: [
      { decision: 'flag', ops: [{ op: 'layout.screen', media: '/screen.mp4', at: 1, duration: 2, src: 0 }] },
      { decision: 'none', ops: [{ op: 'clip.add', media: '/screen.mp4', at: 2, duration: 1 }] },
      { decision: 'place', ops: [{ op: 'layout.screen', media: '/screen.mp4', at: 4, duration: 2, src: 10 }] },
    ],
  });
  assert.equal(spec.operations.length, 1);
  assert.equal(spec.operations[0].at, 4);
});

test('alignMonotone skips a weak pair rather than forcing a match', () => {
  const { assignment } = alignMonotone(
    [{ id: 's0' }],
    [{ start: 1 }],
    [[{ total: SKIP_SCORE - 0.1 }]],
  );
  assert.equal(assignment[0], null);
});

test('scorePair weights canvas above chat for the same tokens', () => {
  const sentence = { text: 'gold wave' };
  const chat = scorePair(sentence, { start: 1, end: 1.4, peak: 0.8, boxes: [box('gold wave', 'chat')] });
  const canvas = scorePair(sentence, { start: 2, end: 2.4, peak: 0.8, boxes: [box('gold wave', 'canvas')] });
  assert.ok(canvas.total > chat.total);
  assert.ok(chat.total < SKIP_SCORE);
  assert.ok(canvas.total > SKIP_SCORE);
});

// Exercise the real Python bridge: ordinary recordings exceed spawnSync's 1 MiB default.
test('matcher reads OCR payloads larger than 1 MiB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-match-ocr-'));
  try {
    const media = path.join(dir, 'screen.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:d=1', media]);
    const tools = fileURLToPath(new URL('../tools', import.meta.url));
    execFileSync(pythonForTool('find.py').executable, ['-c', [
      'import sys,json',
      'sys.path.insert(0,sys.argv[1])',
      'import find',
      'media,cache=sys.argv[2:]',
      'boxes=[dict(text="label"*100,conf=0.9,x=0.1,y=0.2,w=0.3,h=0.1,region="canvas")]*300',
      'record=find._ocr_record(media,find.source_token(media),1,{0:{"text":"labels","boxes":boxes}})',
      'find.ocr_cache_path(media,cache_dir=cache).write_text(json.dumps(record))',
    ].join(';'), tools, media, dir]);
    const result = loadBoxesAtTimes(media, Array.from({ length: 10 }, (_, i) => i / 10), { cacheDir: dir });
    assert.ok(JSON.stringify(result).length > 1024 * 1024);
    assert.equal(result['0.9'].length, 300);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
