#!/usr/bin/env node
/*
 * The showreel's score, synthesised from nothing: 15 s, 48 kHz stereo, 120 BPM in F minor.
 * Every hit is placed on the same timeline as reel.js, so picture and sound share one clock:
 * letter slams, the glitch, bounces, grid ticks, the particle shimmer, the bezier playhead,
 * one stab per style frame, and a bell for the name card.
 *
 *   node score.mjs out/score.wav
 *
 * Deterministic (seeded noise), no dependencies.
 */
import fs from 'node:fs';

const SR = 48000, DUR = 15, N = SR * DUR, TAU = Math.PI * 2;
const L = new Float32Array(N), R = new Float32Array(N);
const sendL = new Float32Array(N), sendR = new Float32Array(N);
const duckBus = { L: new Float32Array(N), R: new Float32Array(N) };   // bass + pad, sidechained to the kick

let seed = 0x2f6b1a;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rand() * 2 - 1;
const midi = m => 440 * 2 ** ((m - 69) / 12);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Add a mono voice fn(t, i) for dur seconds at t0, panned (-1..1), optionally to the reverb send. */
function voice(t0, dur, fn, { gain = 1, pan = 0, send = 0, bus = null } = {}) {
  const s0 = Math.max(0, Math.round(t0 * SR)), s1 = Math.min(N, Math.round((t0 + dur) * SR));
  const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  const oL = bus ? bus.L : L, oR = bus ? bus.R : R;
  for (let i = s0; i < s1; i++) {
    const v = fn((i - s0) / SR, i - s0);
    oL[i] += v * gl; oR[i] += v * gr;
    if (send) { sendL[i] += v * gl * send; sendR[i] += v * gr * send; }
  }
}
/** One-pole lowpass / highpass state helpers. */
const lp = () => { let y = 0; return (x, fc) => { const a = 1 - Math.exp(-TAU * fc / SR); y += a * (x - y); return y; }; };
const hp = () => { const f = lp(); return (x, fc) => x - f(x, fc); };
/** Chamberlin state-variable filter: returns band-pass. */
const svf = () => { let low = 0, band = 0; return (x, fc, q = 0.5) => { const f = 2 * Math.sin(Math.PI * Math.min(fc, SR / 6) / SR); low += f * band; const high = x - low - q * band; band += f * high; return band; }; };

