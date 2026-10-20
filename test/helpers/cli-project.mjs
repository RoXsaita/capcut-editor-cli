import fs from 'node:fs';
import path from 'node:path';

const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A minimal CapCut project on disk: root draft + one active timeline, with the mirrors a
 * transaction keeps in step. One 3-second clip `SEGMENT` on the `content` track by default;
 * `{ segments: ['A', 'B'] }` splits the same 3 seconds into clips that share one material.
 */
export function writeCliProject(root, media, { segments = ['SEGMENT'], name = 'project' } = {}) {
  const project = path.join(root, name);
  const timelineId = 'CLI-TIMELINE';
  const timelineDir = path.join(project, 'Timelines', timelineId);
  const each = Math.floor(3_000_000 / segments.length);
  const doc = {
    id: timelineId,
    name: 'CLI fixture',
    duration: 3_000_000,
    fps: 30,
    canvas_config: { ratio: '9:16', width: 1080, height: 1920, background: null },
    materials: {
      videos: [{ id: 'VIDEO', type: 'video', path: media, duration: 3_000_000, width: 1080, height: 1920 }],
      audios: [],
      common_mask: [],
      speeds: [],
      audio_fades: [],
      transitions: [],
    },
    tracks: [
      { id: 'COVER', type: 'video', flag: 0, segments: [] },
      {
        id: 'CONTENT', type: 'video', flag: 2, name: 'content', segments: segments.map((id, index) => ({
          id, material_id: 'VIDEO', extra_material_refs: [],
          enable_video_mask: false, speed: 1, volume: 1,
          source_timerange: { start: index * each, duration: each },
          target_timerange: { start: index * each, duration: each },
          clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 },
        })),
      },
    ],
  };
  for (const dir of [project, timelineDir]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ['draft_info.json', 'draft_info.json.bak', 'template-2.tmp']) {
      fs.writeFileSync(path.join(dir, file), stableJson(doc));
    }
  }
  fs.mkdirSync(path.join(project, 'Timelines'), { recursive: true });
  fs.writeFileSync(path.join(project, 'Timelines', 'project.json'), stableJson({
    main_timeline_id: timelineId, timelines: [{ id: timelineId }],
  }));
  fs.writeFileSync(path.join(project, 'draft_meta_info.json'), stableJson({ draft_name: doc.name }));
  fs.writeFileSync(path.join(project, 'draft_virtual_store.json'), stableJson({ draft_materials: [] }));
  return project;
}

/** Every file under the project, as bytes: equal before and after means nothing was written. */
export function projectFingerprint(project) {
  const entries = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(`${path.relative(project, full)}:${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(project);
  return entries.join('\n');
}
