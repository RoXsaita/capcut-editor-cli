import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../src/native/export.swift', import.meta.url)), 'utf8');
const block = source.match(/\/\/ BEGIN cardHitAccepted[\s\S]*?\/\/ END cardHitAccepted/)?.[0];
const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status === 0;

test('export clicks a Home card through the pure ancestry check', () => {
  assert.ok(block, 'cardHitAccepted block is marked in export.swift');
  assert.match(source, /cardHitAccepted\(hit: ancestry\(h\), card: ancestry\(card\)/);
});

// Chains are element first, then its parents, as CapCut's accessibility tree reports them.
test('a hit on the card, inside it, or on a container it sits in is the card; a sheet or another window is not', { skip: !swiftc && 'swiftc not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-hit-'));
  const main = path.join(dir, 'main.swift');
  fs.writeFileSync(main, `${block}
let card = ["card", "grid", "page", "window", "app"]
let cases: [(String, [String], Bool)] = [
  ("flat window hit (Qt stops here)", ["window", "app"], true),
  ("page container", ["page", "window", "app"], true),
  ("the card itself", card, true),
  ("a label inside the card", ["title", "card", "grid", "page", "window", "app"], true),
  ("a CapCut sheet over the card", ["sheet", "window", "app"], false),
  ("another CapCut window", ["popup", "app"], false),
  ("a sibling card", ["card2", "grid", "page", "window", "app"], false),
  ("a sheet's child", ["button", "sheet", "window", "app"], false),
  ("nothing", [], false),
]
var failed = 0
for (name, hit, want) in cases where cardHitAccepted(hit: hit, card: card, same: ==) != want {
  print("FAIL " + name); failed += 1
}
if cardHitAccepted(hit: ["window"], card: [], same: ==) { print("FAIL empty card"); failed += 1 }
print(failed == 0 ? "OK" : "FAILED")
`);
  const bin = path.join(dir, 'hit');
  const built = spawnSync('swiftc', ['-o', bin, main], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const ran = spawnSync(bin, [], { encoding: 'utf8' });
  assert.equal(ran.stdout.trim(), 'OK', ran.stdout + ran.stderr);
});
