# Q-wave: features that change how agent videos look and sound

**Status:** ready to execute · **Date:** 2026-09-18 · **Repos:** `cli` (this one) + companion `capcut-skills`  
**Audience:** subsequent agents implementing one feature at a time.

This spec is the filtered remainder of a CapCut-v9 deep-research report, crossed with
what `capcutctl` already ships (including the F01–F15 wave from 2026-09-13/14) and with
the measured house style in `capcut-editing`. It is not a transcription of the report.

The report’s headline architectural finding is already implemented. Most of its
“new CapCut primitives” would not raise the quality of *these* videos. The ceiling
is still: **the right picture at the right word, motion that does not look like a
tween, and a mix where speech wins.**

## How to use this spec

1. Read this file, then the hub + `capcut-cli` skills, then the files named in the
   feature you are implementing. Do not re-read the research report unless a harvest
   gate tells you to.
2. **One feature per commit / PR.** Pair the CLI change with the matching skill note.
3. Work in `cli/` (this git repo). Skill edits go in the companion skills repo.
4. Never hand-write `draft_info.json`. Never invent effect / mask / keyframe JSON.
   Harvest a real CapCut-authored record, clone it, mint new ids, patch timing/params.
5. Every write goes through `applySpec` (snapshot, root + active timeline, mirrors,
   doctor, rollback). `--dry-run` must mean write-nothing for transactional commands.
6. CapCut stays closed during writes. Round-trip on a **disposable copy** before
   claiming a new field is production-safe.
7. Do not flatten picture or sound with ffmpeg and import the result, except where a
   feature below explicitly allows `add --derived-from ORIGINAL`. Faces stay 1×.
8. Do not use subagents. Do not commit `.env`, `presets/harvest.json`, videos, QA
   frames, or `/Users/<name>/` paths.

When a feature is done: `npm test`, `npm run check`, `capcutctl contract` still matches
`docs/cli-contract.json`, doctor is clean on a disposable project, and the skill
docs name the new command with the same flags the contract lists.

---

## 1. What the research got right, and what it missed

The report is useful as a **schema atlas** (easing handles, UTF-16 text ranges,
`apply_target_type`, mask `feather`/`invert`/`roundCorner`, `curve_speed` as an
unproven slot). It is a poor build order for this codebase.

| Research claim | Reality in this CLI |
|---|---|
| Root `draft_info.json` may not be authoritative; nested `Timelines/<id>/` can be | **Already handled.** `documentGroups()` writes root + `Timelines/<main_timeline_id>/` independently; mirrors (`draft_info.json`, `.bak`, `template-2.tmp`) are synced; writes refuse while CapCut is open. See `src/core.mjs`. |
| Blank `local_material_id` can leave media unresolvable | Writers currently set `local_material_id = ''` on cloned video materials (`add`, `layouts`, `music`). Projects have opened on CapCut 9.4.0. **Do not “fix” this speculatively.** Only act if a disposable copy reproduces Link-media / unresolved-media after a blank id. |
| Linear keyframes look robotic | **Partially shipped** as `keyframe --ease` / `--ease-position` (F08). Harvested `FreeCurveInOut` handles live in `src/easing.mjs`. **Agents still have to pass the flag**, so most agent zooms are still `Line`. |
| Native Arabic captions, impact 5 | House style is **almost no text**. Finish law: “Captions happen outside CapCut.” Do not add captions as a default pipeline step. Opt-in only (parked below). |
| Vision auto-reframe as transforms | Building blocks exist (`keyframe --focus`, `punch`, Apple Vision OCR helper). There is **no face detector** and no virtual-camera smoother. Circle/rotated masks already refuse camera motion. |
| Dialogue mastering + ducking | `loudness` (F14) matches speech/SFX to −14 LUFS via clip `volume`. Music is out of scope. Beds are constant ~0.08 + in/out fades. **`KFTypeVolume` does not appear** in the harvested keyframe census. Ducking is unverified JSON. |
| Scoped effect layers | `grade --layer` already writes a harvested Adjust lane. Extra scene VFX contradict the library: 370/402 video effects are the background `Blur` plate. Do not build an effects picker. |
| Full mask model (feather, invert, rounded rect) | Layouts lock line/circle geometry. `mask.patch` can merge fields onto an existing bound mask. Rectangle masks already exist in drafts (harvested). Animated masks are an **open encoding**. |
| Cursor halo from telemetry | `polish` maps `click` / `typing_burst` to **SFX only**. Traces are often empty of in-capture clicks (Stop button is `in_capture: false` and skipped). Visual cursor is new. |
| Nonlinear `curve_speed` | Deliberately refused (`pace`, `ramp`, `add` keep `curve_speed: null`). F09 (`ramp`) is the verified substitute. Do not populate `curve_speed` without a same-build oracle that survives open/save. |
| Motion-blur derived B-roll | Allowed only as `--derived-from` media. Baking speed into pixels is the same class of mistake as pre-cropping. Opt-in after pace is signed off, never the default. |

