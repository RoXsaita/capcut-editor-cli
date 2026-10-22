import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../src/native/export.swift', import.meta.url)), 'utf8');
const block = source.match(/\/\/ BEGIN homeGeometry[\s\S]*?\/\/ END homeGeometry/)?.[0];
const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status === 0;

test('export finds the Home card through the pure page geometry', () => {
  assert.ok(block, 'homeGeometry block is marked in export.swift');
  assert.match(source, /pickCard\(cards: layout, title: tr, page: page\)/);
  assert.match(source, /let p = wheelPoint\(page: page\)/);
});

// Geometry dumped from CapCut Home on 2026-10-22: a maximised 1728x999 window, the left
// sidebar's bar at x=186, the page bar at x=1684, ten cards a row, titles only on row one.
test('a visible first-row card is picked with no scroll; the wheel lands on the page, never beside its bar', { skip: !swiftc && 'swiftc not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-home-'));
  const main = path.join(dir, 'main.swift');
  fs.writeFileSync(main, `import CoreGraphics
${block}
let window = CGRect(x: 0, y: 33, width: 1728, height: 999)
let bars = [CGRect(x: 186, y: 183, width: 10, height: 681), CGRect(x: 1684, y: 77, width: 10, height: 947)]
let row1 = (0..<10).map { CGRect(x: 240 + 146 * Double($0), y: 731, width: 134, height: 174) }
let row2 = (0..<10).map { CGRect(x: 240 + 146 * Double($0), y: 909, width: 134, height: 174) }
let cards = row1 + row2
var failed = 0
func check(_ ok: Bool, _ name: String) { if !ok { print("FAIL " + name); failed += 1 } }
let page = homePage(window: window, bars: bars)
check(page == CGRect(x: 0, y: 77, width: 1684, height: 947), "page is left of the page bar, level with it: \\(page)")
check(homePage(window: window, bars: []) == window, "no bar: the page is the window")
check(homePage(window: window, bars: [bars[0]]) == window, "the sidebar's bar is not the page bar")
let first = CGRect(x: 245, y: 883, width: 124, height: 14)
check(pickCard(cards: cards, title: first, page: page) == 0, "first-row title picks its own card")
let fifth = CGRect(x: 829, y: 883, width: 83, height: 14)
check(pickCard(cards: cards, title: fifth, page: page) == 4, "a later first-row title picks its own card")
let below = CGRect(x: 245, y: 1061, width: 124, height: 14)
check(pickCard(cards: cards, title: below, page: page) == nil, "a title below the page is not clickable yet")
let above = [CGRect(x: 240, y: -65, width: 134, height: 174)]
check(pickCard(cards: above, title: CGRect(x: 245, y: 87, width: 124, height: 14), page: page) == nil, "a card whose centre is above the page is not clicked")
let p = wheelPoint(page: page)
check(page.contains(p) && p.x < bars[1].minX, "the wheel lands on the page: \\(p)")
check(!(p.x > bars[1].maxX), "the wheel never lands beside the page bar")
print(failed == 0 ? "OK" : "FAILED")
`);
  const bin = path.join(dir, 'home');
  const built = spawnSync('swiftc', ['-o', bin, main], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const ran = spawnSync(bin, [], { encoding: 'utf8' });
  assert.equal(ran.stdout.trim(), 'OK', ran.stdout + ran.stderr);
});
