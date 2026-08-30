import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stableJson } from '../../src/core.mjs';

/**
 * A minimal draft with a cut principal track, which is all `polish` needs to have work to do:
 * two adjacent clips give it one seam to put a transition and a woosh on.
 */
export function buildProject() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-polish-'));
  const project = path.join(temp, 'Polish Project');
  const timelineId = 'TIMELINE-ONE';
  const media = path.join(temp, 'face.mp4');
  fs.writeFileSync(media, 'face-bytes');

  const clip = (id, start, duration, sourceStart) => ({
    id, material_id: 'VIDEO', extra_material_refs: [], desc: `scene ${id}`,
    enable_video_mask: false, speed: 1, volume: 1, render_index: 2, track_render_index: 1,
    source_timerange: { start: sourceStart, duration },
    target_timerange: { start, duration },
    clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 },
    keyframe_refs: [], common_keyframes: [],
  });

  const doc = {
    id: timelineId, name: 'Polish Project', duration: 10_000_000, fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [{ id: 'VIDEO', type: 'video', path: media, duration: 60_000_000, width: 1440, height: 2560 }],
      audios: [], common_mask: [], video_effects: [], speeds: [], transitions: [],
    },
    tracks: [
      { id: 'T0', type: 'video', flag: 0, attribute: 0, segments: [] },
      { id: 'T1', type: 'video', flag: 2, attribute: 0, name: 'content', segments: [
        clip('A', 0, 4_000_000, 0),
        clip('B', 4_000_000, 4_000_000, 10_000_000),
      ] },
    ],
  };

  const write = (dir, value) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, name), stableJson(value));
    }
  };
  write(project, doc);
  write(path.join(project, 'Timelines', timelineId), structuredClone(doc));
  fs.writeFileSync(path.join(project, 'Timelines', 'project.json'),
    stableJson({ main_timeline_id: timelineId, timelines: [{ id: timelineId }] }));
  return project;
}