The report also never saw the F-wave that already closed the previous quality list:
`match`, `find --boxes/--region/--kind`, `punch`, `ramp`, `zoom --stress`, `loudness`,
`grade --face-detail`, `verify-shots`, B-roll lint, crispness, eased keyframes.

**If an agent video still looks wrong, first ask whether the agent used those
commands.** The screen-recording skill still tells agents that semantic alignment
is “not implemented.” That documentation lag is currently a quality bug.

---

## 2. Do not rebuild (already shipped)

These are the report’s high-impact items that are **done**. Cite them; do not
reimplement.

| Capability | Command / code | Notes |
|---|---|---|
| Nested timeline + mirror writes | `documentGroups`, `executeTransaction`, `sync` | Research “first-class invariant” |
| CapCut-closed write guard | `assertCapcutClosed` | |
| Origin contract | `PREFRAMED_MEDIA`, `EPHEMERAL_MEDIA` | ffmpeg never produces timeline media |
| A-roll cut | `cut` | Whisper is semantic; energy index is the clock |
| Locked layouts | `layout auto/split-screen/circle/full-face/background/screen` | |
| Sentence → moment matcher | `match` (F01) | Weak matches stay on the face |
| OCR boxes + region tags | `find --boxes --region --kind` (F02, F05) | |
| Named-element punch-in | `punch` (F03) | Geometry from OCR, not from the model |
| Split wait / land result | `ramp` (F09) | Never `curve_speed` |
| B-roll seam lint | `BROLL_IN_MOTION` / `_OUT_MIDWORD` / `_TOO_SHORT` (F06) | |
| Blind shot verifier | `verify-shots` (F07) | CONTRADICTED blocks |
| Eased scale/position keys | `keyframe --ease --ease-position` (F08) | Round-tripped CapCut 9.4.0 |
| Stress-word face push | `zoom --stress` (F13) | Full-face only |
| Speech/SFX LUFS | `loudness` (F14) | Does not touch `loudnesses.enable` (F20) |
| Face sharpen/clarity | `grade --face-detail` (F15) | Screen recordings excluded |
| Shared adjust lane | `grade --layer` | Harvested; not a VFX dump |
| Native audio fades | `fade` | Harvested `audio_fades` |
| Mix-mode Screen glow | `logo` (not `--plain`) | Harvested mix-mode effect |
| Motivated seams + SFX | `polish --motivated` | |
| Picture-change music | `music --hits` | Speech/picture never recut |
| Pixel QA | `qa --expect`, `preview`, `export-grid` | |

Picker rows that stay **parked** (report or picker, same conclusion): F10 LUT,
F11 Resolve finishing, F16 4K export, F17 arrow stickers, F19 `curve_speed`,
F20 CapCut normalize, F21 grain, F22 number-pop, F24 word-confidence. Reasons
are in `build-picker.html` and in §7 below.

---

## 3. What actually moves quality (build this)

Ordered by viewer-visible impact ÷ risk. Stop after Q03 if time is short; that
triplet is the quality delta.

| ID | Feature | Viewer sees / hears | Effort | New CapCut fields? | Repo |
|---|---|---|---|---|---|
| **Q00** | Teach agents the matcher that already exists | Right B-roll, fewer wrong screens | S | none | **skills** |
| **Q01** | Ease camera moves by default | Zooms settle instead of sliding | S | none (F08 path) | cli + skills |
| **QI1** | Round-trip sanitation harness | Prevents silent no-ops on later writes | M | none | cli |
| **Q02** | Duck music under speech | Bed dips under words, rises in pauses | M | **harvest-gated** `KFTypeVolume` | cli + skills |
| **Q03** | Cursor halo from telemetry | Halo follows the pointer; pulses on click | M | photo + existing transform keys | cli + skills |
| **Q04** | Screen spotlight mask | Soft rounded rect isolates one UI target | M | harvested rectangle mask | cli + skills |
| **Q05** | Face reframe (Vision → keys) | Full-face stays framed as he moves | L | none (existing camera keys) | cli + skills |
| **Q06** | Opt-in motion-blur B-roll | Fast ramps stop strobing | M | derived media only | cli + skills |
| **Q07** | Voice cleanup, measure-first | Hiss/fan gone only when it is actually there | S | `--derived-from` audio | cli + skills |

