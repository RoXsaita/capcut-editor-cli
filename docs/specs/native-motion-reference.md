# Native motion recipes: source analysis and acceptance contract

Status: **source analysis complete; implementation and native verification pending**.
No commands or effects described below have been added by this document.

## Source

- User-supplied URL: https://youtu.be/hEV-gkypeV8?is=V8KQhtbq5Yon23XU
- Video: **You CAN Animate Like After Effect in CapCut**, Matt Loui.
- Source duration: 602 seconds, from yt-dlp metadata.
- Evidence: downloaded video, English original automatic captions, inspected reference frames.
- Five tutorial effects. The sponsorship (3:28–4:54) and course promotion (9:24 onward) are not effects.
- The gradient recipe is a static treatment, not an animation by itself. Do not relabel it as a moving effect without identifying the added motion.

## 1. Layered 3D icons (0:24–2:12)

Observed construction:

1. Put the logo on the timeline and set its duration.
2. Apply the Combo animation **Flip 6**. The tutorial demonstrates left, frontal and right perspectives.
3. Duplicate the animated layer. Compound the lower layer, apply **Blur**, pull the top of the adjustment curve down to make a dark shadow, and offset it downwards.
4. Compound logo and shadow so they move together.
5. Freeze the desired perspective and remove unwanted sections. Resize and position the frozen views into a multi-icon composition.
6. Apply the entrance animation **Play Pendulum** to the resulting icon layers.

Implementation decision required: a native compound/freeze reference must be captured from CapCut before emitting this structure. Do not approximate perspective with a 2D scale/rotation and call it the same effect. If a native freeze introduces a raster asset, retain its editable source compound and report that limitation explicitly. Prefer a native editable perspective transform only if it can reproduce the look and is verified in the installed version.

Proof: three distinct icons, inward-facing side perspectives, coherent shadows, visible pendulum entrances. Changing source artwork and timing must not require an external video render.

## 2. Orbiting icon glow (2:12–3:28)

Observed construction:

1. Duplicate the logo. The example uses top scale **71%**, bottom **73%**. These are example values, not a universal 2% multiplier.
2. Compound the lower layer and apply Blur.
3. Lift the lower end of the adjustment curve to brighten the underlay.
4. Add a **Split** mask to that underlay, with **50% feather** in the tutorial UI.
5. Keyframe mask settings at the beginning and a few seconds later; rotate the mask through multiple turns.
6. Optionally shape rotation interpolation in the variable-speed/keyframe curve editor.

This is **not** the existing `logo` glow pop. The visible distinguishing feature is a luminous edge traveling around a stationary sharp logo, not a pulsing whole-logo halo.

Proof: sharp original remains still while a feathered highlight circles it. Inspect multiple phases, including the opposite edge. Mask rotation and underlay properties remain native.

## 3. Shimmer sweep (4:54–7:05)

Observed construction:

1. Duplicate the text/logo. Compound the upper copy.
2. Brighten the upper copy with curves.
3. Add a narrow **Filmstrip** mask, feather it and rotate it diagonally.
4. Move the mask beyond the left side. Keyframe mask settings.
5. Add a later keyframe with the mask beyond the right side.
6. Tighten keyframe spacing to increase sweep speed; the tutorial chooses **Quad Ease** on Position X.
7. Repeat on a logo, not only text.

Do not move the artwork itself. Do not add an opaque diagonal white rectangle over the background. The bright stripe is clipped to the duplicate artwork's alpha.

Proof: both an editable text example and a logo example; highlight crosses each, leaving the original clean before/after. Mask position, angle, feather and timing remain editable. Confirm the chosen easing survives a native round-trip.

## 4. Gradient text (7:05–7:39; explanation overlaps into the next chapter)

Observed construction:

1. Create native text and set a bold color (orange in the reference).
2. Duplicate the text and choose a second color (yellow).
3. Compound the upper copy, add a Split mask, set UI feather to **50**, and lower the split slightly.

Proof: readable two-color gradient, clean letter edges and transparent outside the glyphs. Text and colors must remain editable. Rendering a gradient text PNG externally is not equivalent. This recipe may have an additional entrance in the showcase, but the gradient itself is static.

## 5. Spotlight reveal (7:39–9:24)

Observed construction:

1. Give the native text a glow; the tutorial selects the second glow option and changes its intensity.
2. Compound that layer; add a **Circle** mask.
3. Shrink it, set UI feather to **25**, and start it off to the side.
4. Keyframe mask positions through different portions of the word.
5. Near the end, center the mask; keyframe size, then enlarge it to reveal the entire text.
6. Tighten timing and use **Quad Ease** on Position X/Y and Size X/Y.

Proof: text starts hidden, local portions appear under a traveling spotlight, then the full word is revealed and held. Check both the small-mask motion and the final expansion. Do not substitute a simple opacity fade or a generic wipe.

## Implementation gates

- Capture installed-version native examples for compounds, animated masks, mask-keyframe channels, native text, Flip 6, Play Pendulum and effect references. Existing layout masks or scale-keyframe templates do not prove animated-mask serialization.
- Document resource discovery and missing-resource errors. Never promise effects are available on another Mac just because a resource ID was harvested here.
- Extend the existing CLI and transaction machinery, not a standalone draft writer. Preserve root/active timeline independence, mirrors, deterministic IDs, snapshots, running-app guard, doctor and rollback.
- Test first: recipe selection/validation, invalid timing, selector ambiguity, resource availability, all five document structures, idempotency, preservation of foreign content, dry-run no writes, and mirrored IDs.
- Keep controls small: input clip/text, recipe, duration/timing and only useful recipe-specific parameters. Final command spelling must be reflected in HELP and the generated CLI contract, then vendored into capcut-skills.
- The showcase must be assembled through public CLI commands or `apply --spec` using the implemented operations. No hand-authored draft JSON; no substitute Remotion/FFmpeg animation source.
- `doctor` and unit tests establish structural correctness only. Open, play, save, close, inspect the native round-trip, reopen, and export with `capcutctl export`.
- Inspect multiple frames per effect in the actual export, not merely a proxy compositor. The export must include all five recipes and the text-plus-logo shimmer variants. Deliver that real MP4 and identify the editable project.

## Current machine gate

At the initial probe, the local app reported CapCut 9.3.0 and opened to its **Terms of Service and Privacy Policy** consent prompt. The user subsequently explicitly authorized acceptance; the prompt was accepted and the Home/editor screens were verified. A disposable native reference project `0922` was created, and its native text structure was captured outside the repository.

Further native work is blocked by two independently observed machine prerequisites:

- Quartz reports `CGSSessionScreenIsLocked = 1`; the frontmost process is `loginwindow`. Captures and some posted inputs worked, but the tool cannot verify foreground focus or show the needed context-menu workflow. Do not attempt to bypass the session lock.
- An actual `capcutctl export` probe on that reference project exited 2 with `EXPORT_ACCESSIBILITY_REQUIRED: grant accessibility to the invoking terminal/app`. No probe video was produced.

The initially probed default and sandbox draft roots had no usable draft projects, and bundled SFX/resource paths were unavailable. Do not use old repository claims about CapCut 9.4.0 as local round-trip evidence. Unlock and permissions must be resolved before claiming native playback/export is verified.

Baseline at CLI `ca8cb97`: `npm test` passed **453 tests**, zero failures/skips. This is a pre-change baseline, **not** evidence that these five features exist or pass.
