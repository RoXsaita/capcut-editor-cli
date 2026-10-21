// Motion-design scenes (mograph/scenes/*.js): the catalog, the literal/determinism
// lint, the synthesised sound, per-scene meta, frame determinism, the readable-text safe-zone
// refusal, alpha hand-off, plan validation and placement/gate handling. Browser tests skip
// cleanly when Playwright/Chromium cannot launch; everything else always runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applySpec, readJson } from '../src/core.mjs';
import { normalizePlan } from '../src/build.mjs';
import { gateReport, graphicEvents } from '../src/gate.mjs';
import { launch, loadPlaywright } from '../src/mograph.mjs';
import { SCENE_DIR, listScenes, probeScene, renderScene, sceneInput } from '../src/mograph-scene.mjs';
import { loadProfile } from '../src/profile.mjs';
import { CUE_KINDS, synthesize } from '../mograph/scenes/sound.mjs';
import { buildProject } from './helpers/polish-project.mjs';

const profile = loadProfile();
const BEAT = 60 / profile.tokens.scene.bpm;

// Every scene with realistic params (Arabic wherever there is text).
const CASES = {
  ignition: { params: { label: 'opus 5.5' }, beats: 3, handoff: { in: 'ink', out: 'hot' } },
  'word-slam': { params: { text: 'صُنع بالكود', then: 'بأمر واحد', caption: 'كل إطار، عن قصد' }, beats: 5, handoff: { in: 'hot', out: 'paper' } },
  'shape-grid': { params: {}, beats: 5, handoff: { in: 'paper', out: 'dots' } },
  'particle-word': { params: { text: 'كود', caption: 'أمر واحد', from: 'dots' }, beats: 6, handoff: { in: 'dots', out: 'ink' } },
  'style-stinger': { params: { count: 4, word: 'إيقاع' }, beats: 2, handoff: { in: 'cut', out: 'cut' } },
  'dot-signature': { params: { name: 'سهيل', role: 'صانع محتوى', footer: 'made in code' }, beats: 5, handoff: { in: 'ink', out: 'ink' } },
  'format-morph': { params: { labels: ['فيديو', 'تطبيق', 'موقع'], actions: ['اختار', 'ابني', 'شارك'], hero: ['فكرتك', 'جاهزة'] }, beats: 6, handoff: { in: 'seam', out: 'seam' } },
  'claude-brief': { params: { text: 'زيّه', then: 'بس عنّي' }, beats: 5, handoff: { in: 'seam', out: 'seam' } },
  'seam-wipe': { params: { text: 'الحل' }, beats: 3, handoff: { in: 'seam', out: 'seam' } },
  'frame-travel': { params: { keys: [{ at: 0, to: 'seam' }, { at: 0, to: [40, 480, 1000, 903] }, { at: 0.8, to: 'full' }, { at: 1.2, to: [40, 480, 1000, 903] }], beats: 3 }, beats: 3, handoff: { in: 'footage', out: 'footage' } },
  'follow-ending': { params: { imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    pill: 'الجزء القادم', headline: 'تابعني', sub: 'للمزيد' }, beats: 6, handoff: { in: 'captured-frame', out: 'follow-card' } },
};

// ---- browser ----------------------------------------------------------------------------------
let browserPromise = null;
function sharedBrowser() {
  browserPromise ??= (async () => {
    try {
      const playwright = await loadPlaywright();
      return { browser: await launch(playwright) };
    } catch (error) {
      if (error.code === 'MOGRAPH_BROWSER' || /Executable doesn't exist|browserType\.launch|Failed to launch/i.test(String(error.message))) {
        return { skip: `scene browser unavailable: ${String(error.message).split('\n')[0]}` };
      }
      throw error;
    }
  })();
  return browserPromise;
}
test.after(async () => { const b = await browserPromise; await b?.browser?.close(); });