**Parked product fork (not this wave):** native CapCut captions. See §7.

**Hard rule for Q02–Q04:** if the harvest/oracle step fails, the feature is
**not implemented**. You do not guess the JSON.

---

## Q00 — Skill alignment: agents must use `match`

### Why

Agent videos fail when the picture does not prove the words. That is already the
screen-recording skill’s premise. F01/F03/F07/F09 exist and write only through
existing ops. The skill still says automatic semantic alignment is not
implemented, so agents keep guessing with `find` + `add`.

This is the highest-leverage quality change and it writes no CapCut JSON.

### Repo

Companion skills repo (`capcut-editing-screen-recording`, hub, `capcut-cli`).

### Do

1. Replace “automatic semantic alignment is not implemented” with the actual loop:

   ```bash
   capcutctl match --project NAME --screen FILE --json > shots.json
   # review flag/none rows; edit shots.json if needed
   capcutctl match --project NAME --apply --shots shots.json --dry-run
   capcutctl match --project NAME --apply --shots shots.json
   capcutctl verify-shots --project NAME --shots shots.json
   capcutctl punch --project NAME --on TEXT --segment ID --ease --dry-run
   capcutctl ramp --project NAME --segment ID --speed 20 --dry-run
   capcutctl qa --project NAME --expect 'T=phrase'
   ```

2. Keep the human rules: inspect evidence, one focus, waiting vs action vs result,
   no B-roll is valid, `verify-shots` CONTRADICTED blocks.
3. `match` is a shot list, not proof. `verify-shots` + `qa --expect` remain
   mandatory after `--apply`.
4. Update the hub workflow step 3 so B-roll placement names `match` before
   hand-rolled `add`.
5. Do not claim OCR hits prove a click. `verify-shots` still needs before/action/after.

### Done when

- Skills validator (`scripts/validate.py` against the vendored contract) passes.
- No remaining sentence in the four skills tells an agent to skip `match` for
  ordinary screen-recording B-roll.
- rl2 Phase 2/3 remains “not a gate on ordinary editing.”

---

## Q01 — Ease camera moves by default

### Why

F08 already writes harvested `FreeCurveInOut` on ScaleX/Y (`--ease`) and on
PositionX/Y (`--ease-position`). Both round-tripped in CapCut 9.4.0. Agents
almost never pass the flags, so punch/stress/wrap still look like linear tweens.
The report is right that acceleration, not amplitude, is the tell.

### Viewer-visible change

A 1.08–1.6× push eases into the hold and eases out. Same start/end scale as today.

### Do

1. Default `ease: true` on:
   - `punch` (always a scale+position move)
   - `zoom --stress` and `zoom --auto`
   - `wrap`’s talking-head push-ins
   - `keyframe` when the caller did not pass `--ease` or an explicit `--no-ease`
2. Default `easePosition: true` on `punch` and on `keyframe --focus` (those writes
   already emit PositionX/Y). Leave non-focus scale-only pushes as scale-eased,
   position Line, matching today’s `--ease` behaviour.
3. Add `--no-ease` to opt out. Do not remove `--ease`; it becomes the documented
   default.
4. Keep handles in `src/easing.mjs` (`FREE_CURVE_HANDLES`). Do not invent cubic-in
   vs cubic-out tables from the report. One harvested shape is the house curve.
5. Do not write `KFTypeUniformScale` (silent no-op). Do not write `KFTypeAlpha`
   on video/text as a fade (known render trap). Logo glow already uses a harvested
   alpha block; leave it alone.
6. `qa` already samples `effective_clip()` linearly between keys. Do not claim a
   proxy proves native easing. Native check: open a disposable copy, confirm
   `curveType` is still `FreeCurveInOut` after save.

### Files

- `cli/src/add.mjs` (`opScaleKeyframe` default)
- `cli/src/punch.mjs`, `cli/src/stress.mjs`, `cli/src/signature.mjs`
- `cli/src/cli.mjs` usage + boolean flags
- `cli/test/easing.test.mjs`, `cli/test/punch.test.mjs`, `cli/test/stress.test.mjs`
- `cli/docs/cli-contract.json` (generated from `capcutctl contract`)
- skills: `capcut-cli` keyframe/punch/zoom lines

### Tests