// ---- instruments -------------------------------------------------------------------------------
const kicks = [];
function kick(t, g = 1) {
  kicks.push(t);
  let ph = 0;
  voice(t, 0.45, (x) => {
    const f = 45 + 110 * Math.exp(-x * 28);
    ph += TAU * f / SR;
    const click = x < 0.004 ? noise() * (1 - x / 0.004) * 0.5 : 0;
    return Math.tanh(1.6 * Math.sin(ph) * Math.exp(-x * 7)) + click;
  }, { gain: 0.9 * g });
}
function clap(t, g = 1) {
  const bp = svf(), bp2 = svf();
  voice(t, 0.35, (x) => {
    const env = (x < 0.03 ? 0.6 + 0.4 * Math.abs(Math.sin(x * TAU * 90)) : 1) * Math.exp(-x * 16);
    return bp(noise(), 1400, 0.6) * env * 1.6 + Math.sin(TAU * 190 * x) * Math.exp(-x * 30) * 0.3 + bp2(noise(), 3200, 0.9) * env * 0.4;
  }, { gain: 0.42 * g, send: 0.35 });
}
function hat(t, g = 1, open = false, pan = 0.25) {
  const h = hp();
  voice(t, open ? 0.25 : 0.06, (x) => h(noise(), 7500) * Math.exp(-x * (open ? 14 : 65)), { gain: 0.18 * g, pan });
}
function click(t, g = 1, pan = 0, tone = 3000) {
  const b = svf();
  voice(t, 0.03, (x) => b(noise(), tone, 0.3) * Math.exp(-x * 220), { gain: 0.5 * g, pan, send: 0.15 });
}
function blip(t, f, g = 1, pan = 0, dur = 0.12, send = 0.3) {
  voice(t, dur, (x) => Math.sin(TAU * f * x) * Math.exp(-x * (5 / dur)) * Math.min(1, x * 2000), { gain: 0.22 * g, pan, send });
}
function pluck(t, f, g = 1, pan = 0) {
  const f1 = lp(); let ph = 0;
  voice(t, 0.35, (x) => {
    ph += f / SR;
    const saw = 2 * (ph % 1) - 1;
    return f1(saw, 400 + 5000 * Math.exp(-x * 18)) * Math.exp(-x * 9);
  }, { gain: 0.16 * g, pan, send: 0.4 });
}
function thud(t, g = 1, f0 = 130, f1 = 48) {
  let ph = 0;
  voice(t, 0.3, (x) => { ph += TAU * (f1 + (f0 - f1) * Math.exp(-x * 25)) / SR; return Math.sin(ph) * Math.exp(-x * 13); }, { gain: 0.7 * g, send: 0.1 });
}
function whoosh(t0, dur, { g = 1, from = 300, to = 6000, q = 0.35, pan0 = -0.6, pan1 = 0.6, shape = 'up' } = {}) {
  const f = svf(), s0 = Math.round(t0 * SR), s1 = Math.min(N, Math.round((t0 + dur) * SR));
  for (let i = s0; i < s1; i++) {
    const p = (i - s0) / (s1 - s0);
    const env = shape === 'up' ? p ** 2.2 : shape === 'down' ? (1 - p) ** 1.8 : Math.sin(Math.PI * p) ** 2;
    const fc = from * (to / from) ** (shape === 'down' ? 1 - p : p);
    const v = f(noise(), fc, q) * env * 0.5 * g;
    const pan = pan0 + (pan1 - pan0) * p, gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    L[i] += v * gl; R[i] += v * gr; sendL[i] += v * gl * 0.3; sendR[i] += v * gr * 0.3;
  }
}
function riser(t0, dur, g = 1, f0 = 180, f1 = 1400) {
  let ph = 0, ph2 = 0;
  voice(t0, dur, (x) => {
    const p = x / dur, f = f0 * (f1 / f0) ** (p * p);
    ph += TAU * f / SR; ph2 += TAU * f * 1.007 / SR;
    return (Math.sin(ph) + Math.sin(ph2) * 0.6) * p ** 2.5 * 0.5;
  }, { gain: 0.22 * g, send: 0.3 });
  whoosh(t0, dur, { g: 0.8 * g, from: 400, to: 9000, q: 0.5, pan0: 0, pan1: 0 });
}
function impact(t, g = 1) {
  let ph = 0;
  voice(t, 1.6, (x) => { ph += TAU * (28 + 42 * Math.exp(-x * 4)) / SR; return Math.tanh(2 * Math.sin(ph)) * Math.exp(-x * 2.6); }, { gain: 0.75 * g });
  const f = lp();
  voice(t, 1.2, (x) => f(noise(), 200 + 5000 * Math.exp(-x * 9)) * Math.exp(-x * 4.5), { gain: 0.9 * g, send: 0.9 });
  hat(t, 1.4 * g, true, 0);
  kick(t, 0.8 * g);
}
function glitch(t0, dur) {
  let hold = 0, v = 0;
  voice(t0, dur, (x, i) => {
    if (i % 900 === 0) hold = rand() < 0.4 ? 0 : 1;
    if (i % 6 === 0) v = Math.sign(Math.sin(TAU * (220 * (1 + Math.floor(x * 32) % 5)) * x)) * 0.6 + noise() * 0.4;
    return Math.round(v * hold * 4) / 4 * Math.exp(-x * 3);
  }, { gain: 0.16, send: 0.1 });
}
function bell(t, f, g = 1, pan = 0, dur = 2.2) {
  voice(t, dur, (x) => {
    const m = Math.sin(TAU * f * 3.5 * x) * 2.4 * Math.exp(-x * 3);
    return Math.sin(TAU * f * x + m) * Math.exp(-x * 2.1) * Math.min(1, x * 400);
  }, { gain: 0.15 * g, pan, send: 0.6 });
}
function stab(t, notes, g = 1) {
  notes.forEach((n, k) => {
    const f1 = lp(); let ph = 0; const f = midi(n);
    voice(t, 0.3, (x) => { ph += f * (1 + (k - 1) * 0.004) / SR; return f1(2 * (ph % 1) - 1, 700 + 7000 * Math.exp(-x * 16)) * Math.exp(-x * 11); },
      { gain: 0.13 * g, pan: (k - 1) * 0.4, send: 0.35 });
  });
}
function sparkle(t0, t1, density = 70, g = 1) {
  const count = Math.round((t1 - t0) * density);
  const scale = [77, 80, 84, 85, 89, 92, 96, 97];
  for (let k = 0; k < count; k++) {
    const t = t0 + rand() * (t1 - t0);
    blip(t, midi(scale[Math.floor(rand() * scale.length)]), 0.22 * g * (0.4 + rand()), rand() * 1.6 - 0.8, 0.05 + rand() * 0.08, 0.7);
  }
}
function pad(t0, t1, notes, g = 1) {
  const dur = t1 - t0;
  notes.forEach((n, k) => {
    for (const det of [-0.08, 0.08]) {
      const f = midi(n + det), f1 = lp(); let ph = rand();
      voice(t0, dur + 0.4, (x) => {
        ph += f / SR;
        const env = Math.min(1, x / 0.15) * (x > dur ? Math.exp(-(x - dur) * 10) : 1);
        return f1(2 * (ph % 1) - 1, 900 + 500 * Math.sin(x * 1.3 + k)) * env;
      }, { gain: 0.035 * g, pan: det * 6 * (k % 2 ? 1 : -1), send: 0.5, bus: duckBus });
    }
  });
}
function bass(t, n, dur, g = 1) {
  const f = midi(n), f1 = lp(); let ph = 0, ph2 = 0;
  voice(t, dur, (x) => {
    ph += f / SR; ph2 += f * 0.5 / SR;
    const env = Math.min(1, x * 300) * Math.exp(-x * 5) * (x > dur - 0.01 ? (dur - x) / 0.01 : 1);
    return Math.tanh(1.5 * f1(2 * (ph % 1) - 1 + Math.sin(TAU * ph2) * 0.8, 180 + 1400 * Math.exp(-x * 20))) * env;
  }, { gain: 0.34 * g, bus: duckBus });
}