async function openPage(browser, scene, params) {
  const input = sceneInput(scene, params, { profile });
  const context = await browser.newContext({ viewport: { width: input.canvas.width, height: input.canvas.height } });
  const page = await context.newPage();
  await page.addInitScript(value => { window.__SCENE_INPUT__ = value; }, input);
  await page.goto(pathToFileURL(path.join(SCENE_DIR, 'host.html')).href);
  const meta = await page.evaluate(() => window.__scene.ready);
  return { context, page, meta };
}
const pixels = page => page.evaluate(() => {
  const c = document.getElementById('out');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
});
const alphaStats = page => page.evaluate(() => {
  const c = document.getElementById('out'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let count = 0, outside = 0, x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0, p = y * c.width * 4 + 3; x < c.width; x++, p += 4) {
    if (d[p] <= 0) continue;
    count++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    if (x < 70 || x > 930 || y < 230 || y > 600) outside++;
  }
  return { count, outside, bounds: count ? [x0, y0, x1, y1] : null };
});

// ---- catalog & lint -----------------------------------------------------------------------------

test('the catalog lists every scene with its documentation', () => {
  const scenes = listScenes();
  assert.deepEqual(scenes.map(s => s.id).sort(), Object.keys(CASES).sort());
  for (const s of scenes) {
    assert.ok(s.summary.length > 20, `${s.id} has a summary`);
    for (const field of ['params', 'beats', 'handoff', 'use']) assert.ok(s[field], `${s.id} documents ${field}:`);
  }
});

