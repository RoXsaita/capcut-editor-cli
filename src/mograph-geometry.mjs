/**
 * Pure geometry shared by the mograph renderer and the `mograph.place` op: where a rendered
 * box lands in CapCut's clip units, and whether it intrudes on the platform UI.
 */
import { loadProfile } from './profile.mjs';

/** Does a canvas box intersect any forbidden platform-UI zone? */
export function safeZoneViolations(box, profile = loadProfile()) {
  return (profile.safeZones?.forbidden || []).filter(z =>
    box.x < z.x + z.w && box.x + box.w > z.x && box.y < z.y + z.h && box.y + box.h > z.y)
    .map(z => z.name);
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