- Existing F08 tests still pass.
- New tests: `punch` / `zoom --stress` without `--ease` write `FreeCurveInOut` on
  ScaleX; `punch` also eases PositionX/Y; `--no-ease` restores Line.
- Contract lists `--no-ease` on `keyframe`, `punch`, `zoom`.

### Done when

`npm test` / `npm run check` pass; usage text matches; disposable CapCut 9.4.x
copy keeps the eased `curveType` after open/save.

### Do not

- Do not add `capcutctl motion` as a second camera writer. Extend `keyframe`.
- Do not ship the report’s “one strong push per 8–15 s” quota. `zoom --stress`
  already spaces ≥8 s. Layout changes do not require a zoom.

---

## QI1 — Round-trip sanitation harness

### Why

The report’s most valuable *process* idea: JSON that parses can still no-op in
CapCut. The CLI already snapshots and doctors structure. It does not classify
what CapCut **does** to a record on open/save. Q02–Q04 need that before they
write unseen fields.

This does not change a video by itself. It stops later features from shipping
theatre.

### Do

1. Add a **dev-only** path, not a user-facing edit command. Suggested:

   ```bash
   capcutctl oracle capture --project NAME --label SLUG
   capcutctl oracle diff --before DIR --after DIR
   ```

   or a script under `cli/tools/oracle/` if you do not want new top-level verbs
   yet. If you add commands, they are non-transactional and write nothing into
   the draft except via the existing snapshot machinery.

2. Capture the **whole project directory** (not only root `draft_info.json`):
   root, `Timelines/**`, `draft_meta_info.json`, `template-2.tmp`.
3. Classify diffs with the report’s taxonomy, stored as JSON:
   - `preserved` — structure survived
   - `normalized` — rewritten, behaviour survived
   - `materialized-cache` — app added analysis files
   - `pruned` — record discarded
   - `reset` — record kept, values restored
   - `authority-miss` — we wrote a mirror
   - `resource-noop` — structure survived, pixels did not change
4. Do **not** automate clicking CapCut in CI. The harness compares two
   directories a human (or a later native-bridge session) captured. Document
   the manual steps: close → snapshot A → write → snapshot B → open → harmless
   UI nudge → save/quit → snapshot C → `oracle diff B C`.
5. Refuse to treat `pruned` / `reset` / `resource-noop` as success for a new
   field.

### Files

- `cli/src/oracle.mjs` (or `cli/tools/oracle/`)
- `cli/test/oracle.test.mjs` on synthetic two-directory fixtures
- short `cli/docs/oracle.md` for the manual CapCut steps

### Done when

A fixture with a deleted keyframe type is classified `pruned`; an equivalent
reformatted UUID-preserving rewrite is `normalized`. No CapCut UI in unit tests.

---

## Q02 — Duck music under speech

### Why

Finish currently places a flat bed at ~0.08. `loudness` does not touch music.
Speech-dense Arabic talking-head + bed + SFX is the mix agents get wrong: either
the bed fights the voice or someone crushes the bed so pauses feel dead.
Native volume automation keeps the bed editable. Derived mixed audio would not.

### Harvest gate (mandatory, first commit if the oracle is new)

`presets/harvest.json` keyframe types include Scale/Position/Rotation/White/Alpha.
**`KFTypeVolume` is absent.** The report’s schema claim is not evidence for this
install.

On a disposable project, in CapCut:

1. Place any music clip. Add two volume keyframes (e.g. 0 dB → −12 dB → 0 dB).
2. Quit. Diff the whole draft (`QI1` if it exists; otherwise `capcutctl snapshot`
   + manual diff).
3. Record: property name, value units (linear 0–1 vs dB), time base (source vs
   target microseconds), `curveType`, whether CapCut also writes a companion
   material.
4. Reopen, save, confirm the keys still render. If CapCut drops them, **stop**.
   Keep constant gain. Do not invent `KFTypeVolume`.

Clone the harvested block into `presets/` (not `harvest.json` — that file stays
gitignored). Version it with `app_version` / schema integer.

### Viewer-visible change

Under speech, music gain ramps down; in pauses ≥ ~450 ms it returns. Speech
clips and picture do not move. SFX lanes are not ducked (they are already
short accents).

### Command

```bash
capcutctl music --project NAME --duck --plan --dry-run
capcutctl music --project NAME --duck
capcutctl music --project NAME --duck --under-db 12 --attack-ms 120 --release-ms 380 --min-gap-ms 450
```

