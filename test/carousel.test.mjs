import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyTopic, scanReels, logVerdicts, median, hostToVt, readTake, readableCrop, validateSpec, planPack,
  shotTextPx, qaPack, checkPrivacy, EXTRA_PRIVACY_RULES, stagePack, indexHtml, arabicNumeral, MIN_TEXT_PX, slideData, DEFAULT_LABELS,
  resolveRules, resolveTheme, shotWidth, edgeCut, layoutProblems, altText, CANVASES, DEFAULT_RULES, TIKTOK_CANVAS,
} from '../src/carousel.mjs';

// Synthetic captions in the style the trigger has to read (Levantine Arabic + English names).
const SETUP_SLASH = 'ثلاث حركات للحد من استهلاك الأداة:\nاكتبوا /compact-now بأول الجلسة، وشغّلوا وضع المراجع.';
const SETUP_PLAIN = 'الأداة صارت مجانية بدون حساب.\nبتقدروا تختاروا الموديل من الإعدادات، وإذا ما ظهر اعملوا تحديث.';
const SETUP_MONEY = 'إذا عندك اشتراك، فيك تطالب برصيد لحد ١٠٠ دولار.\nافتح التطبيق واكتب /claim واتبع الخطوات.';
const STORY_MONEY = 'المساعد فاوض المتجر عني ورجّعلي ٤٠ دولار على طاولة مكسورة.\nاكتبوا «دليل» بالتعليقات إذا بدكم البرومبت.';
const STORY_PLAIN = 'المساعد ساعدني ألاقي قطعة بديلة للباب من صورة.\nما كنت بعرف اسمها، وبعد أسبوع وصلت.';
const STORY_TOLD_SETUP = 'خليت المساعد يقدّم على وظائف عني.\nقرأ خبراتي وعدّل السيرة حسب كل وظيفة.';
const STORY_KEYWORD_ONLY = 'خليت المساعد يرتّب ملفاتي القديمة.\nبدكم الشرح؟ اكتبولي «ملفات» بالتعليقات.';

test('classifyTopic: steps the viewer repeats are setups, outcomes are stories', () => {
  assert.equal(classifyTopic(SETUP_SLASH).kind, 'setup');
  assert.equal(classifyTopic(SETUP_PLAIN).kind, 'setup');
  assert.equal(classifyTopic(SETUP_MONEY).kind, 'setup', 'money with an explicit slash command is still a setup');
  assert.equal(classifyTopic(STORY_MONEY).kind, 'story');
  // A first-person telling without an outcome is for a human: such reels have had winning guide twins.
  assert.equal(classifyTopic(STORY_PLAIN).kind, 'unsure');
  assert.equal(classifyTopic(STORY_TOLD_SETUP).kind, 'unsure');
  assert.ok(classifyTopic(SETUP_SLASH).cues.setup.includes('slash-command'));
  // شغل is also the noun "work": a showcase about "the work in the video" is not an instruction.
  assert.deepEqual(classifyTopic('جرّبت الأداة على فيديو، وفيه شغل موشن كتير.').cues.setup, []);
});

test('classifyTopic: the keyword CTA line is not a step', () => {
  // "اكتبولي «…» بالتعليقات" is an imperative, but it is the CTA, not a setup cue.
  const result = classifyTopic(STORY_KEYWORD_ONLY);
  assert.notEqual(result.kind, 'setup');
  assert.deepEqual(result.cues.setup, []);
});

const reel = (id, hoursAgo, reach, caption, fetchedAt) => ({
  id, media_product_type: 'REELS', reach, caption,
  timestamp: new Date(new Date(fetchedAt).getTime() - hoursAgo * 3.6e6).toISOString(),
});

