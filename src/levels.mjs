/**
 * Carry hand-set levels across a rebuild.
 *
 * The ops that own their segments (mograph.place, signature, polish) delete and re-create them
 * on every run, so a `mograph rerender` or a second `build` handed every pop and SFX cue the
 * preset volume (1.0) again and dropped any CapCut fade, and the levels had to be fixed by hand
 * after each pass. Snapshot the owned segments before the op removes them, then give each
 * replacement its predecessor's volume and fade.
 *
 * A replacement is matched on its desc (the owner tag) and, when several segments share a desc,
 * on the nearest start within `tolerance` seconds. A segment the op did not replace keeps its own
 * values. `keepVolume: false` carries the fade only, for an op that was given an explicit volume.
 */
import { clone } from './core.mjs';

const r3 = n => Math.round(n * 1000) / 1000;

function fadeOf(doc, segment) {
  const fades = new Map((doc.materials?.audio_fades || []).map(f => [f.id, f]));
  const id = (segment.extra_material_refs || []).find(ref => fades.has(ref));
  return id ? fades.get(id) : null;
}

export function snapshotLevels(doc, owns) {
  const rows = [];
  for (const track of doc.tracks || []) {
    for (const s of track.segments || []) {
      if (!owns(s)) continue;
      const fade = fadeOf(doc, s);
      rows.push({
        segment: s, desc: s.desc || '', start: s.target_timerange?.start || 0,
        volume: s.volume ?? 1, lastNonzero: s.last_nonzero_volume,
        fade: fade && (fade.fade_in_duration || fade.fade_out_duration) ? clone(fade) : null,
      });
    }
  }
  return rows;
}

export function carryLevels(doc, snapshot, { owns, mint, tolerance = Infinity, keepVolume = () => true }) {
  // Survivors are the same objects; a replacement may reuse its predecessor's seeded id.
  const kept = new Set(snapshot.map(row => row.segment));
  const live = new Set((doc.tracks || []).flatMap(t => t.segments || []));
  const pool = snapshot.filter(row => !live.has(row.segment));
  const carried = [];
  for (const track of doc.tracks || []) {
    for (const s of track.segments || []) {
      if (!owns(s) || kept.has(s)) continue;
      const start = s.target_timerange?.start || 0;
      let best = -1;
      for (const [i, row] of pool.entries()) {
        if (row.desc !== (s.desc || '') || Math.abs(row.start - start) > tolerance * 1e6) continue;
        if (best < 0 || Math.abs(row.start - start) < Math.abs(pool[best].start - start)) best = i;
      }
      if (best < 0) continue;
      const [row] = pool.splice(best, 1);
      const change = {};
      if (keepVolume(s) && row.volume !== (s.volume ?? 1)) {
        change.volume = { from: r3(s.volume ?? 1), to: r3(row.volume) };
        s.volume = row.volume;
        if (row.lastNonzero != null) s.last_nonzero_volume = row.lastNonzero;
        else if ('last_nonzero_volume' in s && row.volume > 0) s.last_nonzero_volume = row.volume;
      }
      if (row.fade) {
        const existing = fadeOf(doc, s);
        if (existing) {
          existing.fade_in_duration = row.fade.fade_in_duration;
          existing.fade_out_duration = row.fade.fade_out_duration;
        } else {
          const fade = { ...clone(row.fade), id: mint(`fade:${s.id}`) };
          // a stable seed re-mints the same id: drop the orphan a previous pass left under it
          doc.materials.audio_fades = (doc.materials.audio_fades || []).filter(f => f.id !== fade.id);
          doc.materials.audio_fades.push(fade);
          s.extra_material_refs = [...(s.extra_material_refs || []), fade.id];
        }
        change.fade = { in: r3((row.fade.fade_in_duration || 0) / 1e6), out: r3((row.fade.fade_out_duration || 0) / 1e6) };
      }
      if (Object.keys(change).length) carried.push({ id: s.id, desc: s.desc, ...change });
    }
  }
  return carried;
}
