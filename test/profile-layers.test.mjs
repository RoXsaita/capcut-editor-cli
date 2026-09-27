import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile, profileLayers, initUserProfile, applyStyle, userDir, resetProfileCache } from '../src/profile.mjs';

function withUserDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-user-'));
  const previous = process.env.CAPCUTCTL_PRESET_DIR;
  process.env.CAPCUTCTL_PRESET_DIR = dir;
  resetProfileCache();
  try { return fn(dir); } finally {
    if (previous == null) delete process.env.CAPCUTCTL_PRESET_DIR; else process.env.CAPCUTCTL_PRESET_DIR = previous;
    resetProfileCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the shipped profile is brand-neutral: no personal name, a brand role, styles', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../presets/profile.json', import.meta.url), 'utf8'));
  assert.equal(shipped.name, 'default');
  assert.equal(shipped.brand.name, null);
  assert.ok(shipped.tokens.color.brand);
  assert.equal(shipped.tokens.color.indigo, undefined);
  for (const [name, style] of Object.entries(shipped.styles).filter(([k]) => !k.startsWith('_'))) {
    assert.ok(style.use && style.feel && Array.isArray(style.pace.graphicEvery), `style ${name} is complete`);
  }
});

test('the user dir defaults to XDG, then ~/.config, and CAPCUTCTL_PRESET_DIR wins', () => {
  const saved = { p: process.env.CAPCUTCTL_PRESET_DIR, x: process.env.XDG_CONFIG_HOME };
  try {
    delete process.env.CAPCUTCTL_PRESET_DIR;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    assert.equal(userDir(), path.join('/tmp/xdg', 'capcutctl'));
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(userDir(), path.join(os.homedir(), '.config', 'capcutctl'));
    process.env.CAPCUTCTL_PRESET_DIR = '/tmp/mine';
    assert.equal(userDir(), '/tmp/mine');
  } finally {
    if (saved.p == null) delete process.env.CAPCUTCTL_PRESET_DIR; else process.env.CAPCUTCTL_PRESET_DIR = saved.p;
    if (saved.x == null) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.x;
  }
});

test('a partial user profile merges over the shipped one, and --profile over both', () => withUserDir(dir => {
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ tokens: { color: { brand: '#123456' } }, brand: { name: 'Me' } }));
  const merged = loadProfile({ refresh: true });
  assert.equal(merged.tokens.color.brand, '#123456');
  assert.equal(merged.tokens.color.accent, '#FFB020', 'untouched keys come from the shipped profile');
  assert.equal(merged.brand.name, 'Me');
  assert.ok(merged.brand.rules.length, 'the shipped rules survive a partial brand');
  const one = path.join(dir, 'one-video.json');
  fs.writeFileSync(one, JSON.stringify({ tokens: { color: { brand: '#654321' } } }));
  assert.equal(loadProfile({ file: one }).tokens.color.brand, '#654321');
  assert.deepEqual(profileLayers({ file: one }).map(l => [l.layer, l.present]), [['bundled', true], ['user', true], ['file', true]]);
}));

test('an older user profile that names the fill indigo still sets the brand role', () => withUserDir(dir => {
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ tokens: { color: { indigo: '#4040FE' } } }));
  assert.equal(loadProfile({ refresh: true }).tokens.color.brand, '#4040FE');
}));

test('profile init writes the template once and refuses to clobber it', () => withUserDir(dir => {
  const first = initUserProfile();
  assert.equal(first.file, path.join(dir, 'profile.json'));
  const written = JSON.parse(fs.readFileSync(first.file, 'utf8'));
  assert.equal(written.version, 1);
  assert.ok(written.brand && written.styles);
  assert.throws(() => initUserProfile(), err => err.code === 'PROFILE_EXISTS');
  assert.equal(initUserProfile({ force: true }).replaced, true);
  assert.doesNotThrow(() => loadProfile({ refresh: true }), 'the template is a valid profile layer');
}));

test('a style replaces the drought target and names itself; an unknown style refuses', () => withUserDir(() => {
  const base = loadProfile({ refresh: true });
  const styled = applyStyle(base, 'news');
  assert.deepEqual(styled.density.graphicEvery, base.styles.news.pace.graphicEvery);
  assert.equal(styled.activeStyle, 'news');
  assert.equal(applyStyle(base, null), base);
  assert.throws(() => applyStyle(base, 'vlog'), err => err.code === 'STYLE_UNKNOWN' && /explainer/.test(err.message));
}));
