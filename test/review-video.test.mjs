import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CHUNK, prepareScript } from '../src/gemini-page.mjs';
import {
  audioCheck, collectIssues, decideIssue, driverPrompt, extractReviewJson, foldReview, normaliseArabic, parseDriverText,
  reviewVideo, soundCheck, toolResultTexts,
  driverEnv,
} from '../src/review-video.mjs';

const WORDS = 'كلود استخدم جهازي زي كأنه بني آدم عشان يعملي منتاج لفيديو'.split(' ').map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35 }));

const REVIEW = {
  hook: { what_viewer_sees_0_2s: 'face and a laptop', result_or_proof_visible_by_2s: false, makes_sense_without_sound: true, fix: 'show the result first' },
  promise_vs_payoff: { hook_promises: 'x', video_delivers: 'x', match: true },
  confusing_moments: [],
  unreadable_screen_moments: [{ timestamp: '00:02', issue: 'tiny prompt text [cite: 1]', fix: 'zoom' }],
  caption_problems: [{ timestamp: '00:01', issue: 'caption over face', fix: 'move down' }],
  audio_problems: [],
  ending: { last_word_clipped: false, follow_ender_present: true, notes: '' },
  first_spoken_sentence: 'استخدم جهازي زي كأنه بني آدم عشان يعمل لي مونتاج لفيديو',
  blockers: ['caption over face', 'black frame at 00:03'],
};

/** stream-json lines a driver session would print, carrying the answer in CHUNK slices. */
function driverLines(answer, { model = 'Auto + High', extra = [] } = {}) {
  const ser = Buffer.from(JSON.stringify(answer), 'utf8').toString('base64');
  const n = Math.ceil(ser.length / CHUNK);
  const result = text => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: `${text}\n\nTab Context: …` }] }] } });
  return [
    result(`CAPCUTCTL ${JSON.stringify({ state: 'ready', model, href: 'https://gemini.google.com/app' })}`),
    ...extra.map(result),
    result(`CAPCUTCTL ${JSON.stringify({ state: 'done', href: 'https://gemini.google.com/app/abc', chunks: n })}`),
    ...Array.from({ length: n }, (_, i) => result(`CAPCUTCTL_CHUNK ${i} ${ser.slice(i * CHUNK, (i + 1) * CHUNK)}`)),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'CAPCUTCTL {"state":"done","chunks":99}' }] } }),
  ];
}

const answerFor = review => ({ raw: `JSON\n${JSON.stringify(review)}`, json: JSON.stringify(review) });

test('the driver transcript is read from tool results only, and the chunks reassemble the answer exactly', () => {
  const answer = answerFor(REVIEW);
  const parsed = parseDriverText(toolResultTexts(driverLines(answer)));
  assert.deepEqual(parsed.answer, answer);
  assert.ok(!driverLines(answer).some(l => l.includes('CAPCUTCTL_CHUNK') && /caption over face|استخدم/.test(l)),
    'the driver never sees the answer as text');
  assert.equal(parsed.model, 'Auto + High');
  assert.equal(parsed.href, 'https://gemini.google.com/app/abc');
  const lines = driverLines(answer);
  const missing = parseDriverText(toolResultTexts(lines.filter(l => !l.includes('CAPCUTCTL_CHUNK 1 '))));
  assert.equal(missing.answer, null);
  assert.equal(missing.missing, 1);
});

test('Arabic is compared without diacritics, alef forms, taa marbuta or alif maqsura', () => {
  assert.deepEqual(normaliseArabic('مُونْتَاجٌ أَإِآ مدرسة على'), ['مونتاج', 'ااا', 'مدرسه', 'علي']);
});

test('the sound check passes a close quote of the first sentence and discards an invented one', () => {
  const ok = soundCheck(REVIEW.first_spoken_sentence, WORDS);
  assert.equal(ok.ok, true);
  assert.ok(ok.score >= 0.8, String(ok.score));
  assert.equal(soundCheck('مرحبا بكم في قناتي اليوم', WORDS).ok, false);
  assert.equal(soundCheck('', WORDS).ok, false);
  assert.equal(soundCheck('استخدم', WORDS).ok, false, 'one word is not proof');
  const skimmed = soundCheck('استخدم كأنه آدم يعملي لفيديو', WORDS);
  assert.equal(skimmed.ok, false, 'real words read off captions, skipping half, are not a listen');
  assert.equal(skimmed.coverage, 0.5);
});