Prefer extending `music` over a new `audio duck` verb. `loudness` stays
speech/SFX clip-volume only and must still refuse `loudnesses.enable` (F20).

### Behaviour

- Speech regions from the energy index (preferred) or surviving transcript
  mapped through `sourceToTimeline()` on the principal track.
- Attack starts ~120 ms before speech onset; release ~380 ms after speech end;
  hold ~100–150 ms after the last phoneme.
- Merge gaps < 450 ms so the bed does not pump.
- Depth: about 12 dB under the current bed gain (if bed volume is 0.08, duck
  toward ~0.02 linear — **use the harvested unit**, not this guess).
- Long deliberate pauses may recover only part-way if the next sentence is
  near (report prior: −8 to −10 dB). Encode as a constant in the plan table.
- `--plan` prints regions, before/after gain, merged gaps. Writes nothing.
- Refuse if no `finish:music` / music-classified segment exists.
- Leave existing in/out `audio_fades` intact (same snapshot-and-compare guard
  `loudness` uses).
- Do not write volume keys on the talking head.

### Tests

- Inject a fake harvested keyframe template; assert keys land only on the music
  segment; speech segment `volume` unchanged; fades unchanged.
- Adjacent sentences 200 ms apart merge to one duck.
- `--dry-run` writes nothing.
- Contract: `--duck` and the timing flags.

### Native check

Disposable copy: duck audible under a sentence, swell in a pause, keys survive
save. `preview` may not honour volume keyframes (already documented). Listen in
CapCut.

### Skills

`capcut-editing/references/finish.md`: replace “do not claim a flat bed is
automatically ducked” with the command, and keep the caveat that proxy playback
is not native automation.

### Do not

- Two-pass ffmpeg `loudnorm` / deesser on a replacement dialogue file (report
  “master” path). That is Q07, and it is opt-in derived audio. Q02 is ducking
  only.
- CapCut Pro loudness normalize (`loudnesses.enable`). Still F20, still out.

---

## Q03 — Cursor halo from telemetry

### Why

These videos are “watch the agent do the thing.” Clicks already have a sound
path (`polish` interactions) but nothing for the eye. JSON keyframes on a small
PNG are exactly the kind of thing CapCut’s UI makes tedious and this CLI makes
cheap.

### Viewer-visible change

A faint ring follows the pointer on screen-recording shots; it scales up on a
real in-capture click and eases back.

### Constraints

- Do **not** regenerate the screen recording.
- Halo PNG is `--generated` (no editable original). Bundle a tiny transparent
  ring in `assets/` (this package may ship overlay artwork; keep it original,
  not a trademarked cursor).
- Map source time → timeline through the chopped B-roll (`sourceToTimeline` /
  existing `mapVtToTimeline` in `polish.mjs`), speed-aware, same as click SFX.
- Skip `in_capture: false` (Stop button). If a take has no in-capture pointer
  samples, report `skippedNoCursor` and write nothing.
- Do not emit 60 keys/s. Simplify (Ramer–Douglas–Peucker or equivalent) so
  reconstruction error ≤ 6 px RMS on a 1080-wide canvas; keep all click times.
- Click pulse: scale 1.00 → 1.20–1.30 → 1.00, ~80 ms in / 180 ms out, using
  Q01 easing. Typing without motion: at most one pulse on focus, never a
  per-key strobe.
- Overlay track below the talking head, above the recording; never the cover
  track. `CLIP_OVERLAP` still refuses overlaps on that named lane.
- One-focus: if `punch` is already on the same beat, skip the pulse (halo may
  still track). Do not add a callout GIF as well.

### Command

```bash
capcutctl cursor --project NAME --segment ID --plan --dry-run
capcutctl cursor --project NAME --segment ID
capcutctl cursor --project NAME --auto --dry-run
```

`--auto` walks B-roll segments that have an rl2 sidecar (`trace.ndjson` already
copied by `add` / `layout screen`). Re-running is idempotent: clear previous
`cursor:halo` segments on that lane, then rewrite.

### Tests

- Synthetic trace with two clicks + a linear move → key count ≪ raw samples,
  click times preserved, Stop-button event skipped.
- No sidecar → skip, no throw.
- `--dry-run` writes nothing.

### Native check

Halo sits on the pointer at rest, peak, and a click. `qa --times` at those
instants; `effective_clip()` must see the eased scale (Q01).

### Do not

- Drive this from OCR boxes. Telemetry is the source; OCR is fallback for
  `punch`, not for the pointer.
- Promise click SFX *or* halo on ordinary screen recordings without sidecars.

---

