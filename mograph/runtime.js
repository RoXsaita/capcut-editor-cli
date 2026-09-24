/*
 * mograph runtime — the contract between an HTML/JS motion-graphics template and the renderer.
 *
 * A template is a plain HTML page that loads this file and calls MG.define(spec). The renderer
 * (src/mograph.mjs) injects `window.__MG_INPUT__ = { params, tokens, fps, fontsBase }`, waits for
 * `window.__mograph.ready`, asks `bounds()` for the union of the content over the whole clip,
 * then calls `window.__mograph.seek(t)` once per frame and screenshots only that box with a
 * transparent background. The clip is therefore tight (never a full-frame overlay) and its
 * canvas position is known exactly, so placement in CapCut is arithmetic, not a guess.
 *
 * Determinism is the whole contract: the picture at time t is a pure function of (params, t).
 *  - no wall clock: Date.now / performance.now are frozen, requestAnimationFrame never fires,
 *    CSS animations and transitions are disabled;
 *  - Math.random is replaced by a seeded generator (MG.random for explicit streams);
 *  - fonts are awaited before frame 0, and a template whose text fell back to another face
 *    refuses to render instead of shipping Arabic in a Latin fallback.
 *
 * spec = {
 *   name,                                   // template id, equals the file name
 *   duration(params, tokens) -> seconds,    // total clip length
 *   build(root, params, tokens, MG),        // create DOM once, laid out in CANVAS pixels:
 *                                           // root is the full 1080×1920 canvas, so a template
 *                                           // places itself exactly where it will appear.
 *                                           // May return a Promise; images from MG.image()
 *                                           // are decoded before frame 0.
 *   pad?: px,                               // extra crop margin for glow/blur (default 24)
 *   seek(t, state),                         // set every animated property for time t
 *   still?(params) -> seconds,              // representative hold frame for png-still/preview
 *   sfx?: 'pop'|'impact'|'enter'|'select'|'click'|'idea'|null,   // paired cue (sfx.json accents)
 *   motion?: 'pop'|'slide'|'rich'           // 'rich' motion cannot be a png-still
 * }
 *
 * Helpers for templates (all token-driven, so templates carry no literal colours or fonts):
 *   MG.cssVars(el)         --mg-<colour>, --mg-<colour>-rgb, --mg-radius-*, --mg-stroke-*, --mg-type-*
 *   MG.rgba(name, alpha)   a token colour with alpha
 *   MG.layout(params,{margin})  text band for params.layout, centre, and the `safe` rect that keeps
 *                          `margin` px (crop pad + motion overshoot) clear of the forbidden zones
 *   MG.place(el, layout)   centre an element there (clamped into `safe` unless params.center is given)
 *   MG.fitFont(el, base, maxW, maxH, min)   shrink type to fit
 *   MG.show(el, opacity)   opacity that also hides at 0, keeping invisible states out of the crop
 *   MG.pulse(t, start, dur)  one 0→1→0 bump (never a loop)
 *   MG.holdFrames(params, words), MG.readSign(text), MG.image(src)
 * ready() also reports `words`: the number of .mg-word spans (Arabic is animated by word).
 */
