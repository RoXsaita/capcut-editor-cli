# capcutctl

`capcutctl` is a transactional control layer for local CapCut projects. It edits CapCut's native draft model directly while keeping the project editable in CapCut. It does not render layouts with FFmpeg, replace raw footage with flattened montages, or treat a single `draft_info.json` as the whole project.

The first release is deliberately conservative: it focuses on the operations that repeatedly broke real projects—root/active-timeline drift, temporary media paths, stale IDs, missing bound mask materials, partial writes, unsafe edits while CapCut is auto-saving, and silent corruption across `.bak`/`.tmp` mirrors.

## Safety model

Every write command:

1. Resolves the project and active timeline from `Timelines/project.json`.
2. Refuses to write while CapCut is running, unless `--force-running` is explicitly supplied.
3. Reads the root draft and active timeline as separate authoritative documents.
4. Applies the same semantic operation to both documents instead of copying one over the other.
5. Validates material files, material/segment IDs, attached refs, source/target ranges, duration, transforms, and same-track overlaps.
6. Creates a recoverable snapshot under `.capcutctl/history/`.
7. Stages every JSON write beside its target, parses it again, then atomically renames it.
8. Synchronizes each document's `draft_info.json`, `draft_info.json.bak`, and `template-2.tmp` mirrors.
9. Runs a post-write doctor; any failure restores the snapshot.

## Install locally

```bash
cd /path/to/capcut-editor-cli
npm link
capcutctl help
```

Or run without installation:

```bash
node bin/capcutctl.mjs help
```

Node.js 20 or newer is required. There are no runtime dependencies.

## Core commands

```bash
# Discover projects
capcutctl projects

# Understand the real root + active timeline structure
capcutctl inspect --project grok-build-gpt

# Read-only integrity report
capcutctl doctor --project grok-build-gpt

# Explicit backup
capcutctl snapshot --project grok-build-gpt --label before-layout-pass

# List and manually restore snapshots
capcutctl history --project grok-build-gpt
capcutctl restore --project grok-build-gpt --snapshot 2026-08-24T10-00-00-before-layout-pass

# Preview a semantic edit with no writes or media copies
capcutctl apply --project grok-build-gpt --spec edit.json --dry-run

# Commit after closing CapCut
capcutctl apply --project grok-build-gpt --spec edit.json

# Repair drift among each live document's JSON/.bak/.tmp mirrors
capcutctl sync --project grok-build-gpt --dry-run
capcutctl sync --project grok-build-gpt
```

## Edit specification

Specs are JSON and versioned. Supported v1 operations:

### `segment.patch`

Deep-merges native CapCut segment properties. Use this for clip transforms, volume, speed, mask enablement, render indices, and exact CapCut-owned geometry.

```json
{
  "op": "segment.patch",
  "selector": { "id": "SEGMENT-ID" },
  "set": {
    "volume": 0,
    "clip": {
      "scale": { "x": 0.8, "y": 0.8 },
      "transform": { "x": 0, "y": -0.05 }
    }
  }
}
```

Selectors support `id`, `desc`, `material_id`, `trackIndex`, and `trackType`. A selector must be unique unless `"all": true` is explicit. Use `"optional": true` when a legitimate root/timeline variation may omit the item.

### `segment.clone`

Clones an existing native CapCut segment and its dependent extra materials with fresh UUIDs. This preserves CapCut speed/canvas/mask/vocal-separation bindings instead of manufacturing incomplete segments.

```json
{
  "op": "segment.clone",
  "from": { "id": "TEMPLATE-SEGMENT-ID" },
  "track": { "index": 4 },
  "material": { "id": "RAW-MEDIA-ID" },
  "target": { "start": 12.4, "duration": 2.8 },
  "source": { "start": 87.1, "duration": 2.8 },
  "set": { "volume": 0, "desc": "Mapped UI action" }
}
```

Times may be seconds or CapCut microseconds. Values above `100000` are treated as microseconds.

### `segment.remove`

Removes selected segments and prunes now-unreferenced attached materials by default.

### `mask.patch`

Edits a bound native CapCut mask material. It fails if a segment has no mask or has multiple ambiguous masks.

### `material.relink`

Relinks raw media and can copy it into `Resources/CapcutctlMedia` so CapCut's sandbox can access it reliably.

```json
{
  "op": "material.relink",
  "selector": { "id": "MEDIA-ID" },
  "path": "/absolute/path/to/raw-source.mp4",
  "localize": true
}
```

`--dry-run` never copies the file.

### `material.clone` and `track.clone`

`material.clone` duplicates a verified native CapCut material, assigns a fresh stable UUID, and optionally relinks/localizes a new raw source. `track.clone` duplicates a verified native track shell with a fresh UUID and no segments. These operations let later specs add editable raw media and layout tracks without inventing undocumented CapCut objects.

Generated segment, material, and track IDs are resolved once per transaction, so root and active-timeline documents receive the same IDs.

### `timeline.set`

Updates duration, FPS, canvas configuration, or name while preserving tracks/materials.

## Root and timeline scoping

By default an operation is applied independently to the root draft and active timeline. Restrict an operation when required:

```json
{
  "op": "segment.patch",
  "documents": ["timeline"],
  "selector": { "id": "TIMELINE-ONLY-ID" },
  "set": { "volume": 0 }
}
```

Accepted scope values are `root`, `timeline`, or the full timeline group name printed by `inspect`.

## Suheil editing contract

The bundled [`presets/suheil-vertical.json`](presets/suheil-vertical.json) records the current 1080×1920 geometry and editing rules:

- speech drives screen coverage;
- raw recordings remain raw;
- portrait UI uses CARD, landscape/gameplay uses SPLIT/PUNCH-IN;
- full-face fallback removes card, blur, PiP, and ring;
- masks, crops, transforms, keyframes, audio and effects remain native CapCut properties;
- hard cuts are the default;
- current screen/spoken/visual maps and the EDL remain the source of truth;
- final acceptance still requires rendered-pixel frame-grid QA.

The preset is documentation/data, not a magical hardcoded renderer. Future releases can add semantic layout compilers that resolve these pixel targets into native CapCut transforms only after reference-project tests prove the schema mapping.

## Creating a project

```bash
capcutctl new --project grok-demo \
  --media ~/Downloads/face.mp4 \
  --scenes 0:6@122.467,6:12@150,12:18@200
```

`--scenes` is `START:END` on the timeline, optionally `@SOURCE` for the in-point of the
media — all in seconds. Dimensions and duration come from `ffprobe`; pass `--width`,
`--height` and `--duration` if it is unavailable.

Every new project **clones `Preset 3`** by default: the branded endcard is carried over
and slid to sit immediately after your scenes, which is the duplicate-and-build-in-front
workflow. `--from NAME` uses a different template; `--blank` drops the template content
and leaves an empty timeline.

The command prints `contentTrack` — the track index your scenes landed on. Pass it to
the layout commands:

```bash
capcutctl layout split-screen --project grok-demo --at 3 --track 7
capcutctl layout circle       --project grok-demo --at 9 --track 7
capcutctl layout background   --project grok-demo
```

It also writes `.capcutctl/created.json` recording the template and the time range the
endcard occupies, so `layout background` does not blur the branded endcard when it goes
looking for circle scenes. `--include-template` overrides that.

New scenes are structural clones only — masks, effects, filters and animations are
deliberately **not** inherited from the template segment. (Preset 3's backdrop carries a
Blur; cloning it wholesale silently blurred every new scene.)

`new` refuses to overwrite an existing project, refuses to run while CapCut is open,
backs up `root_meta_info.json` before registering the draft, and stages that write
through a parse-then-rename like every other write.

## Deterministic layouts

The three recurring looks are measured geometry, not judgement. They live in
[`presets/layouts.json`](presets/layouts.json), captured verbatim from the
`grok-build-claude` timeline, and are applied by name:

```bash
# what is in the project, and how each scene is currently styled
capcutctl scenes --project grok-build-gpt
capcutctl layout list

# subject fills the BOTTOM half from y=960, indigo bar on the seam
capcutctl layout split-screen --project grok-build-gpt --at 1.5,41.5 --track 8

# subject as the upper-left circular avatar, inside the white ring
capcutctl layout circle --project grok-build-gpt --at 6 --track 6

# find every circle scene that has a ring, build the blurred backdrop under it
capcutctl layout background --project grok-build-gpt
```

Select scenes with `--segments ID[,ID]` or `--at SECONDS[,SECONDS]`. When a time
matches segments on several tracks the command refuses and names them, so you
re-run with `--track N` rather than guessing. `--dry-run` previews; `--no-overlay`
applies the subject geometry without the companion bar/ring.

### The geometry model

Verified against the reference project to 1px:

```
k0        = min(W/sw, H/sh)         # scale 1.0 == FIT the source inside the canvas
displayed = (sw*k0*scale.x, sh*k0*scale.y)
centre    = (W/2 + tx*W/2,  H/2 - ty*H/2)        # transform: half-canvas units, y UP
mask pos  = (w/2 + cX*w/2,  h/2 - cY*h/2)        # half-CLIP units, y UP
mask size = (width*w, height*h)                  # full-clip fractions
```

Z-order follows **track order**; `render_index` is preserved but is not authoritative.
Overlays are therefore placed on a track above the subject and the blur plate on a
track below it, and `track_render_index` is renumbered after any insert.

### Guarantees

- **Same ids in both documents.** Layout ops mint ids as `sha256(transaction seed,
  stable key)` rather than randomly, so the root draft and the active timeline stay
  byte-identical. Random `uuid()` inside an op would silently drift them apart.
- **Idempotent.** Re-running a layout replaces the overlay covering that exact span —
  including a hand-built one that already uses the same asset — instead of stacking
  duplicates.
- **Nothing invented.** Masks, overlay segments, the blur effect and the photo material
  are instantiated from structures captured out of a real CapCut project.
- **Same safety path.** `layout` builds an ordinary v1 spec, so it inherits the
  snapshot, both-document application, mirror sync, post-write doctor and rollback.

### Rendered-pixel QA

`doctor` validates structure and cannot see the picture. To check the frame itself:

```bash
python3 ~/.claude/skills/capcut-editing/scripts/frame_qa.py \
  --project grok-build-gpt --times 1.5,6,41.5 --guide 960 --out qa/
```

It composites any timeline frame outside CapCut and prints each segment's on-canvas
rect.

## Recovery

Snapshots live inside the project:

```text
grok-build-gpt/.capcutctl/history/<timestamp>-<label>/
```

On a failed transaction, `capcutctl` restores the snapshot automatically. Snapshot manifests include SHA-256 hashes and remember which live mirror files did not exist before the transaction.

## Development

```bash
npm test
npm run check
```

The tests use synthetic projects and never touch the user's CapCut library.

## Scope of v0.1

This release provides the stable foundation: discovery, active-timeline resolution, doctoring, snapshots/manual restore, mirror synchronization, atomic rollback, safe relinking and native material cloning, track cloning, segment patch/clone/remove, bound-mask editing, and timeline metadata updates.

It intentionally does not yet invent CapCut effect/keyframe structures from scratch. The safer next step is to capture tested templates from real CapCut projects, then add semantic commands such as `layout card`, `layout split`, `zoom-to-bbox`, and `spotlight` that clone verified native structures rather than guessing undocumented fields.
