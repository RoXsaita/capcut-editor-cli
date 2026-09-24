/**
 * The project's creative log: what was tried and rejected, what landed and why, what was
 * decided, and what is still owed.
 *
 * An edit runs over several sessions and several agents. The reasons behind it ("the user
 * rejected the orange palette — it fought the indigo frame"; "keep beat 4 even though it
 * stumbles, it is the only take with the number") lived in one agent's context and were
 * gone after a compaction or a new session, so the next round proposed the rejected look
 * again. Other agent editors converged on the same fix: a small, durable log keyed to the
 * footage that every round reads first.
 *
 * It is stored in the project's own `.capcutctl/notes.json`, beside the snapshots and
 * outside them: restoring a snapshot rolls the timeline back, never the history of why.
 * CapCut never reads the directory. Writing it is not a transactional edit of the draft.
 */
import fs from 'node:fs';
import path from 'node:path';

import { CapcutError, managedFile } from './core.mjs';

const RELATIVE = path.join('.capcutctl', 'notes.json');
const MAX_TEXT = 2000;

const empty = () => ({ version: 1, accepted: null, rejected: [], decisions: [], outstanding: [] });

export function notesPath(projectDir) {
  return managedFile(projectDir, RELATIVE);
}

function text(value, flag) {
  const out = String(value ?? '').trim();
  if (!out) throw new CapcutError(`${flag} needs text.`, { code: 'NOTES_ARGS', exitCode: 2 });
  if (out.length > MAX_TEXT) throw new CapcutError(`${flag} is longer than ${MAX_TEXT} characters.`, { code: 'NOTES_ARGS', exitCode: 2 });
  return out;
}

/**
 * A log that does not parse is never silently replaced: history is the point of the file,
 * and an empty fallback written back would erase it. Reading reports it; writing refuses.
 */
export function readNotes(projectDir) {
  const file = notesPath(projectDir);
  if (!fs.existsSync(file)) return empty();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    throw new CapcutError(`The creative log at ${file} does not parse (${error.message}). Fix or move it; it was not overwritten.`,
      { code: 'NOTES_CORRUPT', exitCode: 2 });
  }
  const base = empty();
  return {
    ...base,
    ...parsed,
    rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    outstanding: Array.isArray(parsed.outstanding) ? parsed.outstanding : [],
  };
}

function writeNotes(projectDir, notes) {
  const file = notesPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(notes, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/**
 * Apply one change. Exactly one of reject / accept / decide / todo / done.
 * Re-recording the same rejection updates its reason instead of adding a duplicate:
 * a re-run must not inflate the history the next round reads.
 */
export function updateNotes(projectDir, change, { now = new Date() } = {}) {
  const kinds = ['reject', 'accept', 'decide', 'todo', 'done'].filter(key => change[key] != null);
  if (kinds.length !== 1) {
    throw new CapcutError('notes takes exactly one of --reject, --accept, --decide, --todo or --done.', { code: 'NOTES_ARGS', exitCode: 2 });
  }
  const [kind] = kinds;
  if ((kind === 'reject' || kind === 'accept') && change.why == null) {
    throw new CapcutError(`notes --${kind} needs --why: the reason is what stops the next round repeating it.`, { code: 'NOTES_ARGS', exitCode: 2 });
  }
  if ((kind === 'todo' || kind === 'done') && change.why != null) {
    throw new CapcutError(`notes --${kind} does not take --why.`, { code: 'NOTES_ARGS', exitCode: 2 });
  }
  const notes = readNotes(projectDir);
  const at = now.toISOString();
  if (kind === 'reject') {
    const what = text(change.reject, '--reject');
    const why = text(change.why, '--why');
    const existing = notes.rejected.find(item => item.what === what);
    if (existing) Object.assign(existing, { why, at });
    else notes.rejected.push({ what, why, at });
  } else if (kind === 'accept') {
    notes.accepted = { what: text(change.accept, '--accept'), why: text(change.why, '--why'), at };
  } else if (kind === 'decide') {
    const entry = { what: text(change.decide, '--decide'), at };
    if (change.why != null) entry.why = text(change.why, '--why');
    notes.decisions.push(entry);
  } else if (kind === 'todo') {
    notes.outstanding.push({ what: text(change.todo, '--todo'), at, done: false });
  } else {
    const open = notes.outstanding.filter(item => !item.done);
    const index = Number(change.done);
    if (!Number.isInteger(index) || index < 1 || index > open.length) {
      throw new CapcutError(`notes --done takes the number of an open item (1-${open.length || 0}).`, { code: 'NOTES_ARGS', exitCode: 2 });
    }
    Object.assign(open[index - 1], { done: true, doneAt: at });
  }
  writeNotes(projectDir, notes);
  return notes;
}

/** The log as text to paste into the next brief (or read at the start of a session). */
export function notesBrief(notes, projectName = null) {
  const lines = [`# Creative log${projectName ? ` — ${projectName}` : ''}`, ''];
  const open = notes.outstanding.filter(item => !item.done);
  if (!notes.accepted && !notes.rejected.length && !notes.decisions.length && !open.length) {
    lines.push('Nothing recorded yet.');
    return `${lines.join('\n')}\n`;
  }
  if (notes.accepted) lines.push(`**Accepted look:** ${notes.accepted.what} — ${notes.accepted.why}`, '');
  if (notes.rejected.length) {
    lines.push('**Already tried and rejected — do not propose these again:**');
    for (const item of notes.rejected) lines.push(`- ${item.what} — ${item.why}`);
    lines.push('');
  }
  if (notes.decisions.length) {
    lines.push('**Decisions:**');
    for (const item of notes.decisions) lines.push(`- ${item.what}${item.why ? ` — ${item.why}` : ''}`);
    lines.push('');
  }
  if (open.length) {
    lines.push('**Outstanding:**');
    open.forEach((item, i) => lines.push(`${i + 1}. ${item.what}`));
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