test('scanReels: the baseline is the median of the OTHER reels, judged in the first day', () => {
  const at = '2026-10-19T20:00:00Z';
  const posts = [
    reel('a', 26, 2100, SETUP_SLASH, at),
    reel('b', 20, 5000, STORY_MONEY, at),
    reel('c', 30, 900, SETUP_PLAIN, at),
    reel('d', 300, 2000, SETUP_PLAIN, at),
    reel('e', 400, 1800, STORY_PLAIN, at),
    { id: 'f', media_product_type: 'FEED', reach: 99999, caption: SETUP_SLASH, timestamp: at },
  ];
  const verdicts = Object.fromEntries(scanReels({ posts, fetchedAt: at }).map(v => [v.postId, v]));
  assert.equal(verdicts.a.verdict, 'twin');
  assert.equal(verdicts.a.median, median([5000, 900, 2000, 1800]));
  assert.ok(verdicts.a.margin > 0);
  assert.equal(verdicts.b.verdict, 'story-no-twin');
  assert.equal(verdicts.b.reason, 'story, no twin');
  assert.equal(verdicts.c.verdict, 'below-median');
  assert.equal(verdicts.d.verdict, 'too-old');
  assert.equal(verdicts.f, undefined, 'feed posts are not reels');
});

test('scanReels: a dated snapshot from the first day still qualifies a reel found late', () => {
  const at = '2026-10-19T20:00:00Z';
  const posts = [reel('late', 72, 9000, SETUP_SLASH, at), reel('x', 200, 1000, '', at), reel('y', 300, 1200, '', at)];
  const published = posts[0].timestamp;
  const snapshots = [{ post_id: 'late', reach: 4000, snapshot_ts: new Date(new Date(published).getTime() + 20 * 3.6e6).toISOString() }];
  const [late] = scanReels({ posts, snapshots, fetchedAt: at }).filter(v => v.postId === 'late');
  assert.equal(late.verdict, 'twin');
  assert.equal(late.reach, 4000);
  assert.equal(late.ageHours, 20);
});

test('logVerdicts appends each (post, verdict) once and skips the uninteresting ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carousel-log-'));
  const file = path.join(dir, 'nested', 'twins.jsonl');
  const verdicts = [
    { postId: '1', verdict: 'twin', reason: 'r', reach: 3, median: 2, kind: 'setup' },
    { postId: '2', verdict: 'story-no-twin', reason: 'story, no twin', reach: 3, median: 2, kind: 'story' },
    { postId: '3', verdict: 'below-median', reason: 'r', reach: 1, median: 2, kind: 'setup' },
  ];
  assert.equal(logVerdicts(file, verdicts).length, 2);
  assert.equal(logVerdicts(file, verdicts).length, 0, 'the second scan logs nothing new');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.verdict), ['twin', 'story-no-twin']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hostToVt interpolates between recorded frames and clamps at the ends', () => {
  const frames = [{ host: 100, vt: 0 }, { host: 101, vt: 1 }, { host: 103, vt: 2 }];
  assert.equal(hostToVt(frames, 99), 0);
  assert.equal(hostToVt(frames, 100.5), 0.5);
  assert.equal(hostToVt(frames, 102), 1.5);
  assert.equal(hostToVt(frames, 200), 2);
});

function fakeTake() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carousel-take-'));
  fs.writeFileSync(path.join(dir, 'screen.mp4'), '');
  fs.writeFileSync(path.join(dir, 'frames.ndjson'), [0, 1, 2, 3, 4].map(i => JSON.stringify({ host: 50 + i, vt: i })).join('\n'));
  const trace = [
    { type: 'focus_change', host: 50, app: 'Anything' },
    { type: 'title_change', host: 50.5, title: 'person — shell' },
    { type: 'click', id: 7, host: 51.5, in_capture: true, at: { src_px: { x: 300, y: 200 } }, over: { app: 'Dock' } },
    { type: 'click', id: 8, host: 52, in_capture: false, at: { src_px: { x: 10, y: 10 } } },
    { type: 'click', id: 9, host: 52.2, in_capture: true, at: { src_px: { x: 5000, y: 10 } } },
    { type: 'typing_burst', id: 12, host: 52.5, start: 52.5, end: 53.25, keys: 9 },
  ];
  fs.writeFileSync(path.join(dir, 'trace.ndjson'), trace.map(e => JSON.stringify(e)).join('\n') + '\nnot json\n');
  return dir;
}
const probe = () => ({ width: 1200, height: 800 });