(function () {
  'use strict';
  const input = window.__MG_INPUT__ || { params: {}, tokens: null, fps: 30, fontsBase: '../fonts/' };

  // ---- determinism -------------------------------------------------------------------------
  let seed = 0x9e3779b9 ^ String(JSON.stringify(input.params || {})).length;
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Math.random = mulberry32(seed);
  Date.now = () => 0;
  if (window.performance) window.performance.now = () => 0;
  window.requestAnimationFrame = () => 0;
  const freeze = document.createElement('style');
  freeze.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;will-change:auto!important}'
    + 'html,body{margin:0;padding:0;background:transparent!important;overflow:hidden}';
  document.documentElement.appendChild(freeze);

  // ---- maths -------------------------------------------------------------------------------
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;

  /** CSS cubic-bezier as a function of progress (Newton + bisection, as browsers do). */
  function bezier([x1, y1, x2, y2]) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = t => ((ax * t + bx) * t + cx) * t;
    const sy = t => ((ay * t + by) * t + cy) * t;
    const dx = t => (3 * ax * t + 2 * bx) * t + cx;
    return p => {
      p = clamp(p);
      if (p === 0 || p === 1) return p;
      let t = p;
      for (let i = 0; i < 8; i++) {
        const e = sx(t) - p;
        if (Math.abs(e) < 1e-6) return sy(t);
        const d = dx(t);
        if (Math.abs(d) < 1e-6) break;
        t -= e / d;
      }
      let lo = 0, hi = 1; t = p;
      while (hi - lo > 1e-6) { const v = sx(t); if (v < p) lo = t; else hi = t; t = (lo + hi) / 2; }
      return sy(t);
    };
  }
  /** Back-out with a bounded overshoot fraction (0.06 = 6% past the target, then settle). */
  function backOut(overshoot = 0.06) {
    // Solve s so the curve peaks at 1 + overshoot.
    let s = 1.70158 * (overshoot / 0.1);
    return p => { p = clamp(p) - 1; return p * p * ((s + 1) * p + s) + 1; };
  }

  // ---- tokens & timing ---------------------------------------------------------------------
  const tokens = input.tokens || {};
  const fps = input.fps || 30;
  const F = n => n / fps;                         // frames -> seconds
  const ease = {
    enter: bezier((tokens.ease && tokens.ease.enter) || [0.16, 1, 0.3, 1]),
    exit: bezier((tokens.ease && tokens.ease.exit) || [0.7, 0, 0.84, 0]),
    pop: backOut((tokens.ease && tokens.ease.popOvershoot) || 0.06),
    linear: p => clamp(p),
  };
  /** Progress of a window [start, start+dur] at time t, 0..1. */
  const win = (t, start, dur) => (dur <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / dur));
  /** Standard in-hold-out envelope: 0 → 1 over `inDur` (enter ease), 1 → 0 over `outDur` at the end. */
  function envelope(t, total, inDur, outDur, startAt = 0) {
    const a = ease.enter(win(t, startAt, inDur));
    const b = 1 - ease.exit(win(t, total - outDur, outDur));
    return Math.min(a, b);
  }

  // ---- text --------------------------------------------------------------------------------
  const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
  const isArabic = text => ARABIC.test(String(text || ''));
  /**
   * Split text into WORD spans. Never letters: Arabic letters join, and animating them one by
   * one breaks the joined forms. Returns the spans in reading order (RTL for Arabic).
   */
  function words(el, text, className = 'mg-word') {
    el.textContent = '';
    el.setAttribute('dir', isArabic(text) ? 'rtl' : 'ltr');
    const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
    return parts.map((word, i) => {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = word;
      span.style.display = 'inline-block';
      el.appendChild(span);
      if (i < parts.length - 1) el.appendChild(document.createTextNode(' '));
      return span;
    });
  }
  /** Latin digits for tech numbers, per profile tokens.font.digits. */
  function digits(value) {
    const s = String(value);
    if ((tokens.font && tokens.font.digits) !== 'latin') return s;
    return s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
  }

  // ---- fonts -------------------------------------------------------------------------------
  function installFonts() {
    const font = tokens.font || {};
    const family = font.family || 'IBM Plex Sans Arabic';
    const css = [];
    for (const [weight, files] of Object.entries(font.files || {})) {
      for (const file of files) {
        css.push(`@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;`
          + `src:url("${input.fontsBase}${file}") format("woff2");font-display:block}`);
      }
    }
    const style = document.createElement('style');
    style.textContent = css.join('\n') + `\n:root{--mg-font:"${family}";}`
      + '\nbody{font-family:var(--mg-font);-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}';
    document.head.appendChild(style);
    return family;
  }
  async function awaitFonts(family, sample) {
    const weights = Object.keys((tokens.font && tokens.font.files) || { 700: [] });
    await Promise.all(weights.map(w => document.fonts.load(`${w} 48px "${family}"`, sample || 'Aa')));
    await document.fonts.ready;
    for (const w of weights) {
      if (!document.fonts.check(`${w} 48px "${family}"`, sample || 'Aa')) {
        throw new Error(`MOGRAPH_FONT_FALLBACK: "${family}" ${w} is not loaded for "${sample}"`);
      }
    }
    // fonts.check() only says the face is loaded, not that it has the glyphs. Measure each Arabic
    // letter with two different generic fallbacks behind the family: a glyph the family really
    // has measures the same both ways; one that came from a fallback usually does not. (Never a
    // false alarm; the authoritative per-node check is CDP CSS.getPlatformFontsForNode, used in tests.)
    const letters = [...new Set(Array.from(String(sample || '')).filter(ch => ARABIC.test(ch)))];
    if (letters.length) {
      const ctx = document.createElement('canvas').getContext('2d');
      for (const w of weights) {
        const width = (generic, ch) => { ctx.font = `${w} 48px "${family}", ${generic}`; return ctx.measureText(ch).width; };
        const missing = letters.filter(ch => Math.abs(width('monospace', ch) - width('serif', ch)) > 0.01);
        if (missing.length) {
          throw new Error(`MOGRAPH_FONT_FALLBACK: "${family}" ${w} has no glyph for "${missing.join('')}" in "${sample}"`);
        }
      }
    }
  }

  // ---- colour helpers ----------------------------------------------------------------------
  const color = name => (tokens.color && tokens.color[name]) || name;

  // ---- template helpers (v1 library) --------------------------------------------------------
  /** A token colour with alpha, as an rgba() string. Unknown names pass through unchanged. */
  function rgb(name) {
    const hex = String(color(name)).replace(/^#/, '');
    if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
    const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  }
  const rgba = (name, alpha = 1) => { const c = rgb(name); return c ? `rgba(${c.join(',')},${alpha})` : color(name); };
  /**
   * Expose the tokens to CSS on `el`: --mg-<colour>, --mg-<colour>-rgb ("r,g,b" for
   * rgba(var(--mg-ink-rgb), .5)), --mg-radius-<name>, --mg-stroke-<name>, --mg-type-<name>.
   */
  function cssVars(el) {
    for (const [name, value] of Object.entries(tokens.color || {})) {
      if (name.startsWith('_')) continue;
      el.style.setProperty(`--mg-${name}`, value);
      const c = rgb(name);
      if (c) el.style.setProperty(`--mg-${name}-rgb`, c.join(','));
    }
    for (const group of ['radius', 'stroke', 'type']) {
      for (const [name, value] of Object.entries(tokens[group] || {})) {
        if (typeof value === 'number') el.style.setProperty(`--mg-${group}-${name}`, `${value}px`);
      }
    }
    return el;
  }
  /**
   * Where a graphic may sit for params.layout: the profile text band, its centre (or
   * params.center), and the `safe` rectangle whose edges keep `margin` px (crop pad + motion
   * overshoot) clear of every forbidden platform-UI zone. Horizontally the band is the limit;
   * vertically a graphic may grow past a short band up to the nearest forbidden zone.
   */
  function layout(params = {}, { margin = 24 } = {}) {
    const zones = input.zones || {};
    const bands = zones.textBands || {};
    const name = params.layout && bands[params.layout] ? params.layout : 'full-face';
    const band = bands[name] || { x: 72, y: 1150, w: 848, h: 300 };
    const canvas = input.canvas || { width: 1080, height: 1920 };
    const center = Array.isArray(params.center) && params.center.length === 2
      ? params.center.map(Number) : [band.x + band.w / 2, band.y + band.h / 2];
    let x0 = band.x, x1 = band.x + band.w, y0 = 0, y1 = canvas.height;
    const cy = band.y + band.h / 2;
    for (const z of zones.forbidden || []) {
      const overlapsX = z.x < band.x + band.w && z.x + z.w > band.x;
      const overlapsY = z.y < band.y + band.h && z.y + z.h > band.y;
      if (overlapsX && z.y + z.h <= cy) y0 = Math.max(y0, z.y + z.h + margin);
      else if (overlapsX && z.y >= cy) y1 = Math.min(y1, z.y - margin);
      else if (overlapsY && z.x >= band.x + band.w / 2) x1 = Math.min(x1, z.x - margin);
      else if (overlapsY) x0 = Math.max(x0, z.x + z.w + margin);
    }
    return { name, band, center, margin, explicit: Boolean(params.center),
      safe: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) } };
  }
  /**
   * Position an absolutely positioned element (its current size) at the layout centre. A
   * default placement is clamped into the safe rectangle; an explicit params.center is honoured.
   * Returns the element's final canvas rect.
   */
  function place(el, lay) {
    const r = el.getBoundingClientRect();
    let left = lay.center[0] - r.width / 2, top = lay.center[1] - r.height / 2;
    if (!lay.explicit) {
      const s = lay.safe;
      left = clamp(left, s.x, Math.max(s.x, s.x + s.w - r.width));
      top = clamp(top, s.y, Math.max(s.y, s.y + s.h - r.height));
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    return { x: left, y: top, w: r.width, h: r.height };
  }
  /** Font size (px) that fits `el` into maxW×maxH, from `base` down to `min`. Sets it and returns it. */
  function fitFont(el, base, maxW, maxH = Infinity, min = 12) {
    let size = base;
    el.style.fontSize = `${size}px`;
    for (let i = 0; i < 6; i++) {
      const r = el.getBoundingClientRect();
      const k = Math.min(1, maxW / Math.max(1, r.width), maxH / Math.max(1, r.height));
      if (k >= 0.999) break;
      size = Math.max(min, Math.floor(size * k));
      el.style.fontSize = `${size}px`;
      if (size === min) break;
    }
    return size;
  }
  /** Opacity that also hides fully transparent elements, so they stay out of the crop box. */
  function show(el, opacity) {
    const o = clamp(opacity);
    el.style.opacity = String(o);
    el.style.visibility = o < 0.002 ? 'hidden' : 'visible';
  }
  /** One smooth bump 0 → 1 → 0 over [start, start+dur] (never a loop). */
  const pulse = (t, start, dur) => { const p = win(t, start, dur); return p <= 0 || p >= 1 ? 0 : Math.sin(Math.PI * p) ** 2; };
  /** Frames → hold for `count` words, or params.hold seconds. */
  const holdFrames = (params, count) => (params && params.hold != null
    ? Math.max(0, Math.round(Number(params.hold) * fps))
    : Math.max((tokens.frames || {}).minHold || 30, ((tokens.frames || {}).perWordHold || 10) * count));
  /** Reading-direction sign: +1 when text starts on the right (Arabic), -1 for Latin. */
  const readSign = text => (isArabic(text) ? 1 : -1);
  /**
   * An <img> for a local file (absolute path or file:// URL) that is decoded before frame 0.
   * A missing or undecodable file refuses to render instead of shipping a broken image.
   */
  const pending = [];
  function image(src) {
    const img = document.createElement('img');
    const s = String(src || '');
    img.src = /^(file|data|https?):/i.test(s) ? s : `file://${s.split('/').map(encodeURIComponent).join('/')}`;
    img.decoding = 'sync';
    pending.push(img.decode().catch(() => { throw new Error(`MOGRAPH_ASSET: could not load image "${s}"`); }));
    return img;
  }

  const MG = {
    input, tokens, fps, F, clamp, lerp, bezier, backOut, ease, win, envelope, words, digits,
    isArabic, color, random: s => mulberry32(s >>> 0),
    rgba, cssVars, layout, place, fitFont, show, pulse, holdFrames, readSign, image,
    define(spec) {
      const params = input.params || {};
      let state = null;
      let duration = 0;
      const api = {
        name: spec.name,
        ready: (async () => {
          const family = installFonts();
          const canvas = input.canvas || { width: 1080, height: 1920 };
          const root = document.getElementById('mg-root') || document.body.appendChild(document.createElement('div'));
          root.id = 'mg-root';
          Object.assign(root.style, { position: 'absolute', left: '0', top: '0',
            width: `${canvas.width}px`, height: `${canvas.height}px`, overflow: 'visible' });
          // Fonts load BEFORE build: templates measure their own text to lay it out, and a
          // measurement taken in the fallback face is wrong by the time the real face arrives.
          await awaitFonts(family, 'Aa \u0623\u0628 123');
          state = (await spec.build(root, params, tokens, MG)) || {};
          state.root = root;
          // Assets a template asked for (MG.image) are decoded before frame 0, like fonts.
          while (pending.length) await Promise.all(pending.splice(0));
          const sample = (root.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 64) || 'Aa';
          await awaitFonts(family, sample);
          duration = spec.duration(params, tokens, MG);
          spec.seek(0, state, MG);
          return {
            name: spec.name, duration, fps, canvas,
            still: spec.still ? spec.still(params, tokens, MG) : duration * 0.6,
            sfx: spec.sfx === undefined ? null : spec.sfx, motion: spec.motion || 'rich',
            pad: spec.pad == null ? 24 : spec.pad, family, sample,
            words: root.querySelectorAll('.mg-word').length,
          };
        })(),
        /** Union of every visible element's box across `samples` instants, padded, in canvas px. */
        bounds(samples = 24) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let i = 0; i <= samples; i++) {
            spec.seek(duration * i / samples, state, MG);
            for (const el of state.root.querySelectorAll('*')) {
              const r = el.getBoundingClientRect();
              if (!r.width || !r.height) continue;
              const cs = getComputedStyle(el);
              if (cs.visibility === 'hidden' || cs.display === 'none') continue;
              x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
              x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
            }
          }
          spec.seek(0, state, MG);
          if (!Number.isFinite(x0)) throw new Error('MOGRAPH_EMPTY: template drew nothing');
          const pad = spec.pad == null ? 24 : spec.pad;
          const canvas = input.canvas || { width: 1080, height: 1920 };
          const even = n => Math.ceil(n / 2) * 2;       // ProRes 4444 wants even dimensions
          const x = Math.max(0, Math.floor(x0 - pad)), y = Math.max(0, Math.floor(y0 - pad));
          const w = even(Math.min(canvas.width, Math.ceil(x1 + pad)) - x);
          const h = even(Math.min(canvas.height, Math.ceil(y1 + pad)) - y);
          return { x, y, w, h };
        },
        seek(t) { spec.seek(t, state, MG); return document.body.offsetHeight; },
      };
      window.__mograph = api;
      return api;
    },
  };
  window.MG = MG;
})();
