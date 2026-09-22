# Native motion implementation checkpoint

**Experimental, not a completed reproduction of hEV-gkypeV8. No showcase MP4 has been produced.**

## Implemented surface

`motion gradient|shimmer|orbit-glow|spotlight` creates native editable compound layers through the existing `applySpec` transaction path. Each invocation takes a stable `--name`, one `--text` or `--logo`, `--at`, `--duration`, `--scale`, `--x`, `--y`, `--color` and `--accent`. Colors are six hex digits without `#`. Gradient accepts native text only. The other logo paths are experimental and have not been visually verified.

Example on a disposable draft, with CapCut closed:

```sh
node bin/capcutctl.mjs motion gradient --project PROJECT --name gradient-demo --text NATIVE --at 0 --duration 4 --color FF641C --accent FFE66B --dry-run
node bin/capcutctl.mjs motion shimmer --project PROJECT --name shimmer-demo --text SHIMMER --at 4 --duration 4
```

The equivalent spec operation is `{"op":"motion","recipe":"shimmer","name":"shimmer-demo","text":"SHIMMER","at":4,"duration":4}`.

Same-name, identical, untouched inputs return unchanged. Changed inputs or manual edits to owned tracks/materials refuse with `MOTION_NAME_CONFLICT`, rather than silently overwriting edits. This fingerprint is conservative: a native save may normalize JSON and cause refusal. Use a fresh name after a native round-trip until update semantics are verified. No automatic deletion/update of existing recipes is implemented.

Resources are local CapCut downloads. Missing masks/Blur refuse with `MOTION_RESOURCE_MISSING`. `CAPCUTCTL_PRESET_DIR/motion.json` can provide locally harvested structures; the repository does not bundle CapCut's proprietary effect payloads.

## Native evidence

Captured from CapCut 9.3.0:
- Editable default text, compound video material and embedded `materials.drafts[].draft`.
- Split, Filmstrip and Circle masks.
- `KFTypeCommonMaskPositionX`, `PositionY`, `Rotation`, `Feather`, `SizeWidth`, `SizeHeight` channels.
- Animated-mask channels bind to the mask's `constant_material_id`, **not** its record `id`.
- Flip 6 animation metadata, resource `6843310299991249421`. The similarly numbered `3D card 6` is a different resource and must not be substituted.
- Blur downloaded on the machine through CapCut. Native animation resources are not redistributed.

The disposable `Native-Motion-Lab` was built via public CLI commands, opened in CapCut, and contains a 17-second timeline. The on-disk draft after opening retains seven compounds and the emitted mask channels. This does not establish that every effect looks correct, and does not replace exported-frame inspection.

## Verified checks

- 19 focused tests pass: native references and nested documents, mask binding, invalid inputs, idempotency/manual-edit refusal, missing-resource refusal, preservation of foreign tracks, root/active-timeline IDs, mirror equality, and a public-command dry-run with no history/document writes.
- Full regression suite: 472 tests pass, no failures or skips.
- `npm run check` passes.
- Native export Swift bridge typechecks.
- An actual native export attempt now fails immediately with `EXPORT_SESSION_LOCKED` when the Mac is locked. It does not attempt to unlock the machine.

## Not yet accepted

- Layered 3D recipe: Flip 6 captured, but native freeze plus shadow grouping and Play Pendulum capture/implementation remain undone.
- Shimmer: text sweep structure exists; brightening the logo duplicate and reference-matched easing remain undone.
- Gradient: two editable color layers exist; exact transition appearance remains unverified.
- Orbit: stationary core plus rotating masked blurred underlay exists; appearance and reference-matched brightness remain unverified.
- Spotlight: traveling/expanding native Circle mask exists; the current slight Blur is **not** the tutorial's native text glow. Replace it with a captured glow construction before acceptance.
- Current keys are `Line`, not the tutorial's Quad Ease. Do not claim easing parity.
- No final artwork/composition, logo shimmer proof, all-five showcase, successful export, or visual acceptance.
- Export Home-card routing and MP4 selection changes have not completed an unlocked end-to-end export.

## Resume gates and known traps

1. The local session must be unlocked by the user. Permission approval is not an unlock. Do not repeatedly attempt GUI actions while Quartz reports a locked session.
2. CapCut's Home title label is a rename target. Resolve the exact `HomePageDraftTitle:<name>`, then click the containing `HomePageDraft` card to open it. Do not double-click the title and assume the editor opened.
3. macOS may withhold CGWindow titles without Screen Recording permission. Never misreport that as a verified wrong-project finding. The experimental bridge navigates through the exact observed Home card instead; verify that full path before release.
4. CapCut may start with a promotional modal. Dismiss only the observed close control; don't click through to subscription/payment.
5. Qt controls can acknowledge AXPress without acting. Use observed geometry with native pointer movement and read back the result.
6. `new --blank` without an existing template was observed to omit `draft_meta_info.json`, leaving the draft absent from Home despite registry registration. For the current proof project, use `new --from EXISTING --blank`. Fix and native-test standalone blank creation separately.
7. `close` can report AppleScript `User cancelled` while CapCut subsequently exits. Re-read actual process state before retrying or interpreting the error as a refusal.
8. Finish the missing native captures, then build a new proof project via the CLI, close/reopen, export through `capcutctl export`, inspect multiple phases of every effect, and only then mark the feature complete.