test('scenes carry no literal colours, fonts, wall clock or unseeded randomness', () => {
  for (const { id } of listScenes()) {
    const src = fs.readFileSync(path.join(SCENE_DIR, `${id}.js`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, /#[0-9a-f]{3,8}\b/i, `${id}: colours come from K.color(role)`);
    assert.doesNotMatch(src, /\b(rgb|hsl)a?\(\s*\d/i, `${id}: no literal rgb()`);
    assert.doesNotMatch(src, /Math\.random|Date\.now|performance\.now|requestAnimationFrame|setTimeout/, `${id}: deterministic`);
    assert.doesNotMatch(src, /px\s+["']?(Inter|Arial|Helvetica|IBM Plex|JetBrains)/i, `${id}: fonts come from K.font`);
    assert.match(src, new RegExp(`id:\\s*'${id}'`), `${id}: SCENE.define id equals the file name`);
  }
});

// ---- sound --------------------------------------------------------------------------------------

test('scene sound is a deterministic 48 kHz stereo WAV of the scene length, peaking at -6 dBFS', () => {
  const cues = [{ at: 0, kind: 'impact' }, { at: 0.3, kind: 'whoosh', dur: 0.4 }, { at: 0.5, kind: 'bell', note: 77 }, { at: 9, kind: 'blip' }];
  const a = synthesize(cues, { duration: 1.5 });
  const b = synthesize(cues, { duration: 1.5 });
  assert.ok(a.equals(b), 'same cues, same bytes');
  assert.equal(a.toString('ascii', 0, 4), 'RIFF');
  assert.equal(a.readUInt32LE(24), 48000);
  assert.equal(a.readUInt16LE(22), 2);
  assert.equal((a.length - 44) / 4, 72000);
  let peak = 0;
  for (let i = 44; i < a.length; i += 2) peak = Math.max(peak, Math.abs(a.readInt16LE(i)));
  assert.ok(Math.abs(peak / 32767 - 0.5) < 0.01, `peak ${peak / 32767}`);
  assert.throws(() => synthesize([{ at: 0, kind: 'airhorn' }], { duration: 1 }), /unknown cue kind/);
});

// ---- per-scene meta (browser) ------------------------------------------------------------------

for (const [id, c] of Object.entries(CASES)) {
  test(`${id}: whole half-beats, a declared hand-off, cues inside the clip, readable text clear of the UI`, async t => {
    const b = await sharedBrowser();
    if (b.skip) return t.skip(b.skip);
    const { context, page, meta } = await openPage(b.browser, id, c.params);
    try {
      assert.equal(meta.beats, c.beats);
      assert.ok(Math.abs(meta.duration - c.beats * BEAT) < 1e-9);
      assert.equal(meta.frames, Math.round(meta.duration * profile.canvas.fps));
      assert.deepEqual(meta.handoff, c.handoff);
      assert.ok(meta.cues.length > 0, 'every scene has sound');
      for (const cue of meta.cues) {
        assert.ok(CUE_KINDS.includes(cue.kind), `${id}: cue kind ${cue.kind}`);
        assert.ok(cue.at >= 0 && cue.at < meta.duration, `${id}: cue at ${cue.at}`);
      }
      assert.ok(meta.still > 0 && meta.still < meta.duration);
    } finally { await context.close(); }
    const probe = await probeScene({ scene: id, params: c.params, profile });
    assert.deepEqual(probe.unsafe, [], `${id}: ${JSON.stringify(probe.unsafe[0])}`);
  });
}

test('a frame is a pure function of its index (same pixels alone, in sequence, twice)', async t => {
  const b = await sharedBrowser();
  if (b.skip) return t.skip(b.skip);
  const { context, page } = await openPage(b.browser, 'word-slam', CASES['word-slam'].params);
  try {
    await page.evaluate(() => window.__scene.frame(17, { samples: 2 }));
    const alone = await pixels(page);
    for (const i of [3, 40, 16]) await page.evaluate(i => window.__scene.frame(i, { samples: 2 }), i);
    await page.evaluate(() => window.__scene.frame(17, { samples: 2 }));
    assert.equal(await pixels(page), alone);
    await page.evaluate(() => window.__scene.frame(18, { samples: 2 }));
    assert.notEqual(await pixels(page), alone, 'the picture moves');
  } finally { await context.close(); }
});

test('format-morph labels match format hits and the alpha aperture returns to its seam', async t => {
  const b = await sharedBrowser();
  if (b.skip) return t.skip(b.skip);
  const { context, page, meta } = await openPage(b.browser, 'format-morph', CASES['format-morph'].params);
  try {
    assert.equal(meta.alpha, true);
    assert.deepEqual(meta.cues.map(cue => cue.at), [0.6, 2, 3.6].map(beat => beat * BEAT));
    for (const [beat, label] of [[1.1, 'فيديو'], [2.5, 'تطبيق'], [4.1, 'موقع']]) {
      const boxes = await page.evaluate(t => window.__scene.textAt(t), beat * BEAT);
      assert.equal(boxes.filter(box => box.text === label).length, 1);
      for (const box of boxes) {
        assert.ok(box.x >= 140 && box.x + box.w <= 940);
        assert.ok(box.y >= 220 && box.y + box.h <= 1500);
      }
    }
    await page.evaluate(() => window.__scene.frame(0, { samples: 3, grain: 0 }));
    const first = await pixels(page);
    await page.evaluate(i => window.__scene.frame(i, { samples: 3, grain: 0 }), meta.frames - 1);
    assert.equal(await pixels(page), first, 'the handoff is exactly the opening seam');
    const alpha = await page.evaluate(() => {
      const ctx = document.getElementById('out').getContext('2d');
      return [ctx.getImageData(540, 700, 1, 1).data[3], ctx.getImageData(540, 960, 1, 1).data[3]];
    });
    assert.deepEqual(alpha, [0, 255], 'footage is revealed outside the 12px seam');
  } finally { await context.close(); }
});

test('seam-wipe opens out of the seam, lands its label on a brand slab, and hands off through the same seam', async t => {
  const b = await sharedBrowser();
  if (b.skip) return t.skip(b.skip);
  for (const [params, beats] of [[{}, 1], [CASES['seam-wipe'].params, 3]]) {
    const { context, page, meta } = await openPage(b.browser, 'seam-wipe', params);
    try {
      assert.equal(meta.alpha, true);
      assert.equal(meta.beats, beats);
      assert.equal(meta.cues[0].kind, 'whoosh');
      if (params.text) {
        const words = await page.evaluate(t => window.__scene.textAt(t).map(box => box.text), 1.6 * BEAT);
        assert.deepEqual(words, ['الحل']);
      }
      await page.evaluate(() => window.__scene.frame(0, { samples: 3, grain: 0 }));
      const first = await pixels(page);
      await page.evaluate(i => window.__scene.frame(i, { samples: 3, grain: 0 }), meta.frames - 1);
      assert.equal(await pixels(page), first, 'the wipe ends on exactly the seam it opened from');
      const alpha = await page.evaluate(() => {
        const ctx = document.getElementById('out').getContext('2d');
        return [ctx.getImageData(540, 700, 1, 1).data[3], ctx.getImageData(540, 960, 1, 1).data[3]];
      });
      assert.deepEqual(alpha, [0, 255], 'footage shows outside the 12px seam');
    } finally { await context.close(); }
  }
  await assert.rejects(probeScene({ scene: 'seam-wipe', params: { text: 'الحل', beats: 1 }, profile }), /SCENE_PARAM/);
});

test('claude-brief reveals two joined Arabic phrases and returns to its alpha seam', async t => {
  const b = await sharedBrowser();
  if (b.skip) return t.skip(b.skip);
  const { context, page, meta } = await openPage(b.browser, 'claude-brief', CASES['claude-brief'].params);
  try {
    assert.equal(meta.alpha, true);
    assert.deepEqual(meta.cues.map(cue => cue.at), [0.6, 1.4].map(beat => beat * BEAT));
    const phrases = await page.evaluate(t => window.__scene.textAt(t).map(box => box.text), 3.4 * BEAT);
    assert.deepEqual(phrases, ['زيّه', 'بس عنّي']);
    await page.evaluate(() => window.__scene.frame(0, { samples: 3, grain: 0 }));
    const first = await pixels(page);
    await page.evaluate(i => window.__scene.frame(i, { samples: 3, grain: 0 }), meta.frames - 1);
    assert.equal(await pixels(page), first, 'the clean brief hands off through the same seam');
  } finally { await context.close(); }
});

for (const [scene, params, cues, labels] of [
  ['claude-brief', { text: 'زيّه', then: 'بس عنّي', presentation: 'overlay' }, [0.6, 1.4],
    [[1.2, ['زيّه']], [3.4, ['زيّه', 'بس عنّي']]]],
  ['format-morph', { labels: ['فيديو', 'تطبيق', 'موقع'], actions: ['اختار', 'ابني', 'شارك'], hero: ['فكرتك', 'جاهزة'], presentation: 'overlay' }, [0.6, 2, 3.6],
    [[1.1, ['فيديو']], [2.5, ['تطبيق', 'اختار', 'ابني', 'شارك']], [4.1, ['موقع', 'فكرتك', 'جاهزة']]]],
]) {
  test(`${scene}: overlay stays transparent outside the upper composition`, async t => {
    const b = await sharedBrowser();
    if (b.skip) return t.skip(b.skip);
    const { context, page, meta } = await openPage(b.browser, scene, params);
    try {
      assert.equal(meta.alpha, true);
      assert.deepEqual(meta.handoff, { in: 'footage', out: 'footage' });
      assert.deepEqual(meta.cues.map(cue => cue.at), cues.map(beat => beat * BEAT));
      await page.evaluate(() => window.__scene.frame(0, { samples: 5, grain: 0 }));
      assert.equal((await alphaStats(page)).count, 0, 'the opening frame is fully transparent');
      for (const [beat, expected] of labels) {
        const at = beat * BEAT;
        const boxes = await page.evaluate(time => window.__scene.textAt(time), at);
        for (const label of expected) assert.equal(boxes.filter(box => box.text === label).length, 1, `${label} appears once`);
        for (const box of boxes) {
          assert.ok(box.x >= 70 && box.x + box.w <= 930, `${box.text} stays within x70–930: ${JSON.stringify(box)}`);
          assert.ok(box.y >= 230 && box.y + box.h <= 600, `${box.text} stays within y230–600: ${JSON.stringify(box)}`);
        }
        await page.evaluate(([frame]) => window.__scene.frame(frame, { samples: 1, grain: 0 }), [Math.round(at * meta.fps)]);
        const stats = await alphaStats(page);
        assert.ok(stats.count > 0, `${scene} draws at ${beat} beats`);
        assert.equal(stats.outside, 0, `${scene} has no aperture, stage or spill outside the composition: ${JSON.stringify(stats)}`);
      }
      await page.evaluate(i => window.__scene.frame(i, { samples: 5, grain: 0 }), meta.frames - 1);
      assert.equal((await alphaStats(page)).count, 0, 'the last frame is fully transparent');
    } finally { await context.close(); }
  });
}

test('format-morph carries a decoded data image through clipped overlay viewports without old labels at cues', async t => {
  const b = await sharedBrowser();
  if (b.skip) return t.skip(b.skip);
  const { context: seedContext, page: seedPage } = await openPage(b.browser, 'format-morph', CASES['format-morph'].params);
  let images;
  try {
    images = await seedPage.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 16; c.height = 9;
      const ctx = c.getContext('2d'); ctx.fillStyle = 'rgb(23,131,247)'; ctx.fillRect(0, 0, 16, 9);
      return ['image/png', 'image/jpeg'].map(type => c.toDataURL(type));
    });
  } finally { await seedContext.close(); }
  for (const imageData of images) {
    const { context, page, meta } = await openPage(b.browser, 'format-morph', {
      ...CASES['format-morph'].params, presentation: 'overlay', imageData,
    });
    try {
      for (const [at, x, y] of [[0.55, 200, 350], [1.25, 500, 380], [2.15, 730, 430]]) {
        await page.evaluate(i => window.__scene.frame(i, { samples: 1, grain: 0 }), Math.round(at * meta.fps));
        const pixel = await page.evaluate(([x, y]) => [...document.getElementById('out').getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
        assert.ok(pixel[2] > 180 && pixel[0] < 50, `same supplied picture survives at ${at}: ${pixel}`);
      }
      for (const at of [0.2, 0.3, 0.85, 0.95, 1, 1.65, 1.75, 1.8, 2.15, 2.6, 2.9]) {
        await page.evaluate(i => window.__scene.frame(i, { samples: 3, grain: 0 }), Math.round(at * meta.fps));
        assert.equal((await alphaStats(page)).outside, 0, `motion stays within the upper composition at ${at}`);
      }
      for (const [cue, label] of [[0.3, 'فيديو'], [1, 'تطبيق'], [1.8, 'موقع']]) {
        for (const offset of [-0.49 / meta.fps, 0, 0.49 / meta.fps]) {
          const words = await page.evaluate(at => window.__scene.textAt(at).map(box => box.text), cue + offset);
          assert.deepEqual(words.filter(word => CASES['format-morph'].params.labels.includes(word)), [label], `only current format in cue shutter at ${cue + offset}`);
        }
      }
      await page.evaluate(() => window.__scene.frame(40, { samples: 3, grain: 0 }));
      const first = await pixels(page);
      await page.evaluate(() => window.__scene.frame(13, { samples: 3, grain: 0 }));
      await page.evaluate(() => window.__scene.frame(40, { samples: 3, grain: 0 }));
      assert.equal(await pixels(page), first, 'decoded picture renders deterministically');
    } finally { await context.close(); }
  }
  for (const imageData of ['https://example.com/image.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,', 'data:image/jpeg;base64,AAAA', 123]) {
    await assert.rejects(probeScene({ scene: 'format-morph', params: { ...CASES['format-morph'].params, presentation: 'overlay', imageData }, profile }),
      err => err.code === 'SCENE_PARAM' && /imageData/.test(err.message));
  }
});

test('a "footage" word-slam ends as a transparent hole (an alpha transition)', async t => {
  const b = await sharedBrowser();
  if (b.skip) return t.skip(b.skip);
  const { context, page, meta } = await openPage(b.browser, 'word-slam', { text: 'MADE IN CODE', to: 'footage' });
  try {
    assert.equal(meta.alpha, true);
    assert.equal(meta.handoff.out, 'footage');
    const alphaAt = async i => page.evaluate(i => { window.__scene.frame(i, { samples: 1 });
      return document.getElementById('out').getContext('2d').getImageData(540, 960, 1, 1).data[3]; }, i);
    assert.equal(await alphaAt(10), 255, 'opaque while the words play');
    assert.equal(await alphaAt(meta.frames - 1), 0, 'the last frame reveals the footage');
  } finally { await context.close(); }
});

test('readable text in the platform UI refuses to render (SCENE_SAFE_ZONE) before any frame is drawn', async t => {
  const b = await sharedBrowser();
  if (b.skip) return t.skip(b.skip);
  const params = { text: 'كود', caption: 'هذا سطر طويل جدًا لا يتسع داخل المنطقة الآمنة على الإطلاق مهما حاولنا' };
  const probe = await probeScene({ scene: 'particle-word', params, profile });
  assert.ok(probe.unsafe.some(u => u.zone === 'right-rail'), JSON.stringify(probe.unsafe));
  await assert.rejects(renderScene({ scene: 'particle-word', params, out: path.join(fs.mkdtempSync('/tmp/scene-'), 'x'), profile }),
    err => err.code === 'SCENE_SAFE_ZONE');
});

test('bad params and unknown scenes fail by name', async t => {
  const b = await sharedBrowser();
  if (b.skip) return t.skip(b.skip);
  await assert.rejects(probeScene({ scene: 'word-slam', params: {}, profile }), err => err.code === 'SCENE_PARAM');
  await assert.rejects(probeScene({ scene: 'nope', params: {}, profile }), err => err.code === 'SCENE_ID');
  for (const scene of ['claude-brief', 'format-morph']) {
    await assert.rejects(probeScene({ scene, params: { presentation: 'screen' }, profile }),
      err => err.code === 'SCENE_PARAM' && /presentation/.test(err.message));
  }
});

// ---- plan, placement, gate ---------------------------------------------------------------------

test('edit plans accept scenes anchored by words or seconds, and refuse ambiguity', () => {
  const plan = normalizePlan({ version: 1, graphics: [{ template: 'keyword-super', say: 'x' }],
    scenes: [{ scene: 'word-slam', say: 'بالكود', params: { text: 'بالكود' } }, { scene: 'dot-signature', at: 12 }] });
  assert.deepEqual(plan.scenes.map(s => s.id), ['word-slam-1', 'dot-signature-2']);
  assert.throws(() => normalizePlan({ version: 1, scenes: [{ scene: 'ignition' }] }), /needs "say"/);
  assert.throws(() => normalizePlan({ version: 1, scenes: [{ at: 1 }] }), /needs a scene/);
  assert.throws(() => normalizePlan({ version: 1, graphics: [{ id: 'a', template: 'keyword-super', at: 1 }], scenes: [{ id: 'a', scene: 'ignition', at: 3 }] }), /duplicate/);
});

test('a placed scene is full-canvas, keeps its own sound, and the gate neither flags its box nor asks for a cue', () => {
  const dir = buildProject();
  fs.mkdirSync(path.join(dir, 'mograph'), { recursive: true });
  const mov = path.join(dir, 'mograph', 'ws.mov');
  fs.writeFileSync(mov, 'prores-bytes');
  applySpec(dir, { version: 1, operations: [{ op: 'mograph.place', id: 'ws-1', template: 'scene:word-slam', format: 'prores',
    file: mov, at: 2, duration: 2.5, box: { x: 0, y: 0, w: 1080, h: 1920 }, sfx: null, clipVolume: 1, fingerprint: 'f' }] });
  const doc = readJson(path.join(dir, 'draft_info.json'));
  const seg = doc.tracks.flatMap(tr => tr.segments || []).find(s => s.desc === 'mograph:ws-1');
  assert.equal(seg.volume, 1);
  assert.equal(seg.clip.scale.x, 1);
  const material = doc.materials.videos.find(m => m.id === seg.material_id);
  assert.equal(material.capcutctl_mograph.scene, true);
  const ev = graphicEvents(doc).find(g => g.desc === 'mograph:ws-1');
  assert.equal(ev.scene, true);
  const report = gateReport(doc, { projectDir: dir, profile });
  const check = id => report.checks.find(c => c.id === id);
  assert.doesNotMatch(check('safe-zones').message, /scene:word-slam/);
  assert.doesNotMatch(check('graphic-sfx').message, /scene:word-slam/);
});