// ---- harmony ----------------------------------------------------------------------------------
// F minor: Fm, Db, Ab, Eb. (MIDI roots for the bass, triads for pad/stabs.)
const CH = {
  Fm: { root: 29, triad: [65, 68, 72] }, Db: { root: 25, triad: [61, 65, 68] },
  Ab: { root: 32, triad: [63, 68, 72] }, Eb: { root: 27, triad: [63, 67, 70] },
};
const PROG = [[1.5, 'Fm'], [3.5, 'Db'], [5.5, 'Ab'], [7.5, 'Eb'], [9.5, 'Fm'], [11.5, 'Db'], [12.5, 'Eb'], [13.5, 'Fm']];
const chordAt = t => { let c = 'Fm'; for (const [s, n] of PROG) if (t >= s) c = n; return CH[c]; };

// ==============================================================================================
// 01 IGNITION 0 – 1.5
// ==============================================================================================
blip(0.03, 1760, 0.9, 0, 0.25);
{ let ph = 0; voice(0.22, 0.3, x => { ph += TAU * (220 + 900 * (x / 0.3) ** 2) / SR; return Math.sin(ph) * (x / 0.3) ** 2; }, { gain: 0.1 }); }
whoosh(0.48, 0.32, { g: 1.1, from: 1200, to: 9000, q: 0.25, shape: 'down', pan0: 0, pan1: 0 });
blip(0.5, 880, 0.8, 0, 0.3);
for (let k = 1; k <= 8; k++) for (const s of [-1, 1]) click(0.7 + k * 0.028, 0.5, s * k / 8, 2500 + k * 300);
for (let k = 1; k <= 4; k++) for (const s of [-1, 1]) click(0.84 + k * 0.04, 0.35, s * 0.3, 1800);
thud(1.0, 0.6, 90, 40); blip(1.0, 440, 0.6, 0, 0.6, 0.9); blip(1.07, 660, 0.4, 0.3, 0.5, 0.9);
riser(0.85, 0.65, 1.2);
pad(0, 1.5, [53, 60, 65], 0.5);

// ==============================================================================================
// Groove 1.5 – 13.5
// ==============================================================================================
impact(1.5, 1.1);
const noKick = new Set([3.5, 8.5, 11.0]);
for (let t = 2.0; t < 13.5; t += 0.5) if (!noKick.has(t)) kick(t);
for (let t = 2.0; t < 13.5; t += 1.0) if (t !== 11.0) clap(t);
for (let t = 1.75; t < 13.5; t += 0.5) hat(t, 1, false, 0.3);
for (let t = 6.5; t < 9.0; t += 0.25) if ((t * 4) % 2) hat(t, 0.5, false, -0.3);
for (let t = 11.5; t < 13.5; t += 0.125) hat(t, 0.7 + 0.3 * ((t * 8) % 2), false, -0.2);
hat(3.25, 1, true); hat(5.75, 1, true); hat(8.25, 1, true); hat(10.75, 1, true);
// Bass: eighth-note pulse on the chord root, octave jump on the offbeat of each second beat.
for (let t = 1.5; t < 13.5; t += 0.25) {
  if (t >= 3.5 && t < 4.0) continue;            // the dive through the O breathes
  if (t >= 10.75 && t < 11.5) continue;         // the ribbon riser
  const c = chordAt(t), step = Math.round((t - 1.5) / 0.25);
  bass(t, c.root + 12 + (step % 4 === 3 ? 12 : 0), 0.22);
}
for (const [s, n] of PROG) {
  const next = PROG.find(([t]) => t > s);
  const end = next ? next[0] : 15;
  if (s < 13.5) pad(s, end, CH[n].triad, 1);
}

