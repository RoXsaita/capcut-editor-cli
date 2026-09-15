import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  baselineVerdict, buildBrief, assertBlindBrief, verifyShots, BLIND_FORBIDDEN_KEYS,
  changeOccurred, loadVerifyShots, attachSidecarEvidence,
} from '../src/verify.mjs';

const ocr = (text, region) => [{ text, region, conf: 0.9 }];

test('matcher shot files resolve source media and missing strips fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-verify-media-'));
  try {
    const file = path.join(dir, 'shots.json');
    fs.writeFileSync(file, JSON.stringify({ shots: [{ id: 'selected', decision: 'place',
      ops: [{ op: 'layout.screen', media: '/missing-screen.mp4' }] }] }));
    const shots = loadVerifyShots({ shotsFile: file });
    assert.equal(shots[0].media, '/missing-screen.mp4');
    assert.throws(() => verifyShots({ shots, outDir: path.join(dir, 'out') }), { code: 'VERIFY_MEDIA_MISSING' });
    const attached = attachSidecarEvidence(shots);
    assert.equal(attached[0].ocr, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function brief(sentence, { before = [], action = [], after = [], changeScore = 0, clicks = [] } = {}) {
  return buildBrief({ sentence }, {
    before: { t: 9.5, ocr: before },
    action: { t: 10, ocr: action },
    after: { t: 10.5, ocr: after },
    changeScore,
    clicks,
  });
}

test('gold+wave: canvas showing is SUPPORTED; chat describing is INSUFFICIENT', () => {
  const shown = brief('Look at the gold wave', {
    before: ocr('lobby', 'canvas'),
    action: [...ocr('GOLD', 'canvas'), ...ocr('WAVE', 'canvas')],
    after: [...ocr('GOLD', 'canvas'), ...ocr('WAVE', 'canvas')],
    changeScore: 0.8,
  });
  assert.equal(baselineVerdict(shown), 'SUPPORTED');

  const described = brief('Look at the gold wave', {
    before: ocr('gold wave', 'chat'),
    action: ocr('gold wave', 'chat'),
    after: ocr('gold wave', 'chat'),
    changeScore: 0.4,
  });
  assert.equal(baselineVerdict(described), 'INSUFFICIENT');
  assert.equal(changeOccurred(described), true);
});

test('same button, wrong instance: Publish Live vs Drafts is CONTRADICTED', () => {
  const row = brief('I hit Publish on Live', {
    before: ocr('Publish', 'canvas'),
    action: ocr('Publish', 'canvas'),
    after: [...ocr('Publish', 'canvas'), ...ocr('Drafts', 'canvas')],
    changeScore: 0.7,
    clicks: [{ vt: 10, type: 'click' }],
  });
  assert.equal(baselineVerdict(row), 'CONTRADICTED');
});

test('right screen, wrong instance: Grok Build vs Grok Chat is CONTRADICTED', () => {
  const row = brief('Open Grok Build', {
    before: ocr('Grok Chat', 'canvas'),
    action: ocr('Grok Chat', 'canvas'),
    after: ocr('Grok Chat', 'canvas'),
    changeScore: 0.6,
  });
  assert.equal(baselineVerdict(row), 'CONTRADICTED');
});

test('unmatched narration and foreign-language UI are insufficient, not contradicted', () => {
  const row = brief('فاكيوم احدث وارخص', {
    before: ocr('Allegro cart', 'canvas'),
    after: ocr('Dyson cart 1359 PLN', 'canvas'),
    changeScore: 0.8,
  });
  assert.equal(baselineVerdict(row), 'INSUFFICIENT');
});

test('before-vs-after frames swapped is CONTRADICTED', () => {
  const row = brief('the answer appears 42', {
    before: ocr('42', 'canvas'),
    action: ocr('42', 'canvas'),
    after: ocr('thinking', 'canvas'),
    changeScore: 0.9,
  });
  assert.equal(baselineVerdict(row), 'CONTRADICTED');
});

test('an action spoken with no change is CONTRADICTED', () => {
  const row = brief('I hit Publish', {
    before: ocr('Publish', 'canvas'),
    action: ocr('Publish', 'canvas'),
    after: ocr('Publish', 'canvas'),
    changeScore: 0,
  });
  assert.equal(baselineVerdict(row), 'CONTRADICTED');
});

test('brief.json contains no matcher internals', () => {
  const shot = {
    sentence: 'I hit Publish',
    score: { total: 0.9, runnerUp: 0.2, margin: 0.7, typeKind: 'action' },
    reasons: ['would-leak'],
    ops: [{ op: 'layout.screen' }],
    punchOn: 'Publish',
    query: 'Publish',
    decision: 'place',
    source: { in: 10, out: 12 },
  };
  const built = buildBrief(shot, {
    before: { t: 9.5, ocr: ocr('Publish', 'canvas') },
    action: { t: 10, ocr: ocr('Publish', 'canvas') },
    after: { t: 10.5, ocr: ocr('Done', 'canvas') },
    changeScore: 0.8,
    clicks: [{ vt: 10, type: 'click' }],
  });
  assert.equal(assertBlindBrief(built), true);
  const blob = JSON.stringify(built);
  for (const key of BLIND_FORBIDDEN_KEYS) {
    assert.equal(Object.hasOwn(built, key), false, key);
    assert.equal(built.frames.before[key], undefined);
  }
  assert.match(blob, /"changeScore"/);
  assert.doesNotMatch(blob, /"runnerUp"/);
  assert.doesNotMatch(blob, /"punchOn"/);
  assert.doesNotMatch(blob, /layout\.screen/);
  assert.equal(built.sentence, 'I hit Publish');
});

test('verifyShots writes brief/prompt, CONTRADICTED blocks, INSUFFICIENT only flags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-verify-'));
  try {
    const summary = verifyShots({
      writeStrip: false,
      outDir: dir,
      shots: [
        {
          id: 'ok',
          sentence: 'Look at the gold wave',
          source: { in: 40 },
          frames: {
            before: { t: 39.5, ocr: ocr('lobby', 'canvas') },
            action: { t: 40, ocr: [...ocr('GOLD', 'canvas'), ...ocr('WAVE', 'canvas')] },
            after: { t: 40.5, ocr: [...ocr('GOLD', 'canvas'), ...ocr('WAVE', 'canvas')] },
            changeScore: 0.8,
            clicks: [],
          },
        },
        {
          id: 'wrong',
          sentence: 'Open Grok Build',
          source: { in: 12 },
          frames: {
            before: { t: 11.5, ocr: ocr('Grok Chat', 'canvas') },
            action: { t: 12, ocr: ocr('Grok Chat', 'canvas') },
            after: { t: 12.5, ocr: ocr('Grok Chat', 'canvas') },
            changeScore: 0.5,
            clicks: [],
          },
        },
        {
          id: 'thin',
          sentence: 'Look at the gold wave',
          source: { in: 8 },
          frames: {
            before: { t: 7.5, ocr: ocr('gold wave', 'chat') },
            action: { t: 8, ocr: ocr('gold wave', 'chat') },
            after: { t: 8.5, ocr: ocr('gold wave', 'chat') },
            changeScore: 0.3,
            clicks: [],
          },
        },
      ],
    });
    assert.equal(summary.supported, 1);
    assert.equal(summary.contradicted, 1);
    assert.equal(summary.insufficient, 1);
    assert.equal(summary.blocked[0].id, 'wrong');
    assert.equal(summary.flags[0].id, 'thin');
    const briefFile = JSON.parse(fs.readFileSync(path.join(dir, 'wrong', 'brief.json'), 'utf8'));
    assert.equal(assertBlindBrief(briefFile), true);
    assert.equal(Object.hasOwn(briefFile, 'score'), false);
    assert.equal(Object.hasOwn(briefFile, 'ops'), false);
    const prompt = fs.readFileSync(path.join(dir, 'ok', 'prompt.md'), 'utf8');
    assert.match(prompt, /fresh agent/i);
    assert.match(prompt, /no API billing/i);
    assert.ok(fs.existsSync(path.join(dir, 'summary.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