test('readTake keeps real in-capture clicks and typing bursts, never titles or click targets', () => {
  const dir = fakeTake();
  const take = readTake(dir, { probe });
  assert.deepEqual(take.steps, [
    { id: 7, type: 'click', vt: 1.5, x: 300, y: 200 },
    { id: 12, type: 'typing', vt: 3.25, keys: 9 },
  ]);
  assert.doesNotMatch(JSON.stringify(take), /person|Dock/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readableCrop sizes the window so source text reaches MIN_TEXT_PX, clamped to the frame', () => {
  const crop = readableCrop({ x: 10, y: 790 }, { width: 1200, height: 800 }, { textPx: 18 });
  assert.equal(crop.w, Math.floor(1080 * 18 / MIN_TEXT_PX));
  assert.equal(crop.x, 0);
  assert.equal(crop.y + crop.h, 800);
  assert.equal(crop.scale, 2);
});

const spec = takeDir => ({
  slug: 'demo-guide-v1', handle: 'demo',
  slides: [
    { kind: 'cover', headline: 'وعد قصير', needs: ['أداة'] },
    { kind: 'step', headline: 'اضغط هون', shot: { take: takeDir, click: 7, crop: [100, 100, 540, 300] } },
    { kind: 'step', headline: 'اكتب الأمر', shot: { take: takeDir, typing: 12, crop: [0, 0, 600, 200], highlight: [10, 10, 100, 20] } },
    { kind: 'step', headline: 'خطوة', shot: { take: takeDir, t: 2, crop: [0, 0, 1200, 100] } },
    { kind: 'prompt', headline: 'انسخ', blocks: [{ text: '/do-it' }] },
    { kind: 'cta', headline: 'بدك أكثر؟', keyword: 'دليل' },
  ],
});

test('validateSpec enforces the winning structure', () => {
  assert.deepEqual(validateSpec(spec('t')), []);
  const bad = spec('t');
  bad.slides = bad.slides.slice(1, 4);
  bad.slides[0].headline = 'واحد اثنين ثلاثة أربعة خمسة ستة سبعة ثمانية تسعة عشرة أحد عشر اثنا عشر';
  const problems = validateSpec(bad).join('\n');
  assert.match(problems, /6–10 slides/);
  assert.match(problems, /slide 1 must be the cover/);
  assert.match(problems, /last slide must be the CTA/);
  assert.match(problems, /prompt slide/);
  assert.doesNotMatch(problems, /comment keyword/, 'a save CTA is fine by default');
  assert.match(validateSpec({ ...bad, rules: { requireKeyword: true } }).join('\n'), /comment keyword/);
  assert.match(problems, /words \(max 7\)/);
});

test('planPack takes time and the click marker from the trace, in slide pixels', () => {
  const dir = fakeTake();
  // A full-bleed theme keeps the arithmetic round: shots are cut 1080 wide.
  const plan = planPack({ ...spec(dir), theme: { cardMargin: 0, cardBorder: 0 } }, { readTakeFn: d => readTake(d, { probe }) });
  assert.deepEqual([plan.canvas.width, plan.canvas.height], [1080, 1440], '3:4 is the default canvas');
  assert.equal(planPack(spec(dir), { readTakeFn: d => readTake(d, { probe }) }).slides[1].shots[0].width, 872, 'by default a shot is cut to the card');
  const [click, typing, plain] = plan.slides.filter(s => s.kind === 'step').map(s => ({ ...s, shot: s.shots[0] }));
  assert.deepEqual([click.number, typing.number, plain.number], [1, 2, 3]);
  assert.equal(click.shot.t, 1.85, 'a click frame is just after the click');
  assert.equal(click.shot.scale, 2);
  assert.deepEqual(click.shot.marker, { x: 400, y: 200 });
  assert.equal(typing.shot.t, 2.95, 'a typing frame is just before the burst ends (Enter clears it)');
  assert.equal(typing.shot.marker, null);
  assert.deepEqual(typing.shot.highlight, [18, 18, 180, 36]);
  assert.equal(plain.shot.height, 90);
  assert.deepEqual(click.shot.warnings, []);
  const outside = spec(dir);
  outside.slides[1].shot.crop = [900, 0, 540, 300];
  assert.throws(() => planPack(outside, { readTakeFn: d => readTake(d, { probe }) }), /leaves the 1200×800 frame/);
  const missing = spec(dir);
  missing.slides[1].shot.click = 8;
  assert.throws(() => planPack(missing, { readTakeFn: d => readTake(d, { probe }) }), /no in-capture click with id 8/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shotTextPx is the median OCR line height inside the shot box', () => {
  const lines = [
    { text: 'inside one', x: 100, y: 500, w: 300, h: 40 },
    { text: 'inside two', x: 100, y: 560, w: 300, h: 30 },
    { text: 'inside three', x: 100, y: 620, w: 300, h: 50 },
    { text: 'headline', x: 100, y: 100, w: 600, h: 90 },
    { text: '•', x: 100, y: 600, w: 5, h: 80 },
  ];
  assert.equal(shotTextPx(lines, { x: 0, y: 450, w: 1080, h: 300 }), 40);
  assert.equal(shotTextPx(lines, null), null);
});

test('qaPack fails small UI text and any privacy rule, by name only', () => {
  const plan = { slides: [{ index: 1, kind: 'step', headline: 'خطوة', shots: [{ warnings: [] }] }, { index: 2, kind: 'cta', headline: 'تابع', shots: [] }] };
  const rendered = [{ index: 1, file: 'a.png', shotBoxes: [{ x: 0, y: 0, w: 1080, h: 400 }] }, { index: 2, file: 'b.png', shotBoxes: [] }];
  const ocr = file => (file === 'a.png' ? [{ text: 'small text', x: 200, y: 100, w: 200, h: 30 }] : [{ text: 'card ending 4242', x: 200, y: 200, w: 100, h: 20 }]);
  const privacy = texts => (texts.some(t => t.includes('card ending')) ? ['billing'] : []);
  const qa = qaPack(plan, rendered, { ocr, privacy });
  assert.equal(qa.verdict, 'FAIL');
  assert.match(qa.slides[0].problems[0], /30 px \(min 36\)/);
  assert.deepEqual(qa.slides[1].privacy, ['billing']);
  assert.doesNotMatch(JSON.stringify(qa), /4242/, 'QA records rule names, never the matched text');
});

test('privacy: home paths, shell prompts and the watcher denylist', () => {
  assert.ok(EXTRA_PRIVACY_RULES['home-path'].test('/Users/someone'));
  assert.ok(EXTRA_PRIVACY_RULES['shell-prompt'].test('[someone@laptop ~ % claude'));
  assert.ok(!EXTRA_PRIVACY_RULES['home-path'].test('Auto-compact window set to 400k tokens'));
  const names = checkPrivacy(['Usage remaining 12%', '/home/someone/project']);
  assert.ok(names.includes('home-path'));
  // The watcher's rules run through tools/watcher/privacy.py when Python is available.
  if (!names.includes('privacy-helper-unavailable')) assert.ok(names.includes('plan-usage'));
});

test('the pack page records take names, never local paths', () => {
  const plan = { slug: 'demo', title: 'Demo', caption: 'c', slides: [{ index: 1, kind: 'step', headline: 'h',
    shots: [{ take: '/private/somewhere/take-1', takeName: 'take-1', video: '/private/somewhere/take-1/screen.mp4' }] }] };
  const html = indexHtml(plan, ['/x/exports/instagram-3x4/slide-01.png']);
  assert.match(html, /exports\/instagram-3x4\/slide-01\.png/);
  assert.doesNotMatch(html, /\/private\/somewhere/);
});

test('slideData uses the profile brand, neutral defaults, and spec labels over the defaults', () => {
  const slide = { kind: 'cta', index: 8, headline: 'h', keyword: 'k' };
  const neutral = slideData(slide, { total: 8 });
  assert.deepEqual([neutral.colors.brand, neutral.colors.accent], ['#3D3D3D', '#FFB020']);
  const own = slideData(slide, { total: 8, tokens: { color: { brand: '#112233', accent: '#445566' } }, labels: { cta: 'comment' } });
  assert.deepEqual([own.colors.brand, own.colors.accent], ['#112233', '#445566']);
  assert.equal(own.labels.cta, 'comment');
  assert.equal(own.labels.eyebrow, DEFAULT_LABELS.eyebrow);
});

test('arabicNumeral', () => {
  assert.equal(arabicNumeral(3), '٣');
  assert.equal(arabicNumeral(12), '١٢');
});

function fakePack(verdict = 'PASS') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carousel-pack-'));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ slug: 'demo-guide-v1', title: 'T', qa: { verdict },
    qa_notes: 'n', source_item_id: 7, captions: { instagram: 'ig', tiktok: 'tt' } }));
  return dir;
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    const [status, body] = handler(init.method, new URL(url).pathname, init.body ? JSON.parse(init.body) : null);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return { fn, calls };
}

