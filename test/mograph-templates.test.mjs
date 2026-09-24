// Motion-graphics template library (mograph/templates/*.html): render, determinism, safe zones,
// Arabic joined forms and the token lint. Browser tests skip cleanly when Playwright/Chromium
// cannot launch (MOGRAPH_BROWSER); the lint always runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  TEMPLATE_DIR, listTemplates, loadPlaywright, renderFrames, safeZoneViolations, templateInput, templatePath,
} from '../src/mograph.mjs';
import { loadProfile } from '../src/profile.mjs';

const profile = loadProfile();
const FPS = profile.canvas.fps;
const LAUNCH_ARGS = ['--font-render-hinting=none', '--disable-lcd-text'];

// Every v1 template with default-placement params (Arabic wherever there is text) and the words
// the viewer should see, in reading order.
const CASES = {
  'hook-title': { params: { text: 'هذه الأداة ستغير كل شيء' }, words: 'هذه الأداة ستغير كل شيء', sfx: 'impact', motion: 'rich', frames: [45, 75] },
  'keyword-super': { params: { text: 'أداة مجانية' }, words: 'أداة مجانية', sfx: 'pop', motion: 'rich' },
  'number-pop': { params: { value: 87, suffix: '%', label: 'أسرع من المنافسين' }, words: 'أسرع من المنافسين', sfx: 'pop', motion: 'rich', frames: [66, 999] },
  'callout-box': { params: { box: [160, 760, 600, 280], label: 'اضغط هنا' }, words: 'اضغط هنا', sfx: 'enter', motion: 'rich' },
  'cta-card': { params: { keyword: 'ذكاء' }, words: 'اكتب ذكاء في التعليقات', sfx: 'select', motion: 'rich', frames: [90, 120] },
  'brand-chip': { params: { name: 'جوجل جيميني' }, words: 'جوجل جيميني', sfx: 'pop', motion: 'slide' },
};
const TIMES = [2, 7, 22].map(f => f / FPS);        // entrance, mid-entrance, hold — within every template

// ---- browser availability --------------------------------------------------------------------
let browserPromise = null;
/** One shared Chromium for page-level inspection, or a skip reason when it cannot launch. */
function sharedBrowser() {
  browserPromise ??= (async () => {
    try {
      const playwright = await loadPlaywright();
      return { browser: await playwright.chromium.launch({ executablePath: process.env.CAPCUTCTL_CHROMIUM || undefined, args: LAUNCH_ARGS }) };
    } catch (error) {
      if (error.code === 'MOGRAPH_BROWSER' || /Executable doesn't exist|browserType\.launch|Failed to launch/i.test(String(error.message))) {
        return { skip: `mograph browser unavailable: ${String(error.message).split('\n')[0]}` };
      }
      throw error;
    }
  })();
  return browserPromise;
}
test.after(async () => { const b = await browserPromise; await b?.browser?.close(); });

/**
 * Open a template page, wait for ready, seek to `t`, and report every .mg-word span with the
 * platform fonts Chromium actually used for it (CDP), which is the ground truth for fallback.
 */
async function inspectWords(browser, template, params, t) {
  const context = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(value => { window.__MG_INPUT__ = value; }, templateInput(params, { profile }));
    await page.goto(pathToFileURL(templatePath(template)).href);
    const meta = await page.evaluate(() => window.__mograph.ready);
    await page.evaluate(time => window.__mograph.seek(time ?? 0), t);
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '#mg-root .mg-word' });
    const texts = await page.evaluate(() => [...document.querySelectorAll('#mg-root .mg-word')].map(s => s.textContent));
    const words = [];
    for (const [i, nodeId] of nodeIds.entries()) {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      words.push({ text: texts[i], fonts });
    }
    return { meta, words };
  } finally { await context.close(); }
}

const png = buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// ---- the library -----------------------------------------------------------------------------
test('the v1 template library is complete and self-documented', () => {
  const listed = listTemplates();
  for (const [id, c] of Object.entries(CASES)) {
    const t = listed.find(x => x.id === id);
    assert.ok(t, `${id}.html exists`);
    assert.ok(t.summary, `${id} has a summary line`);
    assert.match(t.params, /\{.*\}/, `${id} documents its params`);
    assert.equal(t.sfx, c.sfx, `${id} pairs the ${c.sfx} cue`);
    assert.equal(t.motion, c.motion, `${id} motion class`);
    const html = fs.readFileSync(path.join(TEMPLATE_DIR, `${id}.html`), 'utf8');
    assert.match(html, new RegExp(`name:\\s*'${id}'`), `${id} defines itself under its file name`);
  }
});