// 02 TYPOGRAPHY
'MOTION'.split('').forEach((_, i) => { thud(1.52 + i * 0.05, 0.5, 200 - i * 8, 70); click(1.52 + i * 0.05, 0.6, (i - 2.5) / 3, 2200); });
glitch(2.0, 0.34);
{ let ph = 0; voice(2.2, 0.3, x => { ph += TAU * (1500 * (0.2 / 1.5) ** (x / 0.3)) / SR; return Math.sin(ph) * 0.5; }, { gain: 0.14, pan: -0.4 }); }
thud(2.5, 0.9, 160, 50); click(2.5, 0.8, -0.4, 1200);
whoosh(2.85, 0.35, { g: 0.7, from: 600, to: 4000, shape: 'bell' });
blip(2.55, midi(84), 0.5, 0.2, 0.4, 0.8);
riser(3.4, 0.6, 1.1, 120, 2200);
whoosh(3.5, 0.5, { g: 1.4, from: 200, to: 12000, q: 0.3, pan0: 0, pan1: 0 });

// 03 SHAPE LANGUAGE
blip(4.02, midi(96), 0.6, 0, 0.5, 0.9);
{ let ph = 0; voice(4.0, 0.5, x => { ph += TAU * (900 - 700 * (x / 0.5)) / SR; return Math.sin(ph) * 0.4 * (x / 0.5); }, { gain: 0.1, pan: -0.5 }); }
thud(4.5, 1, 170, 55); click(4.5, 0.5, -0.2, 900);
{ let ph = 0; voice(4.52, 0.46, x => { const p = x / 0.46; ph += TAU * (300 + 500 * Math.sin(Math.PI * p)) / SR; return Math.sin(ph) * Math.sin(Math.PI * p) * 0.3; }, { gain: 0.1 }); }
thud(5.0, 1.1, 190, 50); click(5.0, 0.6, 0, 900);
[72, 75, 77, 80, 84].forEach((n, i) => blip(5.07 + i * 0.04, midi(n), 0.6, (i - 2) / 2, 0.25, 0.5));
for (let k = 0; k < 16; k++) pluck(5.42 + k * 0.025, midi([68, 72, 75, 80][k % 4] + 12 * Math.floor(k / 8)), 0.8, (k % 5 - 2) / 2.5);
whoosh(5.45, 0.3, { g: 0.6, from: 800, to: 5000, shape: 'bell' });
whoosh(5.95, 0.3, { g: 0.6, from: 800, to: 5000, shape: 'bell', pan0: 0.6, pan1: -0.6 });
for (let k = 0; k < 12; k++) pluck(6.18 + k * 0.025, midi([79, 75, 72, 67][k % 4] - 12 * Math.floor(k / 6)), 0.6, (2 - k % 5) / 2.5);
whoosh(6.1, 0.4, { g: 0.9, from: 5000, to: 300, shape: 'down' });

// 04 PARTICLES
impact(6.5, 0.6);
sparkle(6.5, 8.6, 65, 1);
whoosh(7.28, 0.5, { g: 0.7, from: 500, to: 3000, shape: 'bell', pan0: -0.8, pan1: 0.8 });
thud(7.5, 0.9, 80, 35);
[65, 68, 72, 77].forEach((n, i) => bell(7.95 + i * 0.03, midi(n + 12), 0.7, (i - 1.5) / 2, 1.6));
riser(8.6, 0.4, 1.2, 300, 3000);

// 05 TIMING
impact(9.0, 0.8);
click(9.34, 1, -0.5, 4000); click(9.36, 0.6, -0.5, 2500);
click(10.04, 1, -0.5, 4000); click(10.06, 0.6, -0.5, 2500);
for (const t of [9.5, 10.0, 10.5, 11.0]) { blip(t, midi(84), 0.45, 0.5, 0.08, 0.2); blip(t + 0.4, midi(79), 0.55, 0.5, 0.12, 0.2); }
riser(10.72, 0.78, 1.4, 150, 2600);