test('stagePack: copies, marks draft, creates ONE draft job, and never calls a publish route', async () => {
  const pack = fakePack();
  const posted = [];
  const { fn, calls } = fakeFetch((method, route, body) => {
    if (method === 'GET' && route.endsWith('/publish/jobs')) return [200, []];
    if (method === 'POST') { posted.push(body); return [201, { id: 41, status: 'draft', platforms: body.platforms }]; }
    if (route === '/api/carousels') return [200, { packs: [{ slug: 'demo-guide-v1', slide_count: 8, lifecycle_status: 'draft', source_item_id: 7 }] }];
    return [200, {}];
  });
  let copied = null;
  const result = await stagePack({ pack, dashboard: 'http://dash.test:8000/', remote: 'host:/carousels', item: 7,
    fetchFn: fn, copyFn: (dir, remote, slug) => { copied = { remote, slug }; return { to: `${remote}/${slug}/` }; } });
  assert.deepEqual(copied, { remote: 'host:/carousels', slug: 'demo-guide-v1' });
  assert.deepEqual(calls, ['PATCH /api/carousels/demo-guide-v1/metadata', 'GET /api/carousels/demo-guide-v1/publish/jobs',
    'POST /api/carousels/demo-guide-v1/publish/jobs', 'GET /api/carousels']);
  assert.equal(posted[0].platforms, 'instagram,tiktok');
  assert.equal(posted[0].tiktok_caption, 'tt');
  assert.deepEqual(result.job, { id: 41, status: 'draft', platforms: 'instagram,tiktok', reused: false, captionsUpdated: false });
  assert.equal(result.listed.lifecycle, 'draft');
  assert.ok(calls.every(c => !/\/(instagram|tiktok|youtube|render)$/.test(c)), 'no publish or render route');
  fs.rmSync(pack, { recursive: true, force: true });
});

