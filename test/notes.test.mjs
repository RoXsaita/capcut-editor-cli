import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSnapshot, restoreProjectSnapshot, stableJson } from '../src/core.mjs';
import { notesBrief, notesPath, readNotes, updateNotes } from '../src/notes.mjs';
import { main, setOutput } from '../src/cli.mjs';

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-notes-'));
  const project = path.join(temp, 'Notes Project');
  const doc = {
    id: 'TL', name: 'Notes Project', duration: 1_000_000, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920 },
    materials: { videos: [] },
    tracks: [{ id: 'T0', type: 'video', flag: 0, attribute: 0, segments: [] }]
  };
  fs.mkdirSync(project, { recursive: true });
  for (const f of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
    fs.writeFileSync(path.join(project, f), stableJson(doc));
  }
  return { temp, project };
}

function capture(t) {
  const out = { text: '' };
  const restore = setOutput(chunk => { out.text += String(chunk); return true; });
  t.after(restore);
  return out;
}

test('notes: an empty project has an empty log and writes nothing on read', () => {
  const f = fixture();
  assert.deepEqual(readNotes(f.project), { version: 1, accepted: null, rejected: [], decisions: [], outstanding: [] });
  assert.equal(fs.existsSync(notesPath(f.project)), false);
  assert.match(notesBrief(readNotes(f.project)), /Nothing recorded yet/);
});

test('notes: rejections accumulate once each, acceptance replaces, todos close by number', () => {
  const f = fixture();
  updateNotes(f.project, { reject: 'orange captions', why: 'fights the indigo frame' });
  updateNotes(f.project, { reject: 'orange captions', why: 'still fights the frame' });
  updateNotes(f.project, { reject: 'whoosh on every cut', why: 'reads as stock' });
  updateNotes(f.project, { accept: 'white captions, one accent', why: 'reads at phone size' });
  updateNotes(f.project, { accept: 'white captions, indigo accent', why: 'matches the frame' });
  updateNotes(f.project, { decide: 'keep beat 4 despite the stumble', why: 'only take with the number' });
  updateNotes(f.project, { todo: 'shorten the hook' });
  updateNotes(f.project, { todo: 'louder end card' });
  const notes = updateNotes(f.project, { done: '1' });

  assert.deepEqual(notes.rejected.map(item => [item.what, item.why]), [
    ['orange captions', 'still fights the frame'],
    ['whoosh on every cut', 'reads as stock'],
  ]);
  assert.equal(notes.accepted.what, 'white captions, indigo accent');
  assert.equal(notes.outstanding[0].done, true);
  const brief = notesBrief(notes, 'Notes Project');
  assert.match(brief, /do not propose these again/);
  assert.match(brief, /- orange captions — still fights the frame/);
  assert.match(brief, /\*\*Accepted look:\*\* white captions, indigo accent — matches the frame/);
  assert.match(brief, /1\. louder end card/);
  assert.doesNotMatch(brief, /shorten the hook/);
});

test('notes: a rejection without a reason, or two changes at once, is refused', () => {
  const f = fixture();
  assert.throws(() => updateNotes(f.project, { reject: 'x' }), { code: 'NOTES_ARGS' });
  assert.throws(() => updateNotes(f.project, { reject: 'x', accept: 'y', why: 'z' }), { code: 'NOTES_ARGS' });
  assert.throws(() => updateNotes(f.project, { todo: 'x', why: 'z' }), { code: 'NOTES_ARGS' });
  assert.throws(() => updateNotes(f.project, { done: '1' }), { code: 'NOTES_ARGS' });
  assert.equal(fs.existsSync(notesPath(f.project)), false);
});

test('notes: a corrupt log is reported, never overwritten', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(notesPath(f.project)), { recursive: true });
  fs.writeFileSync(notesPath(f.project), '{ not json');
  assert.throws(() => readNotes(f.project), { code: 'NOTES_CORRUPT' });
  assert.throws(() => updateNotes(f.project, { todo: 'x' }), { code: 'NOTES_CORRUPT' });
  assert.equal(fs.readFileSync(notesPath(f.project), 'utf8'), '{ not json');
});

test('notes: restoring a snapshot rolls back the draft, not the log', () => {
  const f = fixture();
  const snap = createSnapshot(f.project, 'before-notes');
  updateNotes(f.project, { reject: 'split-screen on the hook', why: 'hides the face on the first word' });
  restoreProjectSnapshot(f.project, snap, { forceRunning: true, backup: false });
  assert.equal(readNotes(f.project).rejected.length, 1);
});

test('capcutctl notes records, prints the brief, and validates --why', async t => {
  const f = fixture();
  const out = capture(t);
  await main(['notes', '--project', f.project, '--reject', 'serif titles', '--why', 'too formal for the channel']);
  assert.equal(JSON.parse(out.text).rejected[0].what, 'serif titles');
  out.text = '';
  await main(['notes', '--project', f.project, '--brief']);
  assert.match(out.text, /^# Creative log — Notes Project/);
  assert.match(out.text, /serif titles — too formal/);
  await assert.rejects(main(['notes', '--project', f.project, '--why', 'orphan']), { code: 'NOTES_ARGS' });
});