test('JSON comes out of the code block, a fence, or the outer braces, with cite markers gone', () => {
  assert.equal(extractReviewJson({ json: JSON.stringify(REVIEW) }).unreadable_screen_moments[0].issue, 'tiny prompt text');
  assert.ok(extractReviewJson({ raw: `here:\n\`\`\`json\n${JSON.stringify(REVIEW)}\n\`\`\`` }));
  assert.ok(extractReviewJson({ raw: `noise ${JSON.stringify(REVIEW)} noise` }));
  assert.equal(extractReviewJson({ raw: 'I cannot watch videos.' }), null);
});

test('issues: a blocker flags the matching timed issue; one with no match stands alone', () => {
  const issues = collectIssues(REVIEW, { duration: 20 });
  const caption = issues.find(i => i.kind === 'caption');
  assert.equal(caption.blocker, true);
  assert.equal(caption.t, 1);
  assert.equal(issues.find(i => i.kind === 'hook').blocker, false);
  const black = issues.find(i => i.kind === 'blocker');
  assert.equal(black.t, 3);
  assert.equal(issues.filter(i => i.blocker).length, 2);
});

test('the driver prompt carries the scripts verbatim and the files to upload', () => {
  const prompt = driverPrompt({ run: 'r1', files: ['/a/review-proxy.mp4', '/a/review-instructions.txt'] });
  assert.ok(prompt.includes(prepareScript('r1')));
  assert.match(prompt, /review-proxy\.mp4","\/a\/review-instructions\.txt/);
  assert.match(prompt, /SCRIPT_CHUNK[\s\S]*__I__/);
  assert.doesNotMatch(driverPrompt({ run: 'r1', followUp: 'https://gemini.google.com/app/abc' }), /file_upload with/);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-review-'));
  const media = path.join(dir, 'final.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=270x480:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=duration=4',
    '-shortest', '-c:v', 'libx264', '-c:a', 'aac', media]);
  const speech = path.join(dir, 'speech.json');
  fs.writeFileSync(speech, JSON.stringify({ words: WORDS }));
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  return { dir, media, speech, project };
}

test('a review round end to end with a fake driver: log, evidence, decisions, gate fold, round limit', { skip: !hasFfmpeg }, async () => {
  const { media, speech, project } = fixture();
  const seen = [];
  const driver = async options => { seen.push(options); return { lines: driverLines(answerFor(REVIEW)), code: 0, stderr: '' }; };
  const record = await reviewVideo({ media, speech, projectDir: project, driver });
  assert.equal(record.status, 'pending');
  assert.equal(record.model, 'Auto + High');
  assert.equal(record.round, 1);
  assert.ok(fs.statSync(record.proxy.file).size < 10 * 1024 * 1024);
  assert.ok(fs.readFileSync(path.join(path.dirname(record.file), 'review-instructions.txt'), 'utf8').startsWith('You are an independent reviewer'));
  assert.deepEqual(seen[0].prompt.match(/paths (\[.*?\])/)[1], JSON.stringify([record.proxy.file, path.join(path.dirname(record.file), 'review-instructions.txt')]));
  const caption = record.issues.find(i => i.kind === 'caption');
  assert.ok(caption.evidence.length && fs.existsSync(caption.evidence[0]));

  const report = () => ({ checks: [] });
  let folded = foldReview(report(), record.file);
  assert.equal(folded.checks.find(c => c.id === 'review').ok, false, 'undecided blockers block');
  for (const i of record.issues.filter(x => x.blocker)) decideIssue(record.file, i.id, 'rejected', 'not in the frames');
  folded = foldReview(report(), record.file);
  assert.equal(folded.checks.find(c => c.id === 'review').ok, true);
  assert.equal(folded.checks.find(c => c.id === 'review-log').ok, false, 'undecided advice warns');
  decideIssue(record.file, record.issues.find(i => i.kind === 'caption').id, 'accepted', 'covers the mouth at 0:01');
  assert.equal(foldReview(report(), record.file).checks.find(c => c.id === 'review').ok, false, 'an accepted blocker blocks');
  assert.throws(() => decideIssue(record.file, 'G1', 'accepted', ''), /reason/);

  const second = await reviewVideo({ media, speech, projectDir: project, driver });
  await assert.rejects(reviewVideo({ media, speech, projectDir: project, driver }),
    error => /hand off/.test(error.message) && error.code === 'REVIEW_ROUNDS_EXHAUSTED' && error.lastFile === second.file,
    'the skip names the last counted review, for export to quote');
});