test('stagePack reuses an active job, refuses a failing pack, and dry-runs without I/O', async () => {
  const pack = fakePack();
  const patched = [];
  const { fn, calls } = fakeFetch((method, route, body) => {
    if (method === 'GET' && route.endsWith('/publish/jobs')) return [200, [{ id: 9, status: 'draft', platforms: 'instagram,tiktok' }]];
    if (method === 'PATCH' && route === '/api/carousels/publish/jobs/9') { patched.push(body); return [200, { id: 9, status: 'draft', platforms: 'instagram,tiktok' }]; }
    if (route === '/api/carousels') return [200, { packs: [] }];
    return [200, {}];
  });
  const result = await stagePack({ pack, dashboard: 'http://dash.test', remote: 'h:/c', fetchFn: fn, copyFn: () => ({}) });
  assert.equal(result.job.reused, true);
  assert.equal(result.job.captionsUpdated, true, 'a restage updates the same draft job in place');
  assert.equal(patched[0].tiktok_caption, 'tt', 'the pack\'s own TikTok caption, as written');
  assert.ok(!calls.some(c => c.startsWith('POST')));

  const dry = await stagePack({ pack, dashboard: 'http://dash.test', remote: 'h:/c', dryRun: true,
    fetchFn: () => { throw new Error('no network in a dry run'); }, copyFn: () => { throw new Error('no copy in a dry run'); } });
  assert.equal(dry.listed, 'dry-run');

  const failing = fakePack('FAIL');
  await assert.rejects(stagePack({ pack: failing, dashboard: 'http://d', remote: 'h:/c', fetchFn: fn, copyFn: () => ({}) }), /QA is FAIL/);
  await assert.rejects(stagePack({ pack, remote: 'h:/c' }), /--dashboard/);
  fs.rmSync(pack, { recursive: true, force: true });
  fs.rmSync(failing, { recursive: true, force: true });
});