## Q04 — Screen spotlight (harvested rounded rectangle)

### Why

`layout broll --row` frames a horizontal band. Agents often need “this button,
not the whole window.” A feathered rounded rectangle is the native way to
isolate a region without ffmpeg-cropping (origin contract). Harvest already
counts Rectangle masks.

### Harvest gate

On a disposable copy, in CapCut, apply a rectangle mask; set feather to 0 / 25 /
50 / 100% and corner radius across a few values; quit; record `config.feather`,
`roundCorner`, `width`/`height`/`centerX`/`centerY` scale. Confirm `resource_type`
and whether invert is a boolean. **Do not keyframe the mask** (encoding unknown).

If the UI mask is not a `common_mask` rectangle, stop. Do not invent `heart`/`star`.

### Viewer-visible change

One UI target sits in a soft rounded window; the rest of the recording is
suppressed. Split-screen seam stays the locked line mask on the **face**, not
on this B-roll.

### Command

```bash
capcutctl mask --project NAME --segment ID rectangle \
  --focus X,Y,W,H --feather 0.04 --corner 20 --plan --dry-run
```

`--focus` is **source pixels**, same contract as `keyframe --focus`. The command
converts to the harvested mask config. Optional `--from-ocr TEXT` reuses
`punch`’s box picker (including click-disambiguation) and then writes a mask
instead of a camera move.

### Behaviour

- Padding 4–7% of the target bbox.
- Refuse circle-layout / rotated-mask segments (same gate as camera motion).
- Refuse combining spotlight + punch on the same segment at the same time
  (one-focus). Agent chooses.
- Re-apply replaces the CLI-owned mask extras; do not stack.
- `qa` renders the mask; sample outside the rect and confirm those source
  pixels are not visible.

### Do not

- Animated mask geometry.
- Invert-as-cutout of the talking head (that is not the house look; overlays
  stay overlays).
- Mirror/linear masks except the locked split-screen line already written by
  `layout`.

---

## Q05 — Face reframe as ordinary camera keys

### Why

Full-face talking head is 1× and unmasked. If he drifts, agents either over-zoom
(`zoom --auto` on every scene) or leave dead space. Local Vision face boxes →
existing `opScaleKeyframe` is strictly better than CapCut auto-reframe
(entitlement-unknown, cache-unknown).

### Viewer-visible change

On long full-face holds, the virtual camera eases so the face stays in frame
with 5–10% headroom. No motion on circle insets (already `MOTION_MASK_UNSUPPORTED`).

### Do

1. New helper `tools/vision/face.swift` (or extend `ocr.swift` with a `--face`
   mode). Apple Vision only, on-device, no network. Output JSON boxes in the
   **same coordinate convention as OCR** (document it; OCR currently converts
   Vision’s bottom-left origin).
2. Sample 8–12 fps. Deadband ~12 px. Smooth ~400 ms. Max scale 1.25 routine,
   hard 1.35 then refuse and tell the agent to switch layout. Max scale delta
   0.10 / s. Simplify keys to ≤6 px reconstruction error.
3. Write through `opScaleKeyframe` / Q01 easing. Do not invent a pivot/anchor
   field.
4. Skip a clip that already has a punch/stress move overlapping the interval
   (`DOUBLE_PUNCH` / `MOTION_OVERLAP`).
5. Never reframe screen recordings with the face detector. That is `punch`.

### Command

```bash
capcutctl reframe --project NAME --segment ID --plan --dry-run
capcutctl reframe --project NAME --auto --dry-run
```

`--plan` prints proposed scale/position without writing. `--auto` only
principal-track full-face clips (same selection as `zoom --stress`).

### Tests

- Inject boxes; assert deadband yields zero keys for a 5 px wobble.
- Masked circle clip refused.
- Reconstruction error helper covered with a synthetic path.

### Native check

Face ≥95% inside frame at sampled times (`qa` + Vision face on the composited
frame, or OCR-less box probe). Headroom not <3% of canvas height.

---

## Q06 — Opt-in motion-blur B-roll (derived)

### Why

`pace --auto` and `ramp` at 20–100× drop frames. That is the “phone scroll at
real speed” opposite problem: waiting looks like a strobe. True `curve_speed`
is unverified (F19). Temporal mixing is the fallback the report suggests.

### Why this is dangerous

Pre-blurring **bakes the speed**. The origin contract exists because baked
crops could not be reframed. Treat this as a look the human can throw away by
relinking the original, not as the default B-roll path.

### Do

```bash
capcutctl pace --project NAME --at T --speed 20 --blur --dry-run
```

