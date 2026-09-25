/**
 * Scene sound — every scene's cues, synthesised to a WAV on the scene's own clock.
 *
 * A scene declares `cues(params, K)`: [{ at: seconds, kind, …options }]. Nothing here is a
 * sample file, so a scene sounds identical on every machine and a cue can never go missing.
 * The kinds are the vocabulary of the showreel score (examples/showreel/score.mjs), tuned as
 * SFX that sit under a voice and a music bed rather than as a track of their own:
 *
 *   impact  { gain }                          sub drop + noise burst + kick: a scene's big hit
 *   kick    { gain }
 *   thud    { gain, f0, f1 }                  a landing (letters, a ball, a dot)
 *   click   { gain, pan, tone }               a grid line, a UI tick
 *   blip    { gain, pan, f | note, dur }      a sine ping (a dot appearing, a shape popping)
 *   pluck   { gain, pan, f | note }           a saw pluck (cells, arpeggios)
 *   bell    { gain, pan, f | note, dur }      FM bell (a word resolving, a name card)
 *   stab    { gain, notes: [midi…] }          a chord hit (one per style frame)
 *   whoosh  { gain, dur, from, to, q, shape: up|down|bell, pan0, pan1 }
 *   riser   { gain, dur, f0, f1 }             tone + noise sweep into a hit
 *   tone    { gain, dur, f0, f1 }             a plain pitch sweep (anticipation, a falling whistle)
 *   glitch  { gain, dur }                     bit-crushed stutter
 *   sparkle { gain, dur, density }            granular shimmer (particles)
 *
 * Output: 48 kHz stereo 16-bit, peak-normalised to -6 dBFS after a soft clip, so the clip
 * lands at a predictable level under speech; the project's loudness pass does the rest.
 */
const SR = 48000;
const TAU = Math.PI * 2;
const midi = m => 440 * 2 ** ((m - 69) / 12);

export const CUE_KINDS = Object.freeze(['impact', 'kick', 'thud', 'click', 'blip', 'pluck', 'bell', 'stab',
  'whoosh', 'riser', 'tone', 'glitch', 'sparkle']);