test('rules and theme come from the spec, over the defaults', () => {
  const rules = resolveRules({ canvas: '4x5', rules: { minTextPx: 40, minPx: { headline: 80 } } });
  assert.equal(rules.canvas, '4x5');
  assert.equal(rules.minTextPx, 40);
  assert.deepEqual([rules.minPx.headline, rules.minPx.sub], [80, 44], 'a rule block merges over the skill floors');
  assert.equal(rules.inset, 100);
  assert.throws(() => resolveRules({ canvas: '16x9' }), /canvas must be one of/);
  const plain = resolveTheme({});
  assert.equal(plain.name, 'plain');
  assert.ok(fs.existsSync(plain.template));
  assert.ok(plain.fonts.every(f => f.url.startsWith('file:')), 'theme fonts resolve to files');
  const theme = resolveTheme({ theme: { name: 'plain', h1: 80, cardMargin: 40 } });
  assert.equal(theme.vars.h1, 80);
  assert.equal(shotWidth(theme.vars, CANVASES['3x4']), 1080 - 2 * (40 + theme.vars.cardBorder));
  assert.throws(() => resolveTheme({ theme: 'nope' }), /no carousel theme/);
  // A theme folder next to the spec, the way a design session hands one over.
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'carousel-theme-'));
  fs.mkdirSync(path.join(own, 'lab'));
  fs.writeFileSync(path.join(own, 'lab', 'theme.json'), JSON.stringify({ name: 'lab', template: 'slide.html', vars: { h1: 90 } }));
  const lab = resolveTheme({ theme: './lab' }, { specDir: own });
  assert.deepEqual([lab.name, path.basename(lab.template), lab.vars.h1], ['lab', 'slide.html', 90]);
  fs.rmSync(own, { recursive: true, force: true });
  // A scout's carousel need not be a twin: structure rules switch off, the cover need not list needs.
  const loose = spec('t');
  loose.rules = { requirePrompt: false, requireKeyword: false, slideCount: [3, 10] };
  loose.slides = [{ kind: 'cover', headline: 'وعد' }, { kind: 'text', headline: 'فكرة', body: 'نص' }, { kind: 'cta', headline: 'تابع' }];
  assert.deepEqual(validateSpec(loose), []);
});

test('a still image is a shot source too, and step slides carry their move count', () => {
  const still = { ...spec('t'), slides: spec('t').slides.map(s => (s.shot ? { ...s, shot: { image: 'shot.png', crop: [0, 0, 400, 300] } } : s)) };
  const plan = planPack(still, { readStillFn: file => ({ name: path.basename(file), video: file, still: true, width: 800, height: 600, steps: [] }) });
  const step = plan.slides[1];
  assert.equal(step.shots[0].still, true);
  assert.equal(step.shots[0].t, 0);
  assert.equal(step.moves, 3);
  assert.equal(slideData(step, { total: 6 }).kicker, 'الحركة ١ من ٣');
  assert.equal(slideData({ ...step, kicker: '' }, { total: 6 }).kicker, '', 'a spec can drop the kicker');
});

