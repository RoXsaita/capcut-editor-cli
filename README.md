# capcutctl

**Unofficial.** Not affiliated with ByteDance or CapCut. MIT licensed — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

`capcutctl` is a transactional control layer for local CapCut projects. It edits CapCut's native draft model directly while keeping the project editable in CapCut. It does not render layouts with FFmpeg, replace raw footage with flattened montages, or treat a single `draft_info.json` as the whole project.

Since 0.1.1 it also refuses to let *you* do those things on the way in — see [The origin contract](#the-origin-contract).

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

Setting this up on a machine that has never run it? Read **[SETUP.md](SETUP.md)** —
it covers this CLI, the skills repo, and what will not resolve on a new Mac.

```bash
cd /path/to/capcut-editor-cli
npm link
python3 -m pip install -e .    # NumPy and Pillow, for qa / preview / review
capcutctl help
```

Or run without installation:

```bash
node bin/capcutctl.mjs help
```

Node.js 20 or newer is required, plus **Python 3.11+** and **ffmpeg / ffprobe** on PATH
(`brew install ffmpeg python@3.11`). There are no npm runtime dependencies; the Python
ones are declared in `pyproject.toml`.

`cut`, `qa`, `find`, `preview` and `review` are Node front ends over `tools/*.py`, so the
interpreter matters: `capcutctl` resolves a declared one (`$CAPCUTCTL_PYTHON`, then a
project `.venv`, then `$VIRTUAL_ENV`, then a named `python3.N` ≥ 3.11, then ambient
`python3`) rather than spawning whatever PATH offers first. Stock macOS still ships 3.9.6,
which cannot run them. A missing or too-old interpreter is a named error with the install
command, not an import traceback. See [SETUP.md](SETUP.md#the-python-runtime).

```bash
capcutctl preflight     # checks deps, the Python runtime, artwork, SFX palette, drafts folder
```

## Development checks

```bash
scripts/check.sh            # every gate CI runs; names any it could not run on this machine
scripts/check.sh --strict   # and treats a gate it could not run as a failure
```

Or individually:

```bash
npm run check                       # JavaScript syntax
npm test                            # needs ffmpeg; the cut.recut suite builds real media
python3 tools/aroll.py --selftest
ruff check tools/
vulture tools/ --min-confidence 80
shellcheck scripts/check.sh
```

`scripts/check.sh` is the local mirror of CI. A gate it could not run is reported as
**skipped**, never folded into "all checks passed" — a green local run missing three
linters is not the same answer as a green CI run.

Pull requests run the Node, Python, and shell quality suite. A separate read-only
reviewer comments on PRs. See [`.github/AUTOMATION.md`](.github/AUTOMATION.md).

macOS only, not in CI: `swiftc -O -o tools/vision/ocr tools/vision/ocr.swift`

## Style — ask once

This repo ships a default house style (Suheil / suheilai): 9:16, overlays-only,
measured split-screen / circle / full-face layouts, `polish` / `pace` / `wrap`
grammar, and `presets/brands.json` spoken aliases.

**Agents: on a new user or a new machine, ask which they want before writing a
project. Do not silently apply the bundled look.**

1. **Keep the bundled house style.** Use `presets/layouts.json`, `sfx.json`,
   `signature.json`, and `suheil-vertical.json` as-is. Point `brands.json` at
   their logo rasters (or keep the names and drop files under `~/Downloads/Logos`).
2. **Harvest their own CapCut edits.** They already have a look.
   `capcutctl harvest` catalogues transitions, SFX, and keyframes from *their*
   drafts. Treat that as the style source; do not run `polish` / `wrap` as if
   the bundled pairings were theirs.
3. **Build their own style.** `capcutctl new --blank` (or `--from` a draft they
   name). Skip `polish`, `wrap`, and branded endcards until they say what they
   want.

`capcutctl new` defaults to cloning a local draft named `Preset 3` when it exists;
pass `--from NAME` to clone a different one. `--blank` needs no local draft at all —
it builds from `presets/blank-draft.json`, a real CapCut draft stripped down to its
track shells and CapCut-owned defaults, so a fresh install can create a project on a
machine that has never had one.

### What ships with the tool, and what is yours

Run this first on any new machine:

```bash
capcutctl preflight
```

It reports the dependencies, the overlay artwork, the SFX palette and your CapCut drafts
folder, and names the fix for anything missing. Exit code 1 if the install cannot work.

**Required:** Node.js 20+, **Python 3.11+** with NumPy and Pillow (`python3 -m pip install -e .`),
and **ffmpeg / ffprobe** on PATH (`brew install ffmpeg`) — `cut`, `qa`, `find`, `preview`,
`music` and `review` all shell out to them.

**Optional:** transcription for `cut` (`uv tool install mlx-whisper`, or
`python3 -m pip install -e '.[whisper]'`). Deliberately not installed by default: both pull
large wheels and download model weights on first use.

| What | Where it comes from | On a new machine |
|---|---|---|
| Overlay artwork (the indigo bar, the white ring) | **bundled** in `assets/` | Works with no setup. The geometry in `layouts.json` is measured against these exact pixels. |
| SFX + transition palette | CapCut's own `…/Cache/effect` and `…/Cache/music` | **Cannot be shipped** — CapCut mints those ids when *you* download a sound. `polish` skips any sound that is not present and names it in its output, rather than writing a reference that fails validation. |
| Brand logos | `~/Downloads/Logos`, `~/Downloads/Media/Images/2026` | Third-party marks, not redistributable. `capcutctl brands` lists which have a usable PNG and which do not. |

Two environment variables let you bring your own instead:

```bash
export CAPCUTCTL_ASSET_DIR=~/my-overlays     # searched BEFORE the bundled assets/
export CAPCUTCTL_PRESET_DIR=~/my-presets     # your own sfx.json / brands.json / layouts.json
```

`CAPCUTCTL_PRESET_DIR` falls back per file, so a directory containing only `sfx.json`
overrides the palette and leaves the layouts alone. To adopt the bundled palette instead,
download the same sounds in CapCut and run `capcutctl harvest` to capture your machine's ids.

`presets/harvest.json` is **not** in the repo — it is a capture of the local CapCut drafts
root and names every project on the machine that produced it. Run `capcutctl harvest` to write
your own; nothing in the shipped code reads it.

## The origin contract

The deliverable is a project a human finishes by hand. That only holds while every framing
decision is still a CapCut property they can drag. Two ways of importing media quietly end that,
and both happened on a real edit:

- **Pre-framed media.** B-roll cropped and scaled from 1920x1080 to 1080x960 with FFmpeg, then
  imported and placed with an identity transform. The picture is correct and `doctor` passes —
  which is exactly the problem. The rows outside the crop are gone, so the shot can never be
  reframed, zoomed elsewhere, or moved to another layout.
- **Ephemeral origins.** Media imported from an agent session's scratchpad. The bytes are copied
  into `Resources/`, so the project plays, but the original recorded in `media-map.json` points
  at a directory that no longer exists. The trail back to the footage is gone permanently.

`add`, `replace-media`, `layout screen`, `new --media` — and any `apply --spec` carrying
`clip.add` / `replace.media` / `layout.screen` — refuse both before anything is written:

| Code | Trigger |
|---|---|
| `PREFRAMED_MEDIA` | The file is exactly half the canvas. Capture devices do not produce that size; a crop does. |
| `EPHEMERAL_MEDIA` | The source is under `/tmp`, `$TMPDIR`, `/var/folders`, or a `scratchpad/` directory. |

Express the framing in CapCut instead — `layout broll --row SOURCE_PIXEL_ROW` and
`layout screen` write `clip.scale` + `clip.transform` + the seam mask onto the full-frame source,
producing the same picture from geometry the human can still change.

Two honest escapes, both recorded on the material and in `media-map.json`:

```bash
capcutctl add --project P --media gfx.mp4 --at 9 --dur 2.8 --track broll --generated
capcutctl add --project P --media cut.mp4 --at 9 --dur 2.8 --track broll \
  --derived-from ~/Desktop/Screen\ Recordings/screen-1/screen.mp4 --derived-offset 220
```

`--generated` is for a render with no editable original (Remotion, After Effects). `--derived-from`
is for deliberate pre-processing, and is accepted only when it names a real, durable file.

A project whose own directory is temporary is exempt from the ephemeral check — it cannot outlive
its own media. For projects built before the contract, `capcutctl doctor` reports
`MEDIA_PREFRAMED` and `MEDIA_ORIGIN_LOST` as **warnings**: the repair is a judgement call, not
something to fail a load over.

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

## Agent-reviewed A-roll decisions

`cut` separates editorial judgement from timing mechanics. The first pass writes a numbered
`VIDEO.aroll.json` handout. An agent can then keep useful beats, put them in a deliberate order,
and trim excessive indexed silence without ever choosing a raw Whisper timestamp:

```bash
capcutctl cut "Face Takes.mp4" --lang ar
capcutctl cut "Face Takes.mp4" \
  --keep 0,2-3,6-10,12-13,16-18,21 \
  --order 0,2,3,6,7,8,9,10,12,13,16,17,18,21 \
  --trim-beat 10:out=-1.16 \
  --trim-beat 18:out=-1.72 \
  --recover-beat 21:out=0.8 \
  --project "A-roll Review" --dry-run
```

`--keep` remains backward compatible: when `--order` is omitted, retained ids are placed in
source order. If `--order` is present it must be an exact permutation of the kept ids. Repeated
`--trim-beat ID:in=SECONDS` and `ID:out=SECONDS` values are inward-only hints; the CLI resolves
them against the acoustic index, quantizes them to the project FPS, and snaps them to a safe
onset/trough. IN offsets are positive and OUT offsets are negative. Unsafe expansion, a trim
that leaves a fragment, source overlap, a clipped trusted first word, or a stale index is
rejected before a CapCut write; `--force` never overrides first-word protection.

Outward recovery is separate and opt-in: `--recover-beat ID:out=SECONDS` searches that far
past the indexed OUT (`in` searches before IN). It expands only when the v5 index contains a
complete word there, the audio is continuous to that word, and a quiet acoustic boundary is
available afterward. It rejects silence, another take, a kept-source overlap, media bounds,
and any result that would still clip the protected first/last word. The dry run reports the
requested window, resolved frame-quantized range, word evidence, or the exact refusal reason.

For a durable review handoff, save a v1 decision file. Copy `sourceToken` exactly from the
current `source_token` field in `Face Takes.aroll.json`:

```json
{
  "version": 1,
  "sourceToken": {
    "ino": 123, "inode": 123, "size": 456, "mtime_ns": 789,
    "content_hash": "...", "fingerprint": "..."
  },
  "keep": [0, 2, 3, 6, 7, 8, 9, 10, 12, 13, 16, 17, 18, 21],
  "order": [0, 2, 3, 6, 7, 8, 9, 10, 12, 13, 16, 17, 18, 21],
  "boundaries": {
    "10": { "outOffset": -1.16 },
    "18": { "outOffset": -1.72 }
  },
  "recoveries": {
    "21": { "out": 0.8 }
  }
}
```

Run it against a new project or an existing one with the same reviewed plan:

```bash
capcutctl cut "Face Takes.mp4" --review decisions.json --project "A-roll Review" --dry-run
capcutctl cut "Face Takes.mp4" --review decisions.json --into "Existing Project" --dry-run
capcutctl cut "Face Takes.mp4" --review decisions.json --into "Existing Project"
```

The dry run prints the final order, complete source/target ranges, resolved adjustments, repairs,
and lint; the resolved plan also records the source token, FPS, and 1× source/target durations.
`--into` uses the transactional `cut.recut.v1` path, so anchored
B-roll, layouts, SFX, music, snapshots, mirror synchronization, idempotency, and rollback
remain in one operation. Dry runs write no CapCut draft files.

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

Every new project **clones `Preset 3`** by default: the leftover clips are parked 30s after
the talking head (a parts bin — not the ending). Follow/CTA is written on the talking head.
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

`doctor` is structural validation: it checks IDs, mirrors, timing, media and references, but
cannot see the picture. `qa` is targeted native-resolution pixel evidence:

```bash
capcutctl qa --project grok-build-gpt --times 1.5,6,41.5 --guide 960 --out qa/
capcutctl qa --project grok-build-gpt --at-cuts --sheet --out qa/cuts/
capcutctl qa --project grok-build-gpt --at-cuts --cut-window 0.08 --out qa/cuts/
```

`--at-cuts` samples one frame on each side of every visual cut; the samples stay at the
timeline's original resolution. `--times`, `--at-scenes`, and `--at-broll` select bounded
additional evidence. A contact sheet is optional. These targeted selectors and `--sheet`
cannot be combined with a motion preview, because a movie does not verify the same frames.

For a watchable proxy, request a separate streamed job:

```bash
capcutctl preview --project grok-build-gpt --out qa/review.mp4
capcutctl preview --project grok-build-gpt --out qa/native.mp4 --native --no-cache
```

Previews default to a 360x640 aspect-preserving proxy. Plain A-roll uses one ffmpeg
trim/concat graph for video and speech; composited timelines stream resized raw frames into
one encoder. No per-frame PNGs are materialised. The command prints its range, resolution,
CFR frame estimate, mode, elapsed time and ETA, and caches successful previews under
`.capcutctl/preview-cache/`. The cache key includes the draft/media fingerprint, range, FPS,
resolution, z-order and compositor version.

The automated proxy visual regression compares sampled frames with the native compositor at
the same timestamps and allows a mean per-channel error of 8/255 for H.264 colour rounding.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests welcome. Never force-push `main`.
One job per PR. Do not commit `.env`, `presets/harvest.json`, compiled OCR, or media.

Companion repo: [`capcut-skills`](https://github.com/RoXsaita/capcut-skills).
A CLI change and the skill that documents it should land as a pair.

## Scope of v0.1

This release provides the stable foundation: discovery, active-timeline resolution, doctoring, snapshots/manual restore, mirror synchronization, atomic rollback, safe relinking and native material cloning, track cloning, segment patch/clone/remove, bound-mask editing, and timeline metadata updates.

It intentionally does not yet invent CapCut effect/keyframe structures from scratch. The safer next step is to capture tested templates from real CapCut projects, then add semantic commands such as `layout card`, `layout split`, `zoom-to-bbox`, and `spotlight` that clone verified native structures rather than guessing undocumented fields.