export function synthesize(cues, { duration, sampleRate = SR, seed = 0x2f6b1a } = {}) {
  if (!(duration > 0)) throw new Error('synthesize needs a duration');
  const N = Math.ceil(duration * sampleRate);
  const L = new Float32Array(N), R = new Float32Array(N), sL = new Float32Array(N), sR = new Float32Array(N);
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const noise = () => rand() * 2 - 1;

  function voice(t0, dur, fn, { gain = 1, pan = 0, send = 0 } = {}) {
    const s0 = Math.max(0, Math.round(t0 * sampleRate)), s1 = Math.min(N, Math.round((t0 + dur) * sampleRate));
    const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
    for (let i = s0; i < s1; i++) {
      const v = fn((i - s0) / sampleRate, i - s0);
      L[i] += v * gl; R[i] += v * gr;
      if (send) { sL[i] += v * gl * send; sR[i] += v * gr * send; }
    }
  }
  const lp = () => { let y = 0; return (x, fc) => { y += (1 - Math.exp(-TAU * fc / sampleRate)) * (x - y); return y; }; };
  const hp = () => { const f = lp(); return (x, fc) => x - f(x, fc); };
  const svf = () => { let low = 0, band = 0; return (x, fc, q = 0.5) => { const f = 2 * Math.sin(Math.PI * Math.min(fc, sampleRate / 6) / sampleRate); low += f * band; const high = x - low - q * band; band += f * high; return band; }; };
  const hz = c => (c.f != null ? c.f : midi(c.note != null ? c.note : 84));

  const K = {
    kick(t, c) {
      let ph = 0;
      voice(t, 0.45, x => { ph += TAU * (45 + 110 * Math.exp(-x * 28)) / sampleRate; return Math.tanh(1.6 * Math.sin(ph) * Math.exp(-x * 7)) + (x < 0.004 ? noise() * (1 - x / 0.004) * 0.5 : 0); }, { gain: 0.8 * (c.gain ?? 1) });
    },
    thud(t, c) {
      let ph = 0; const f0 = c.f0 ?? 150, f1 = c.f1 ?? 50;
      voice(t, 0.3, x => { ph += TAU * (f1 + (f0 - f1) * Math.exp(-x * 25)) / sampleRate; return Math.sin(ph) * Math.exp(-x * 13); }, { gain: 0.7 * (c.gain ?? 1), send: 0.1 });
    },
    click(t, c) {
      const b = svf(); const tone = c.tone ?? 3000;
      voice(t, 0.03, x => b(noise(), tone, 0.3) * Math.exp(-x * 220), { gain: 0.5 * (c.gain ?? 1), pan: c.pan ?? 0, send: 0.15 });
    },
    blip(t, c) {
      const f = hz(c), dur = c.dur ?? 0.15;
      voice(t, dur, x => Math.sin(TAU * f * x) * Math.exp(-x * (5 / dur)) * Math.min(1, x * 2000), { gain: 0.22 * (c.gain ?? 1), pan: c.pan ?? 0, send: 0.3 });
    },
    pluck(t, c) {
      const f = hz(c), fl = lp(); let ph = 0;
      voice(t, 0.35, x => { ph += f / sampleRate; return fl(2 * (ph % 1) - 1, 400 + 5000 * Math.exp(-x * 18)) * Math.exp(-x * 9); }, { gain: 0.16 * (c.gain ?? 1), pan: c.pan ?? 0, send: 0.4 });
    },
    bell(t, c) {
      const f = hz(c), dur = c.dur ?? 1.6;
      voice(t, dur, x => Math.sin(TAU * f * x + Math.sin(TAU * f * 3.5 * x) * 2.4 * Math.exp(-x * 3)) * Math.exp(-x * 2.1) * Math.min(1, x * 400), { gain: 0.15 * (c.gain ?? 1), pan: c.pan ?? 0, send: 0.6 });
    },
    stab(t, c) {
      (c.notes || [65, 68, 72]).forEach((n, k) => {
        const f = midi(n), fl = lp(); let ph = 0;
        voice(t, 0.3, x => { ph += f * (1 + (k - 1) * 0.004) / sampleRate; return fl(2 * (ph % 1) - 1, 700 + 7000 * Math.exp(-x * 16)) * Math.exp(-x * 11); }, { gain: 0.13 * (c.gain ?? 1), pan: (k - 1) * 0.4, send: 0.35 });
      });
    },
    whoosh(t, c) {
      const f = svf(), dur = c.dur ?? 0.4, from = c.from ?? 300, to = c.to ?? 6000, q = c.q ?? 0.35, shape = c.shape || 'up';
      const pan0 = c.pan0 ?? -0.6, pan1 = c.pan1 ?? 0.6, g = c.gain ?? 1;
      const s0 = Math.max(0, Math.round(t * sampleRate)), s1 = Math.min(N, Math.round((t + dur) * sampleRate));
      for (let i = s0; i < s1; i++) {
        const p = (i - s0) / Math.max(1, s1 - s0);
        const env = shape === 'up' ? p ** 2.2 : shape === 'down' ? (1 - p) ** 1.8 : Math.sin(Math.PI * p) ** 2;
        const v = f(noise(), from * (to / from) ** (shape === 'down' ? 1 - p : p), q) * env * 0.5 * g;
        const pan = pan0 + (pan1 - pan0) * p, gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
        L[i] += v * gl; R[i] += v * gr; sL[i] += v * gl * 0.3; sR[i] += v * gr * 0.3;
      }
    },
    tone(t, c) {
      let ph = 0; const dur = c.dur ?? 0.3, f0 = c.f0 ?? 220, f1 = c.f1 ?? 900;
      voice(t, dur, x => { const p = x / dur; ph += TAU * (f0 * (f1 / f0) ** p) / sampleRate; return Math.sin(ph) * Math.sin(Math.PI * Math.min(1, p * 1.1)) ** 0.5; }, { gain: 0.1 * (c.gain ?? 1), pan: c.pan ?? 0 });
    },
    riser(t, c) {
      let ph = 0, ph2 = 0; const dur = c.dur ?? 0.6, f0 = c.f0 ?? 180, f1 = c.f1 ?? 1400;
      voice(t, dur, x => { const p = x / dur, f = f0 * (f1 / f0) ** (p * p); ph += TAU * f / sampleRate; ph2 += TAU * f * 1.007 / sampleRate; return (Math.sin(ph) + Math.sin(ph2) * 0.6) * p ** 2.5 * 0.5; }, { gain: 0.22 * (c.gain ?? 1), send: 0.3 });
      K.whoosh(t, { dur, from: 400, to: 9000, q: 0.5, pan0: 0, pan1: 0, gain: 0.8 * (c.gain ?? 1) });
    },
    impact(t, c) {
      const g = c.gain ?? 1; let ph = 0; const fl = lp(), h = hp();
      voice(t, 1.4, x => { ph += TAU * (28 + 42 * Math.exp(-x * 4)) / sampleRate; return Math.tanh(2 * Math.sin(ph)) * Math.exp(-x * 2.8); }, { gain: 0.7 * g });
      voice(t, 1.1, x => fl(noise(), 200 + 5000 * Math.exp(-x * 9)) * Math.exp(-x * 4.5), { gain: 0.85 * g, send: 0.9 });
      voice(t, 0.25, x => h(noise(), 7500) * Math.exp(-x * 14), { gain: 0.25 * g });
      K.kick(t, { gain: 0.8 * g });
    },
    glitch(t, c) {
      let hold = 0, v = 0; const dur = c.dur ?? 0.3;
      voice(t, dur, (x, i) => {
        if (i % 900 === 0) hold = rand() < 0.4 ? 0 : 1;
        if (i % 6 === 0) v = Math.sign(Math.sin(TAU * (220 * (1 + Math.floor(x * 32) % 5)) * x)) * 0.6 + noise() * 0.4;
        return Math.round(v * hold * 4) / 4 * Math.exp(-x * 3);
      }, { gain: 0.16 * (c.gain ?? 1), send: 0.1 });
    },
    sparkle(t, c) {
      const dur = c.dur ?? 1.5, count = Math.round(dur * (c.density ?? 60)), scale = [77, 80, 84, 85, 89, 92, 96, 97];
      for (let k = 0; k < count; k++) {
        K.blip(t + rand() * dur, { note: scale[Math.floor(rand() * scale.length)], gain: 0.22 * (c.gain ?? 1) * (0.4 + rand()), pan: rand() * 1.6 - 0.8, dur: 0.05 + rand() * 0.08 });
      }
    },
  };

  for (const cue of cues || []) {
    if (!K[cue.kind]) throw new Error(`unknown cue kind "${cue.kind}" (known: ${CUE_KINDS.join(', ')})`);
    if (!(cue.at >= 0) || cue.at >= duration) continue;
    K[cue.kind](cue.at, cue);
  }

  // Schroeder reverb on the send bus.
  const reverb = (inp, spread) => {
    const o = new Float32Array(N);
    const combs = [1557, 1617, 1491, 1422, 1277, 1356].map(d => ({ d: d + spread, buf: new Float32Array(d + spread), i: 0, lp: 0 }));
    for (let n = 0; n < N; n++) {
      let acc = 0;
      for (const c of combs) { const y = c.buf[c.i]; c.lp = y * 0.72 + c.lp * 0.28; c.buf[c.i] = inp[n] + c.lp * 0.8; c.i = (c.i + 1) % c.d; acc += y; }
      o[n] = acc / combs.length;
    }
    for (const d of [225 + spread, 556 + spread, 441]) {
      const buf = new Float32Array(d); let i = 0;
      for (let n = 0; n < N; n++) { const b = buf[i], x = o[n]; buf[i] = x + b * 0.5; o[n] = -x + b; i = (i + 1) % d; }
    }
    return o;
  };
  const rL = reverb(sL, 0), rR = reverb(sR, 23);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    L[i] = Math.tanh((L[i] + rL[i] * 0.5) * 1.2); R[i] = Math.tanh((R[i] + rR[i] * 0.5) * 1.2);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const norm = peak > 0 ? 0.5 / peak : 0;           // -6 dBFS
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
  const fadeOut = Math.round(0.02 * sampleRate);
  for (let i = 0; i < N; i++) {
    const f = Math.min(1, i / 48, (N - i) / fadeOut);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm * f)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm * f)) * 32767), 46 + i * 4);
  }
  return buf;
}