// 06 STYLE FRAMES — one stab per look, walking up the scale
impact(11.5, 0.9);
const STABS = [[65, 68, 72], [61, 65, 68], [63, 68, 72], [61, 65, 68], [63, 67, 70], [63, 67, 70], [65, 68, 72], [67, 70, 74]];
STABS.forEach((notes, k) => { stab(11.5 + k * 0.25, notes.map(n => n + (k >= 6 ? 12 : 0)), 1); click(11.5 + k * 0.25, 0.5, (k % 2 ? 1 : -1) * 0.6, 5000); });
kick(13.25, 0.8); kick(13.375, 0.7);
whoosh(13.0, 0.5, { g: 1.1, from: 300, to: 11000, q: 0.3, pan0: 0, pan1: 0 });

// ==============================================================================================
// 07 SIGNATURE 13.5 – 15
// ==============================================================================================
impact(13.5, 1.25);
blip(13.53, 1760, 0.9, 0, 0.3);
whoosh(13.66, 0.22, { g: 0.6, from: 3000, to: 900, shape: 'bell', pan0: 0.2, pan1: -0.5 });
whoosh(13.86, 0.5, { g: 0.55, from: 1500, to: 6000, shape: 'bell', pan0: -0.5, pan1: 0.5, q: 0.8 });
thud(14.36, 0.6, 220, 90); blip(14.36, 880, 0.7, 0.3, 0.4, 0.8);
for (let k = 0; k < 12; k++) click(14.2 + k * 0.032, 0.25, (k % 3 - 1) * 0.3, 6000);
[53, 60, 65, 68, 72].forEach((n, i) => bell(14.36 + i * 0.045, midi(n + 12), 0.9 - i * 0.1, (i - 2) / 3, 1.2));
pad(13.5, 15, [53, 60, 65, 68], 1.3);
thud(14.75, 0.5, 70, 38); bell(14.75, midi(89), 0.5, 0, 0.8);

// ---- mix ---------------------------------------------------------------------------------------
// Sidechain: duck the bass + pad under every kick.
const duck = new Float32Array(N).fill(1);
for (const t of kicks) {
  const s0 = Math.round(t * SR);
  for (let i = s0; i < Math.min(N, s0 + SR * 0.4); i++) duck[i] = Math.min(duck[i], 1 - 0.7 * Math.exp(-((i - s0) / SR) / 0.09));
}
for (let i = 0; i < N; i++) { L[i] += duckBus.L[i] * duck[i]; R[i] += duckBus.R[i] * duck[i]; }

// Schroeder reverb on the send.
function reverb(inp, spread) {
  const out = new Float32Array(N);
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map(d => ({ d: d + spread, buf: new Float32Array(d + spread), i: 0, lp: 0 }));
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * 0.72 + c.lp * 0.28;
      c.buf[c.i] = inp[n] + c.lp * 0.83;
      c.i = (c.i + 1) % c.d; s += y;
    }
    out[n] = s / combs.length;
  }
  for (const d of [225 + spread, 556 + spread, 441]) {
    const buf = new Float32Array(d); let i = 0;
    for (let n = 0; n < N; n++) { const b = buf[i], x = out[n]; const y = -x + b; buf[i] = x + b * 0.5; out[n] = y; i = (i + 1) % d; }
  }
  return out;
}
const rL = reverb(sendL, 0), rR = reverb(sendR, 23);
for (let i = 0; i < N; i++) { L[i] += rL[i] * 0.55; R[i] += rR[i] * 0.55; }

// Master: gentle glue saturation, normalise to -1 dBFS, 12 ms fade-in and a short tail fade.
let peak = 0, raw = 0; for (let i = 0; i < N; i++) raw = Math.max(raw, Math.abs(L[i]), Math.abs(R[i]));
const drive = 1.5 / raw;   // the loudest transient lands at tanh(1.5): peaks are rounded, the body stays clean
for (let i = 0; i < N; i++) { L[i] = Math.tanh(L[i] * drive); R[i] = Math.tanh(R[i] * drive); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
const norm = 0.84 / peak;
const pcm = Buffer.alloc(44 + N * 4);
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + N * 4, 4); pcm.write('WAVE', 8); pcm.write('fmt ', 12);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22); pcm.writeUInt32LE(SR, 24);
pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const t = i / SR, fade = Math.min(1, t / 0.012) * (t > DUR - 0.35 ? (DUR - t) / 0.35 : 1);
  pcm.writeInt16LE(Math.round(clamp(L[i] * norm * fade, -1, 1) * 32767), 44 + i * 4);
  pcm.writeInt16LE(Math.round(clamp(R[i] * norm * fade, -1, 1) * 32767), 46 + i * 4);
}
const out = process.argv[2] || 'score.wav';
fs.writeFileSync(out, pcm);
console.log(`${out}  raw peak ${raw.toFixed(2)}`);
