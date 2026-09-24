# Z-wave: production-grade, highly animated edits by default

**Status:** in progress · **Started:** 2026-09-24 · **Repos:** `cli` + companion `capcut-skills`

This is the agreed plan from an engineering review and a creative-director critique of
both repositories. The two reviews converged on one diagnosis:

> The CLI already has most of the ingredients. Quality depended on an agent chaining
> 15–25 opt-in verbs in the right order from ~4,600 lines of skills that were 37
> commits stale, while the house style it read said "no animation, no text".

The fix moves orchestration and taste out of prose and into the CLI: **one profile,
one edit plan, one build, one blocking gate**, plus a rendered motion-graphics layer
for the typography CapCut's native tools do badly and our QA cannot see.

## What premium means here

A short is judged in its first second. The profile encodes a motion grammar rather
than a motion quota:

- **Hook:** something moves by 0.5s, proof is on screen by 1.5s, a sound hits on frame 0.
- **Rhythm is contrast, not quantity.** A visual change at least every 3s, a graphic
  every 5–8s, and a 2–3s rest with no overlay in every 15s after the hook.
- **One focus at a time:** at most two things animate at once (a graphic + a camera move).
- **Graphics lead their word by 2–4 frames, and every graphic has a sound.**
- **Never:** perpetual spins/loops, linear entrances, letter-by-letter Arabic, a Latin
  fallback font on Arabic, rotation, text that repeats the whole spoken sentence, the
  same template twice within 10s, two entrances within 6 frames, overlays in the
  platform UI zones, a punch and a callout on the same target.

## Decisions

| Area | Decision |
|---|---|
| A-roll sign-off | **Stays.** Everything after it is one `build`. |
| Anchoring | Graphics, logos and emphasis are anchored to **source words**, so a recut rebuilds exactly. Orphaned anchors refuse by name. |
| Style | `presets/profile.json` is the one source of taste: tokens, camera, seams, sound, density, grammar. The library measurements stay as provenance, not as the target. |
| Logo default | Reverted to the measured 0.13s pop **with its pop SFX**. `--motion orbit-glow` is opt-in; native `motion` recipes are frozen as experimental. |
| Motion graphics | `mograph`: deterministic HTML/JS templates rendered by headless Chromium into a tight-bbox alpha clip, imported `--generated` above the footage with a sidecar (template, params, anchor) so it re-renders. Footage, cuts, layouts, camera and seams stay CapCut-native. |
| Remotion | Retired as a pipeline (flat MP4 breaks rule 3). Its mapping and bbox rules move into the screen-recording skill. |
| Captions | No full subtitles by default; 1–3 word keyword supers are part of the grammar. |
| Registry | One command-docs table derives the transactional list, the contract summaries and the generated skill reference. HELP stays the option source; a test cross-checks both directions. No dispatcher rewrite. |
| `zoom --auto` | Deprecated (clockwork push on every scene); `wrap` uses the stress planner. |

## Must-do list and acceptance criteria

### CLI core
- **A. Logo default = pop + SFX.** `logo --brand X` writes the 0.13s pop and its cue; `finish` counts it.
- **B. `profile.json`.** No 1.15 / 1.08 / 0.08 / 7257FF style literals remain in `src/`; `harvest --profile` emits one.
- **C. `edit.json` + `build`.** After sign-off, one `build` applies camera, graphics and sound in one transaction; rebuilding an unchanged plan writes nothing new.
- **D. Source-word anchors.** After `cut --into` and a rebuild, every anchored overlay lands within one frame of its word, or `build` refuses naming the orphaned anchors.
- **E. Every graphic writes its paired SFX.** `gate` reports unpaired graphics.
- **F. Command-docs table.** A test cross-checks it against HELP and dispatch in both directions.

### Motion / mograph
- **G. Import acceptance (Mac).** ProRes 4444 (`yuva444p10le`) is the default; WebM is debug-only; `png-still` is preferred for pop/slide motion (native eased keys keep it editable). Outputs are `importVerified:false` until the Mac checklist in `docs/mograph.md` passes; `gate` WARNs on that.
- **H. Deterministic renderer.** Identical frames across two runs; frame N rendered alone equals frame N in sequence.
- **I. Shared tokens.** Templates read colours, type and easing from the profile; a lint rejects literal hex values and font names in templates.
- **J. Templates v1:** `hook-title`, `keyword-super`, `number-pop`, `callout-box`, `cta-card`, `brand-chip`. Each has a golden-frame test, an Arabic joined-form test and a safe-zone test.
- **K. Sidecar + `mograph rerender`.** Editing text and re-rendering keeps timing and position; output is a tight bbox, never a full-frame overlay.
- **L. Q04 rectangle spotlight** stays behind its harvest gate (open).

### Quality gate
- **M. `gate`** (blocking): hook ≤0.5s, proof ≤1.5s, longest static stretch, opening density, rest windows, simultaneity ≤2, template repeat ≥10s, entrance spacing, safe zones, unpaired graphics, brand-chip + logo on one mention, first-picture proof, same-screen transitions, seam variety. WARN: `importVerified:false`, crispness, "unseen: N native text/compound layers".
- **N. QA sees mograph.** Mograph clips are real video files, so `qa`/`preview` composite them; native text/compound layers are counted as unseen.
- **O. Track outcome.** The skill's hand-off logs manual-fix minutes per video (target < 10).

### Skills
- **P.** The CLI reference is generated from `capcutctl contract` at HEAD; CI fails on drift.
- **Q.** Four skills become two: `capcut-editing` (judgement, grammar, authoring `edit.json`) and `capcut-cli` (generated reference + invariants), ≤ 1,200 lines on the happy path.
- **R.** `suheil-capcut-edit-style` (account skill) is retired after its mapping and bbox rules are ported. No "hard cuts only" or "no captions" rule remains.
- **S.** `style.md` becomes provenance + a pointer to the profile.

### Cleanup
- **T.** `suheil-vertical.json` `hardCutsByDefault` folds into the profile.
- **U.** The "Captions happen outside CapCut" finish law is removed; the profile decides.
- **V.** `zoom --auto` deprecated.
- **W.** The ~424 lines of private-recorder docs leave the agent path.
- **X.** Native `motion` recipes frozen as experimental.

### Do not build
Native number-pop or arrow stickers (mograph replaces them) · animated mask geometry ·
the layered 3D recipe · full-frame mograph overlays · mograph camera moves or
transitions · Remotion flat-MP4 output · word-by-word karaoke subtitles by default ·
auto-applying `animate` intros to every clip · removing the A-roll sign-off.