// ---- token lint (no browser) -----------------------------------------------------------------
test('templates take colours, fonts and timing from the profile tokens only', () => {
  const family = profile.tokens.font.family;
  const banned = [
    [/#[0-9a-fA-F]{3,8}\b/, 'a literal hex colour'],
    [/\brgba?\(\s*\d/, 'a literal rgb() colour'],
    [/\bhsla?\(\s*\d/, 'a literal hsl() colour'],
    [/font-family\s*:(?!\s*var\(--mg-font\))/i, 'a font-family other than var(--mg-font)'],
    [new RegExp(family.replace(/\s+/g, '\\s*'), 'i'), `the font name "${family}"`],
    [/\b(Arial|Helvetica|Roboto|Inter|Noto|Tahoma|Segoe|Times|Georgia|Cairo|Tajawal|sans-serif|monospace)\b/i, 'a font name'],
    [/\brotate[XYZ3d]*\(|\brotation\b/i, 'rotation'],
    [/\b(animation|transition|will-change)\s*:/i, 'CSS animation, transition or will-change'],
    [/Date\.now|performance\.now|requestAnimationFrame|setTimeout|setInterval/, 'a wall clock'],
    [/Math\.random/, 'unseeded randomness'],
    [/&#/, 'an HTML character reference (hides literals from this lint)'],
  ];
  const files = fs.readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.html'));
  assert.ok(files.length >= Object.keys(CASES).length);
  for (const file of files) {
    const html = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
    for (const [re, what] of banned) {
      const hit = re.exec(html);
      assert.equal(hit, null, `${file} uses ${what}: "${hit?.[0]}"`);
    }
  }
});

// ---- render, determinism, safe zones ---------------------------------------------------------
test('every template renders deterministically inside the safe zones', { concurrency: 3 }, async t => {
  const env = await sharedBrowser();
  if (env.skip) { t.skip(env.skip); return; }
  await Promise.all(Object.entries(CASES).map(([template, c]) => t.test(template, async () => {
    const a = await renderFrames({ template, params: c.params, times: TIMES, profile });
    assert.equal(a.frames.length, TIMES.length);
    for (const f of a.frames) assert.ok(png(f) && f.length > 200, 'a real PNG frame');
    assert.equal(a.meta.name, template);
    assert.equal(a.meta.sfx, c.sfx);
    assert.equal(a.box.w % 2, 0, 'even crop width (ProRes)');
    assert.equal(a.box.h % 2, 0, 'even crop height (ProRes)');
    assert.ok(a.box.w < profile.canvas.width || a.box.h < profile.canvas.height / 2, 'a tight crop, never a full-frame overlay');
    const total = Math.round(a.meta.duration * FPS);
    if (c.frames) assert.ok(total >= c.frames[0] && total <= c.frames[1], `${template} runs ${total}f, expected ${c.frames.join('–')}f`);
    assert.ok(a.meta.still > 0 && a.meta.still < a.meta.duration, 'hold frame inside the clip');
    assert.deepEqual(safeZoneViolations(a.box, profile), [], `default placement ${JSON.stringify(a.box)} avoids platform UI`);

    // A second, independent run in a different order, and frame N rendered alone.
    const b = await renderFrames({ template, params: c.params, times: [TIMES[2], TIMES[0], TIMES[1]], profile });
    assert.deepEqual(b.box, a.box, 'same crop box across runs');
    assert.ok(b.frames[0].equals(a.frames[2]) && b.frames[1].equals(a.frames[0]) && b.frames[2].equals(a.frames[1]),
      'two runs produce identical frames regardless of seek order');
    const alone = await renderFrames({ template, params: c.params, times: [TIMES[1]], profile });
    assert.ok(alone.frames[0].equals(a.frames[1]), 'frame N rendered alone equals frame N in sequence');
  })));
});

// ---- Arabic joined forms ---------------------------------------------------------------------
test('Arabic is set by whole word in the bundled face, never a fallback', { concurrency: 3 }, async t => {
  const env = await sharedBrowser();
  if (env.skip) { t.skip(env.skip); return; }
  const family = profile.tokens.font.family;
  await Promise.all(Object.entries(CASES).map(([template, c]) => t.test(template, async () => {
    const { meta, words } = await inspectWords(env.browser, template, c.params, 1);
    const expected = c.words.split(/\s+/);
    assert.equal(meta.words, expected.length, 'runtime reports one span per word');
    assert.deepEqual(words.map(w => w.text), expected, 'spans are whole words in reading order (never letters)');
    for (const w of words) {
      assert.ok(w.fonts.length > 0, `"${w.text}" was shaped`);
      for (const f of w.fonts) {
        // The bundled face reports as "<family>" or "<family> SemiBold" depending on the weight.
        assert.ok(f.isCustomFont && f.familyName.startsWith(family), `"${w.text}" fell back to ${f.familyName}`);
      }
    }
  })));
  await t.test('a glyph the face lacks is caught', async () => {
    // U+06A2 is outside IBM Plex Sans Arabic: either the runtime refuses, or CDP shows the fallback.
    try {
      const { words } = await inspectWords(env.browser, 'keyword-super', { text: 'ڢڢ نص' }, 1);
      assert.ok(words[0].fonts.some(f => !f.isCustomFont || !f.familyName.startsWith(family)), 'fallback visible to the check');
    } catch (error) {
      assert.match(String(error.message), /MOGRAPH_FONT_FALLBACK/);
    }
  });
});

// ---- template-specific behaviour -------------------------------------------------------------
test('template contracts', { concurrency: 3 }, async t => {
  const env = await sharedBrowser();
  if (env.skip) { t.skip(env.skip); return; }
  const refuse = (template, params, code) => assert.rejects(renderFrames({ template, params, times: [0], profile }), e => e.code === code);

  await t.test('callout-box sits exactly on params.box and refuses without one', async () => {
    const box = [200, 800, 500, 240];
    const { box: crop } = await renderFrames({ template: 'callout-box', params: { box }, times: [0.5], profile });
    const sw = profile.tokens.stroke.callout;
    assert.ok(crop.x <= box[0] - sw && crop.y <= box[1] - sw, 'crop covers the stroke outside the target');
    assert.ok(crop.x + crop.w >= box[0] + box[2] + sw && crop.y + crop.h >= box[1] + box[3] + sw);
    assert.ok(crop.x >= box[0] - sw - 80 && crop.x + crop.w <= box[0] + box[2] + sw + 80, 'and stays tight around it');
    await refuse('callout-box', {}, 'MOGRAPH_PARAM');
  });

  await t.test('brand-chip loads a logo before frame 0 and refuses a missing one', async () => {
    const logo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-logo-')), 'logo.png');
    fs.writeFileSync(logo, solidPng(32, 32, [16, 163, 127]));
    const withLogo = await renderFrames({ template: 'brand-chip', params: { name: 'ChatGPT', logo }, times: [0.5], profile });
    const without = await renderFrames({ template: 'brand-chip', params: { name: 'ChatGPT' }, times: [0.5], profile });
    assert.ok(withLogo.box.w > without.box.w, 'the logo widens the pill');
    assert.deepEqual(safeZoneViolations(withLogo.box, profile), []);
    await refuse('brand-chip', { name: 'ChatGPT', logo: `${logo}.missing` }, 'MOGRAPH_ASSET');
  });

  await t.test('text templates refuse sentences and empty text', async () => {
    await refuse('hook-title', { text: 'واحد اثنان ثلاثة أربعة خمسة ستة' }, 'MOGRAPH_PARAM');
    await refuse('keyword-super', { text: 'واحد اثنان ثلاثة أربعة' }, 'MOGRAPH_PARAM');
    await refuse('number-pop', { value: 'كثير' }, 'MOGRAPH_PARAM');
    await refuse('cta-card', {}, 'MOGRAPH_PARAM');
  });

  await t.test('every layout keeps the default placement clear of platform UI', async () => {
    for (const layout of Object.keys(profile.safeZones.textBands)) {
      for (const template of ['hook-title', 'keyword-super', 'number-pop', 'cta-card', 'brand-chip']) {
        const { box } = await renderFrames({ template, params: { ...CASES[template].params, layout }, times: [0.5], profile });
        assert.deepEqual(safeZoneViolations(box, profile), [], `${template} on ${layout}: ${JSON.stringify(box)}`);
      }
    }
  });
});

/** A tiny solid-colour RGB PNG, so the test needs no fixture file. */
function solidPng(w, h, [r, g, b]) {
  const crc = buf => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
