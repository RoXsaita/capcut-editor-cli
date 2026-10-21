import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main, parseArgs, setOutput, shq } from '../src/cli.mjs';
import { buildLayoutSpec } from '../src/layouts.mjs';
import { writeCliProject } from './helpers/cli-project.mjs';
import { tmpDir } from './helpers/tmp.mjs';

/** Split a POSIX command line the way a shell would, for the single-quoting shq() emits. */
function shellWords(line) {
  const words = [];
  let word = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (c === '\\') {
      word = (word ?? '') + line[++i];
    } else if (/\s/.test(c)) {
      if (word != null) words.push(word);
      word = null;
    } else word = (word ?? '') + c;
  }
  if (word != null) words.push(word);
  return words;
}

test('the next step `add` prints can be pasted as is', async t => {
  // It used to omit --row (so `layout broll` refused it) and leave a project name with a
  // space unquoted (so a shell split it into two words).
  const temp = tmpDir('capcutctl-add-hint-');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const face = path.join(temp, 'face.mp4');
  const screen = path.join(temp, 'screen.mp4');
  fs.writeFileSync(face, 'fixture face');
  fs.writeFileSync(screen, 'fixture screen');
  const project = writeCliProject(temp, face, { name: 'My Project' });

  let out = '';
  const restore = setOutput(chunk => { out += String(chunk); return true; });
  try {
    await main(['add', '--project', project, '--media', screen, '--at', '1', '--dur', '1', '--track', 'broll',
      '--width', '1920', '--height', '1080', '--media-duration', '5', '--allow-ephemeral', '--no-localize',
      '--force-running', '--no-backup']);
  } finally { restore(); }
  const added = JSON.parse(out).result.find(group => group.group === 'root').operations[0];
  assert.ok(added.layout, 'add prints the layout step');
  assert.match(added.layout, /'[^']*My Project'/, 'a project name with a space is quoted');
  assert.match(added.layout, /--row 540\b/, 'the row defaults to the source centre');

  const words = shellWords(added.layout);
  assert.deepEqual(words.slice(0, 3), ['capcutctl', 'layout', 'broll']);
  const args = parseArgs(words.slice(1));
  assert.equal(args.project, project);
  const doc = JSON.parse(fs.readFileSync(path.join(project, 'draft_info.json'), 'utf8'));
  const track = doc.tracks.findIndex(item => item.name === args.track);
  assert.ok(track >= 0, `the hint names track ${args.track}`);
  const spec = buildLayoutSpec(project, 'broll', { at: [Number(args.at)], track, row: args.row });
  assert.equal(spec.operations.length, 1);
  assert.equal(spec.operations[0].op, 'layout.broll');
  assert.equal(spec.operations[0].selector.id, added.id);
});

test('shq leaves plain words alone and quotes the rest', () => {
  assert.equal(shq('broll'), 'broll');
  assert.equal(shq('/tmp/a/b.mp4'), '/tmp/a/b.mp4');
  assert.equal(shq('My Project'), "'My Project'");
  assert.equal(shq("it's"), `'it'\\''s'`);
});
