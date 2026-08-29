import path from 'node:path';
import { principalTrack } from './polish.mjs';

const S = us => us / 1e6;

function col(t, duration, width) {
  if (duration <= 0) return 0;
  return Math.min(width - 1, Math.max(0, Math.floor(t / duration * width)));
}

function sfxChar(name) {
  const n = name || '';
  if (/Decision/i.test(n)) return 'D';
  if (/Woosh|woosh|swish/i.test(n)) return 'W';
  if (/Glitch/i.test(n)) return 'G';
  if (/Coin/i.test(n)) return '$';
  if (/Pop/i.test(n)) return 'P';
  if (/Culin/i.test(n)) return 'C';
  if (/click|Click|mouse|Mouse|Enter|Typing|keyboard/i.test(n)) return 'k';
  return 's';
}

function videoChar(segment, material) {
  const desc = segment.desc || '';
  const file = path.basename(material?.path || '');
  if (desc.startsWith('sig:logo') || /logo/i.test(file) && material?.type === 'photo') return 'L';
  if (desc.startsWith('layout:seam') || /suheilai-rect/i.test(file)) return '─';
  if (/circle-1080/i.test(file)) return '○';
  if (desc.startsWith('sig:')) return 'L';
  if (material?.type && material.type !== 'video') return '□';
  if (desc.startsWith('broll:') || /Screen_Recording|screen\.mp4|gameplay/i.test(file)) return '▓';
  return '█';
}

/**
 * One-screen CapCut-style dump. Width is the number of time columns (default 64).
 * `▼` marks a transition on the clip that owns it.
 */
export function renderTimeline(doc, { width = 64 } = {}) {
  const duration = S(doc.duration || 0);
  const W = Math.max(24, Math.min(120, Number(width) || 64));
  const videos = new Map((doc.materials?.videos || []).map(m => [m.id, m]));
  const audios = new Map((doc.materials?.audios || []).map(m => [m.id, m]));
  const trans = new Set((doc.materials?.transitions || []).map(m => m.id));
  const texts = new Map((doc.materials?.texts || []).map(m => [m.id, m]));

  const ruler = Array(W).fill(' ');
  for (let sec = 0; sec <= duration; sec += 5) {
    const c = col(sec, duration, W);
    const label = String(sec);
    for (let k = 0; k < label.length && c + k < W; k++) ruler[c + k] = label[k];
  }

  let principalIndex = -1;
  try { principalIndex = principalTrack(doc).index; } catch { /* no face track */ }

  const rows = [];
  for (const [i, track] of (doc.tracks || []).entries()) {
    const n = (track.segments || []).length;
    if (track.type === 'video' && track.flag === 0 && n === 0) continue;
    const cells = Array(W).fill('·');
    const marks = Array(W).fill(' ');
    for (const s of track.segments || []) {
      const tr = s.target_timerange;
      if (!tr) continue;
      const start = S(tr.start), end = start + S(tr.duration);
      const a = col(start, duration, W);
      let b = col(end, duration, W);
      if (b <= a) b = a + 1;
      let ch = '·';
      if (track.type === 'audio') ch = sfxChar(audios.get(s.material_id)?.name);
      else if (track.type === 'text' || texts.has(s.material_id)) ch = 'T';
      else ch = videoChar(s, videos.get(s.material_id));
      for (let x = a; x < Math.min(b, W); x++) cells[x] = ch;
      if ((s.extra_material_refs || []).some(id => trans.has(id))) marks[a] = '▼';
    }
    const kind = track.type === 'audio' ? 'a' : track.type === 'text' ? 't' : 'v';
    const role = track.name
      || (i === principalIndex ? 'face' : kind === 'v' ? `t${i}` : `t${i}`);
    rows.push({
      index: i,
      name: track.name || '',
      type: track.type,
      label: `${i}:${String(role).slice(0, 12)}`,
      cells: cells.join(''),
      marks: marks.join(''),
      segments: n,
    });
  }

  const header = [
    `${(doc.name || 'timeline')}  ${duration.toFixed(1)}s  ${W} cols`,
    `· gap  █ face  ▓ b-roll  ─ seam  L logo  T text  □ plate`,
    `sfx D decision  W woosh  G glitch  $ coin  P pop  C culin  k click  ▼ transition`,
    '',
    `${'track'.padEnd(15)} ${ruler.join('')}`,
  ];
  const body = [];
  for (const row of rows) {
    if (row.marks.trim()) body.push(`${''.padEnd(15)} ${row.marks}`);
    body.push(`${row.label.padEnd(15)} ${row.cells}`);
  }
  return { duration, width: W, rows, text: [...header, ...body].join('\n') };
}
