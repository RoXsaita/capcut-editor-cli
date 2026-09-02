import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * Claims the documentation makes about itself, held to the code.
 *
 * These drifted quietly and all at once: package.json said 0.1.0 while the README talked
 * about 0.1.1, SETUP.md told a stranger to authenticate against private repositories that
 * had been public for a week, and docs/PRE-PUBLISH.md said the repository "stays private"
 * on a page anyone could read. None of it breaks a command, which is exactly why nothing
 * caught it. A test does.
 */

const packageJson = JSON.parse(read('package.json'));

test('one version number, agreed across package metadata, pyproject and the README', () => {
  const version = packageJson.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);

  const pyproject = read('pyproject.toml');
  const declared = pyproject.match(/^version = "([^"]+)"$/m);
  assert.ok(declared, 'pyproject must declare a [project] version');
  assert.equal(declared[1], version, 'pyproject and package.json must agree');

  // The README talks about this project's versions in prose ("Since 0.1.1 it also…").
  // Every one it names must already exist — not a number typed ahead of the bump and
  // then forgotten. Scoped to those two phrasings on purpose: the page also names third
  // party versions (Python 3.9.6, Node 20) that have nothing to do with this one.
  const readme = read('README.md');
  const ordinal = text => text.split('.').map(Number);
  const ahead = (a, b) => {
    const [left, right] = [ordinal(a), ordinal(b)];
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] > right[index];
    }
    return false;
  };
  const mentions = [...readme.matchAll(/\b(?:[Ss]ince|v)(?:\s+)?(\d+\.\d+\.\d+)\b/g)];
  assert.ok(mentions.length, 'the README should say which version it describes');
  for (const [, mentioned] of mentions) {
    assert.ok(!ahead(mentioned, version),
      `README refers to ${mentioned}, which is ahead of the released ${version}`);
  }

  // The release doc's worked example must use the number that is actually current.
  assert.match(read('docs/PRE-PUBLISH.md'), new RegExp(`v${version.replace(/\./g, '\\.')}`));
});

test('the documentation does not describe these repositories as private', () => {
  // Both repositories are public. Telling a reader to `gh auth login` before cloning sends
  // them looking for permission they do not need and cannot be granted.
  for (const file of ['README.md', 'SETUP.md', 'CONTRIBUTING.md', 'docs/PRE-PUBLISH.md']) {
    const claims = read(file).split('\n').filter(line =>
      /\b(repositor|repo)\w*\b[^.]*\bprivate\b/i.test(line)
      || /\bprivate\b[^.]*\b(repositor|repo)\w*/i.test(line));
    const allowed = line =>
      // A GitHub security feature, not a visibility claim.
      /private vulnerability reporting/i.test(line)
      // The historical record of what was true before publication, in the past tense.
      || /was flipped from private|before going public/i.test(line)
      // The npm `"private": true` flag, which is unrelated to repository visibility.
      || /"private":\s*true/.test(line)
      // A line that says "public" in the same breath is not claiming the opposite.
      || /\bpublic\b/i.test(line);
    assert.deepEqual(claims.filter(line => !allowed(line)), [],
      `${file} still describes the repositories as private`);
  }
});

test('"private": true is npm publish protection, and is documented as such', () => {
  // Keeping the flag is a decision. If someone removes it, this test should make them
  // notice that the reasoning in docs/PRE-PUBLISH.md needs removing in the same commit.
  const release = read('docs/PRE-PUBLISH.md');
  if (packageJson.private === true) {
    assert.match(release, /"private": true/,
      'if package.json is private, the release doc must say why');
    assert.match(release, /npm publish/i);
  } else {
    assert.doesNotMatch(release, /`"private": true` in package.json — deliberate/,
      'the flag is gone; remove the section that explains why it is there');
  }
});

test('every README section another document points at still exists', () => {
  // SETUP.md said "See README → *Style — ask once*" for two releases after that heading was
  // renamed. A pointer to a section that is not there costs a stranger a search and tells
  // them the docs are not maintained. Bold or italic "See <Heading> in the README" /
  // "README → *Heading*" must name a real heading.
  const headings = new Set(read('README.md').split('\n')
    .filter(line => /^#{2,3} /.test(line))
    .map(line => line.replace(/^#+\s*/, '').trim()));
  for (const file of ['SETUP.md', 'CONTRIBUTING.md', 'docs/PRE-PUBLISH.md']) {
    const text = read(file);
    const pointers = [
      ...text.matchAll(/README(?:\.md)?\s*→\s*[*_]([^*_]+)[*_]/g),
      ...text.matchAll(/See\s+\*\*([^*]+)\*\*\s+in the README/g),
    ].map(match => match[1].trim());
    for (const pointer of pointers) {
      assert.ok(headings.has(pointer), `${file} points at README → "${pointer}", which is not a README heading`);
    }
  }
});

test('the layouts the help text lists are the ones presets/layouts.json defines', () => {
  // SETUP.md said "the four locked layouts" while layouts.json defined five and the help
  // text listed three. The preset file is the record; the help and the layout list output
  // must name exactly its layouts.
  const layouts = JSON.parse(read('presets/layouts.json'));
  const names = [...Object.keys(layouts.layouts), 'background', 'screen'];
  const help = read('src/cli.mjs');
  for (const name of names) {
    assert.match(help, new RegExp(`capcutctl layout ${name}\\b`), `HELP has no entry for layout ${name}`);
  }
});

test('the packaged file list still excludes the private draft catalogue', () => {
  // The one exclusion that matters: presets/harvest.json names every project on the
  // machine that produced it. test/clean-install.test.mjs proves it stays out of the
  // tarball; this proves the intent is still written down where someone edits the list.
  assert.ok(packageJson.files.includes('!presets/harvest.json'),
    'package.json files must keep excluding presets/harvest.json');
});
