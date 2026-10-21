/**
 * Pure geometry shared by the mograph renderer and the `mograph.place` op: where a rendered
 * box lands in CapCut's clip units, and whether it intrudes on the platform UI.
 */
import { loadProfile } from './profile.mjs';

const hits = (box, z) => box.x < z.x + z.w && box.x + box.w > z.x && box.y < z.y + z.h && box.y + box.h > z.y;

/** Does a canvas box intersect any forbidden platform-UI zone? */
export function safeZoneViolations(box, profile = loadProfile()) {
  return (profile.safeZones?.forbidden || []).filter(z => hits(box, z)).map(z => z.name);
}

/**
 * The numbers behind a safe-zone refusal: every zone the box intersects with its overlap in
 * px, and `suggestCenter` — the centre of the box after the smallest single horizontal or
 * vertical shift that clears every zone and stays on the canvas (null when none does). The
 * box is centred on the graphic, so that centre is the params.center to try.
 */
export function safeZoneAdvice(box, profile = loadProfile()) {
  const zones = profile.safeZones?.forbidden || [];
  const canvas = profile.canvas || { width: 1080, height: 1920 };
  const found = zones.filter(z => hits(box, z)).map(z => ({
    name: z.name, zone: { x: z.x, y: z.y, w: z.w, h: z.h },
    overlapX: Math.round(Math.min(box.x + box.w, z.x + z.w) - Math.max(box.x, z.x)),
    overlapY: Math.round(Math.min(box.y + box.h, z.y + z.h) - Math.max(box.y, z.y)),
  }));
  if (!found.length) return { hits: [], shift: null, suggestCenter: null };
  const shifts = found.flatMap(({ zone: z }) => [
    { x: Math.floor(z.x - (box.x + box.w)), y: 0 }, { x: Math.ceil(z.x + z.w - box.x), y: 0 },
    { x: 0, y: Math.floor(z.y - (box.y + box.h)) }, { x: 0, y: Math.ceil(z.y + z.h - box.y) },
  ]);
  let best = null;
  for (const shift of shifts) {
    const moved = { ...box, x: box.x + shift.x, y: box.y + shift.y };
    if (moved.x < 0 || moved.y < 0 || moved.x + moved.w > canvas.width || moved.y + moved.h > canvas.height) continue;
    if (zones.some(z => hits(moved, z))) continue;
    if (!best || Math.abs(shift.x) + Math.abs(shift.y) < Math.abs(best.x) + Math.abs(best.y)) best = shift;
  }
  return {
    hits: found,
    shift: best,
    suggestCenter: best ? [Math.round(box.x + best.x + box.w / 2), Math.round(box.y + best.y + box.h / 2)] : null,
  };
}

/** One line for a MOGRAPH_SAFE_ZONE message: the box, each overlap and the centre to try. */
export function safeZoneText(box, advice) {
  const where = advice.hits.map(h => `${h.name} [${h.zone.x},${h.zone.y} ${h.zone.w}×${h.zone.h}] by ${h.overlapX}×${h.overlapY}px`);
  return `box [${box.x},${box.y} ${box.w}×${box.h}] overlaps ${where.join(', ')}; `
    + (advice.suggestCenter ? `try params.center [${advice.suggestCenter.join(', ')}]` : 'no single move clears it: make it smaller');
}

/** CapCut clip geometry for a canvas-pixel box: media is fitted to the canvas at scale 1. */
export function placementFor(box, canvas = { width: 1080, height: 1920 }, renderScale = 1) {
  const mw = box.w * renderScale, mh = box.h * renderScale;
  const fit = Math.min(canvas.width / mw, canvas.height / mh);
  const scale = box.w / (mw * fit);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return {
    scale,
    x: (cx - canvas.width / 2) / (canvas.width / 2),
    y: (canvas.height / 2 - cy) / (canvas.height / 2),
    width: mw,
    height: mh,
  };
}