test('a review that cannot quote the first sentence is discarded and blocks; bad JSON gets one follow-up', { skip: !hasFfmpeg }, async () => {
  const { media, speech, project } = fixture();
  const deaf = { ...REVIEW, first_spoken_sentence: 'مرحبا بكم في قناتي اليوم' };
  const deafDriver = async () => ({ lines: driverLines(answerFor(deaf)), code: 0, stderr: '' });
  const record = await reviewVideo({ media, speech, projectDir: project, driver: deafDriver });
  assert.equal(record.status, 'discarded');
  assert.deepEqual(record.issues, []);
  assert.equal(foldReview({ checks: [] }, record.file).checks[0].ok, false);
  const retry = await reviewVideo({ media, speech, projectDir: project, driver: deafDriver });
  assert.equal(retry.round, 1, 'a discarded review does not use up a round');
  assert.match(retry.file, /round-1-retry1/);
  await assert.rejects(reviewVideo({ media, speech, projectDir: project, driver: deafDriver }), /sound check 2 times/);

  const calls = [];
  const driver = async options => { calls.push(options.prompt.includes('file_upload with') ? 'upload' : 'follow-up');
    return { lines: driverLines(calls.length === 1 ? { raw: 'Sorry, here is my review in prose.', json: null } : answerFor(REVIEW)), code: 0, stderr: '' }; };
  const second = await reviewVideo({ media, speech, driver });
  assert.deepEqual(calls, ['upload', 'follow-up']);
  assert.equal(second.followedUp, true);
});

test('a login wall, a refused upload and a missing transcript fail by name', { skip: !hasFfmpeg }, async () => {
  const { media, speech, dir } = fixture();
  const wall = async () => ({ lines: [JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'CAPCUTCTL {"state":"login"}' }] } })], code: 0, stderr: '' });
  await assert.rejects(reviewVideo({ media, speech, driver: wall }), /sign-in wall/);
  const refused = async () => ({ lines: [JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Cannot upload "/x": only files this session is allowed to read can be uploaded.' }] } })], code: 0, stderr: '' });
  await assert.rejects(reviewVideo({ media, speech, driver: refused }), /refused the upload/);
  fs.rmSync(path.join(dir, 'speech.json'));
  await assert.rejects(reviewVideo({ media, driver: wall }), /no transcript/);
});

test('the audio-only answer is decisive when the draft has music at the end, inconclusive otherwise', () => {
  assert.equal(audioCheck({ music_in_last_2s: true }, { musicAtEnd: true }).ok, true);
  assert.equal(audioCheck({ music_in_last_2s: false }, { musicAtEnd: true }).ok, false, 'a muted listen says no music');
  assert.equal(audioCheck({}, { musicAtEnd: true }).ok, false, 'no answer is no proof');
  assert.equal(audioCheck({ music_in_last_2s: true }, { musicAtEnd: false }).ok, false, 'music the draft lacks is invented');
  const none = audioCheck({ music_in_last_2s: false }, { musicAtEnd: false });
  assert.equal(none.ok, true);
  assert.match(none.detail, /inconclusive/);
  assert.match(audioCheck({ music_in_last_2s: true }, null).detail, /no draft/);
});


test('the review never uses the Gemini API: no keys reach the driver, no API endpoint on the review path', () => {
  const env = driverEnv({ PATH: '/bin', HOME: '/h', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'k', GOOGLE_CLOUD_PROJECT: 'p', ANTHROPIC_API_KEY: 'a' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
  for (const file of ['review-video.mjs', 'gemini-page.mjs']) {
    const src = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /generativelanguage|aiplatform\.googleapis|@google\/genai|geminiApiKey|music\.mjs/, file);
  }
});