test('edgeCut finds UI text at the shot edge; layoutProblems measures sizes, inset, bottom band and words', () => {
  const box = { x: 60, y: 400, w: 960, h: 600 };
  const lines = [
    { text: 'Auto-compact window', x: 62, y: 500, w: 400, h: 30 },
    { text: 'Select a trigger', x: 200, y: 600, w: 300, h: 30 },
    { text: 'ok', x: 1010, y: 700, w: 20, h: 30 },
    { text: 'headline', x: 20, y: 100, w: 400, h: 60 },
  ];
  assert.deepEqual(edgeCut(lines, box, 20), ['Auto-compact window']);
  const rules = resolveRules({});
  const canvas = CANVASES['3x4'];
  const texts = [
    { role: 'headline', px: 60, rect: { x: 120, y: 120, w: 800, h: 80 }, text: 'اكتب الأمر بكلود كود' },
    { role: 'sub', px: 44, rect: { x: 60, y: 220, w: 800, h: 60 }, text: 'سطر واحد بيشرح ليش' },
    { role: 'after', px: 44, rect: { x: 120, y: 1300, w: 800, h: 60 }, text: 'احفظه' },
    { role: 'footer', px: 30, rect: { x: 120, y: 1310, w: 200, h: 30 }, text: 'handle' },
  ];
  const layout = layoutProblems({ kind: 'step' }, { texts, cards: [] }, rules, canvas).problems.join('\n');
  assert.match(layout, /headline text at 60 px \(min 72\)/);
  assert.match(layout, /inside the 100 px inset: sub/);
  assert.match(layout, /in the bottom 10%: after/);
  assert.doesNotMatch(layout, /footer/, 'the footer may sit in the bottom band');
  const many = [{ role: 'body', px: 44, rect: { x: 120, y: 300, w: 800, h: 400 }, text: Array(31).fill('كلمة').join(' ') }];
  assert.match(layoutProblems({ kind: 'note' }, { texts: many }, rules, canvas).problems.join(), /31 words/);
  assert.deepEqual(layoutProblems({ kind: 'prompt' }, { texts: many }, rules, canvas).problems, [], 'a prompt slide is dense by default');
  const qa = qaPack({ rules, canvas, slides: [{ index: 1, kind: 'step', headline: 'h', shots: [{ warnings: [] }] }] },
    [{ index: 1, file: 'a.png', shotBoxes: [box], cardBoxes: [{ ...box, h: 500 }], texts: [] }], { ocr: () => lines.slice(0, 2), privacy: () => [] });
  assert.match(qa.slides[0].problems.join('\n'), /fills 35% of the slide \(min 55%\)/);
  assert.match(qa.slides[0].problems.join('\n'), /text cut at the shot's edge/);
});

test('compare, proof and note slides; alt text; the TikTok canvas keeps its bottom tenth clear', () => {
  const base = spec('t');
  const shot = { image: 'a.png', crop: [0, 0, 400, 300] };
  base.slides.splice(4, 0,
    { kind: 'compare', headline: 'قبل وبعد', shots: [{ ...shot, label: 'قبل' }, { ...shot, label: 'بعد', alt: 'the result' }] },
    { kind: 'proof', headline: 'الإيصال', figure: '$150', shot: { ...shot, alt: 'a receipt' } },
    { kind: 'note', headline: 'انتبه', items: ['واحد', 'اثنين'] });
  assert.deepEqual(validateSpec(base), []);
  const bad = spec('t');
  bad.slides.splice(4, 0, { kind: 'compare', headline: 'قبل وبعد', shots: [shot] }, { kind: 'proof', headline: 'الإيصال' });
  const problems = validateSpec(bad).join('\n');
  assert.match(problems, /compare slide has shots: \[two shots, each with a label\]/);
  assert.match(problems, /proof slide needs a real shot/);
  const take = { name: 't', video: 'v.mp4', width: 1200, height: 800, steps: [{ id: 7, type: 'click', vt: 1.5, x: 400, y: 300 }, { id: 12, type: 'typing', vt: 3.25 }] };
  const plan = planPack(base, { readTakeFn: () => take, readStillFn: file => ({ name: path.basename(file), video: file, still: true, width: 800, height: 600, steps: [] }) });
  const compare = plan.slides.find(s => s.kind === 'compare');
  assert.equal(compare.shots.length, 2);
  assert.equal(slideData(compare, { total: 9, shotUrls: ['u1', 'u2'] }).shots[1].label, 'بعد');
  assert.equal(altText(plan.slides.find(s => s.kind === 'proof')), 'الإيصال — a receipt');
  assert.equal(altText({ headline: 'اكتب `/advisor`', shots: [] }), 'اكتب /advisor');
  const top = Math.floor((TIKTOK_CANVAS.height * 0.9 - 1440) / 2);
  assert.ok(top + 1440 <= TIKTOK_CANVAS.height * 0.9, 'a 3:4 slide ends above the bottom tenth');
});