or a dedicated:

```bash
capcutctl blur-broll --project NAME --segment ID --dry-run
```

Rules:

- B-roll only. Faces refused (same gate as `pace`).
- Only if current or planned speed ≥ 8× (constant; document it).
- ffmpeg: motion-compensate + mix, then 30 fps. Keep the command in
  `src/python.mjs` / a small tool, not a one-off shell in the agent’s head.
- Import with `add --derived-from ORIGINAL` (or `replace-media --derived-from`
  on that segment). The replacement plays at **1×** of the derived file for
  the same target duration; native `speed` material stays 1.0;
  `curve_speed` stays null.
- Record `derived_from_offset` so the original window is recoverable.
- Refuse ephemeral output paths.
- Default **off**. `--blur` is explicit. `pace --auto` does not blur.

### Tests

- Face segment refused.
- Speed < 8× refused.
- Material has `derived_from_path`; doctor does not warn `MEDIA_PREFRAMED`
  (derived full-frame is not a half-canvas crop).

### Do not

- Apply this to the talking head to “save” a clipped word.
- Populate `curve_speed` “while you’re here.”

---

## Q07 — Voice cleanup, measure-first

### Why

Picker F18. Denoising artifacts are worse than mild room tone. The A-roll
energy index already knows the pause floor.

### Do

1. Measure pause-floor dB from energy10 on the source take.
2. If floor ≤ −55 dB (picker prior), print `skipped: already-quiet` and stop.
3. Otherwise ffmpeg `arnndn` (or documented equivalent) → new wav/m4a.
4. `replace-media --derived-from ORIGINAL` on the **audio of the face clips**,
   or replace the A-roll file the segments already share, without changing
   1× timing or source windows.
5. Compare `loudness --measure` before/after. Do not also run a second
   creative grade on the voice.

### Command

```bash
capcutctl denoise --project NAME --plan
capcutctl denoise --project NAME --dry-run
```

`--plan` is read-only. Refuse if it would speed the face or retiming windows.

### Tests

- Synthetic quiet floor → skip.
- Derived path recorded; source windows unchanged; speed 1.0.

---

## 4. Oracle experiments (only what this wave needs)

Run on a **fresh CapCut-created empty project**, CapCut closed while diffing,
whole directory, disposable. Do not mine production drafts.

| Experiment | Needed by | Stop if |
|---|---|---|
| Volume keyframes on a music clip | Q02 | Keys pruned or inaudible after save |
| Rectangle mask feather + `roundCorner` scale | Q04 | Field names do not match harvested `common_mask` |
| Mix-mode on a PNG overlay (only if halo needs Screen) | Q03 optional | Default Normal is fine; Screen is already harvested for logos |
| Face.swift box convention vs OCR | Q05 | Coordinates disagree with `punch` boxes |
| Canonical storage probe | only if a v9.x upgrade breaks `documentGroups` | Nested timeline not listed in `inspect` |

Do **not** spend this wave on: speed-curve oracle, freeze, reverse, chroma,
stabilization, motion tracking, smart matting, LUT, color wheels, adjustment-layer
type hunt, text animations, CapCut auto-captions, beat markers.

If you want a leftover experiment list, the research report’s table is that list.
It is not this wave.

---

## 5. Invariants (copy onto every implementation prompt)

- Overlays only. Never put content on the main/cover video track (`flag=0` video).
- Faces stay 1×. `pace` / `ramp` / Q06 / Q07 must refuse the principal track.
- Speech is never recut to a beat or to a duck.
- Import full-frame originals from durable paths. Prefamed half-canvas and
  `/tmp`/`scratchpad` stay refused.
- Resource-backed effects/SFX: skip + report if the cache file is missing
  (`unavailableSfx` pattern). Do not write dead `resource_id`s.
- Unknown fields: preserve on read/modify/write. Do not normalize drafts down
  to “fields capcutctl understands.”
- `UNIFORM_SCALE` is the uniform-scale property name if you ever need it;
  `KFTypeUniformScale` no-ops. Prefer the existing ScaleX + `uniform_scale.on`.
- Doctor cannot see pixels. Picture features need `qa` (and `verify-shots`
  when B-roll is involved).
- Export remains user-gated. Finish ≠ export.

---

## 6. Lint additions (only with the feature they measure)

Do not build the report’s entire lint catalogue. Add checks next to the writer:

| Feature | Check | Fail |
|---|---|---|
| Q01 | `curveType` on written camera keys | Scale keys still `Line` when ease default on |
| Q02 | duck regions merged; music-only keys | volume keys on speech; pumping <450 ms |
| Q03 | RMS halo vs telemetry | RMS > 6 px or pulse >1 frame from click |
| Q04 | OCR/target still visible in spotlight | target missing in first 500 ms (`qa --expect`) |
| Q05 | face bbox after transform | <95% visible or headroom <3% |
| Q06 | derived_from set; face untouched | missing original; speed on face |
| Q00/F07 | `verify-shots` CONTRADICTED | already fails the command |

Skip the report’s “machine-rhythm CV,” “viral 1.6 s cut,” and platform safe-area
folklore. House cut rhythm is already measured in `style.md`. Motivated polish
already caps transition monotony.

---

## 7. Explicitly out of scope

| Idea | Why not |
|---|---|
| Native CapCut captions / RTL text tracks | House style is essentially no text; finish keeps caption space **outside** CapCut. Revisit only if the user asks for on-timeline captions as a product. Then: Whisper → `materials.texts` with UTF-16 ranges, `sub_type:1`, no CapCut recognition job, golden frames for mixed bidi. Until then, do not build `capcutctl captions`. |
| `curve_speed` / freeze / reverse | No populated v9 sample in 101 drafts; F09 covers the shot. |
| Chroma key, extra blend modes, grain, LUTs, color wheels | Style is preserve source colour; grain fights crispness (F04). |
| Scoped decorative VFX / flash layers | Library effects are almost all the blur plate. Motivated `polish` already owns seams. |
| CapCut auto-reframe, tracking, smart cutout, vocal isolation, native NR | Entitlement and cache unknown; local Vision + ffmpeg cover the jobs. |
| Arrow stickers (F17) / number-pop (F22) | One-focus rule; PREMIUM-V1 already rejected graphics-on-top. |
| Resolve Studio pass (F11) | Leaves CapCut; $295; scripts cannot build colour nodes. |
| Raising rl2 bitrate (F12) | Separate recorder repo; not `capcutctl`. |
| Storage “authority manifest” rewrite | `documentGroups` already discovers `Timelines/project.json`. Add a version tripwire only after a real upgrade break. |
| Invented `capcutctl motion` / `effect-layer add` / `audio master` verbs | Extend `keyframe`, `grade --layer`, `music`, `loudness`. |

### Captions, if the user later unparks them

Not this wave. Constraints so nobody “just adds text” badly:

- Opt-in flag, default off.
- Local Whisper only; preserve spoken Arabic, do not MSA-translate.
- UTF-16 style ranges (JS string indexes).
- Stricter than Netflix: ≤34 Arabic chars/line, ≤2 lines, ≤18 CPS, sparse bold.
- Mixed-direction golden frames (Arabic + Latin product names + digits).
- Raster overlay is last-resort derived media, still on the CapCut timeline.
- Still not a substitute for Q00 (wrong B-roll with pretty captions is still wrong).

---

## 8. Suggested execution order for subsequent agents

```
Q00  skills only          → matcher is the B-roll path
Q01  cli + skills         → ease by default (no new fields)
QI1  cli                  → oracle diff harness
Q02  harvest then cli     → duck (abort if keys die)
Q03  cli + assets         → cursor halo
Q04  harvest then cli     → spotlight mask
Q05  cli + swift helper   → face reframe
Q06  cli                  → opt-in blur (explicit flag)
Q07  cli                  → denoise (measure-first)
```

Parallelism: Q00 and Q01 do not share files across repos. QI1 can overlap Q01.
Q02 must not start until its harvest gate passes. Q03 can proceed without Q02.
Q04 must not share a segment with Q03 pulse + Q01 punch on the same beat
(one-focus — enforce in Q04, document in skills).

Each agent prompt should paste **only** the feature section + §5 invariants +
this file’s “How to use this spec.” Do not paste the research report.

---

## 9. Definition of done for the wave

Agent-built videos, compared to the current unaided pipeline, should:

1. Place B-roll through `match` → `verify-shots`, not by OCR-keyword guess.
2. Push-in with eased scale (and eased position on punch/focus).
3. Keep speech louder than the bed in sentences, with audible air in pauses —
   **if** Q02’s oracle passed.
4. Show pointer attention on takes that actually have in-capture telemetry.
5. Still open in CapCut with every crop/zoom/duck/halo editable.
6. Still pass `doctor` with no new invented materials.

If a feature cannot satisfy (5) and (6), it does not ship. Quality that the
human cannot undo is not quality in this project.
