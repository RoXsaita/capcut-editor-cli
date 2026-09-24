# mograph — rendered motion graphics

CapCut is where the edit lives. Footage, cuts, layouts, camera moves, ramps, seams, logo pops
and the endcard stay **native** so the editor can drag every one of them. What CapCut does
badly — kinetic Arabic typography, counters, drawn callouts, the CTA card — and what `qa`
cannot see when it is native, is authored as a small HTML/JS template and rendered to a
clip. The clip is placed above the picture as a `--generated` medium, with a sidecar that can
re-render it.

```bash
capcutctl mograph list
capcutctl mograph preview --template keyword-super --params '{"text":"أسرع بعشر مرات"}' --out sheet.png
capcutctl mograph add --project NAME --template keyword-super --params '{"text":"أسرع"}' --say "أسرع" --dry-run
capcutctl mograph add --project NAME --template keyword-super --params '{"text":"أسرع"}' --say "أسرع"
capcutctl mograph rerender --project NAME --id keyword-super-4900 --params '{"text":"أسرع بكثير"}'
```

In a full edit, graphics are declared in `edit.json` and `capcutctl build` renders, anchors
and places them all (see the `capcut-editing` skill).

## What it guarantees

| Property | How |
|---|---|
| **Deterministic** | A template's picture at `t` is a pure function of `(params, t)`. The runtime freezes `Date.now`, `performance.now`, `requestAnimationFrame`, CSS animations/transitions and `will-change` (layer caching re-used stale rasters), and seeds `Math.random`. Tested: two runs are byte-identical, and frame N rendered alone equals frame N in sequence. |
| **Tight** | The renderer crops to the union of every element's box across the clip, plus a pad for blur/glow. Never a full-frame overlay. |
| **Exactly placed** | Templates draw on a real 1080×1920 canvas, so the crop box is the canvas position. `mograph.place` turns it into CapCut clip scale and half-canvas transform (y up). |
| **On-brand** | Colours, type, easing and frame timings come from `presets/profile.json` tokens. Templates contain no literal colours or font names (a test enforces it). |
| **Arabic-correct** | IBM Plex Sans Arabic (600/700, OFL, bundled in `mograph/fonts/`) loads before layout; a template whose text fell back to another face refuses (`MOGRAPH_FONT_FALLBACK`). Text animates by **word**, never by letter, so joined forms stay joined. |
| **Safe** | Default placements stay inside the profile's text bands; a box in the platform UI zones refuses (`MOGRAPH_SAFE_ZONE`) unless `--allow-unsafe`. |
| **Paired sound** | Each template names its cue (`pop`, `impact`, `enter`, `select`…, mapped through `presets/sfx.json` accents). `mograph.place` writes it on `mograph-sfx`; a cue missing on this machine is reported, not faked. |
| **Owned & idempotent** | Output is tagged `mograph:<id>` / `mograph:sfx:<id>`; placing the same id replaces it with the same ids. `build` prunes graphics its plan no longer names. |

## Formats

| Format | Use | CapCut |
|---|---|---|
| `prores` (default for `motion: 'rich'`) | ProRes 4444, straight alpha, bt709 | Imported as a video clip. `importVerified: false` until the checklist below passes. |
| `png-still` (default for `motion: 'pop'`/`'slide'`) | The template's hold frame as a transparent PNG | A native photo clip with an eased pop (harvested FreeCurveInOut handles), fully editable. |
| `webm` | VP9 alpha, for looking at a render in a browser | **Never placed** — `mograph.place` refuses it. |

## Mac acceptance checklist (G) — run once per CapCut build

The alpha import cannot be verified outside CapCut. Until this passes on the target build,
every ProRes graphic is `importVerified: false` and `gate` reports `mograph-import` as a WARN
that the hand-off must name.

1. On a disposable copy: `capcutctl mograph add --project TEST --template keyword-super --params '{"text":"Test"}' --at 1`, plus a `number-pop` and a `callout-box` over footage.
2. Open in CapCut. The graphic plays, is **transparent** over the footage, sits where
   `mograph preview` showed it, and can be moved/scaled in the UI.
3. **Edges:** zoom to 400% on a text edge over a white and a black frame. No dark or light
   fringe (a fringe means premultiplied/straight alpha is being misread).
4. **Colour:** render `brand-chip` or `cta-card` (indigo fill) and sample it in a CapCut export
   frame: within ΔE < 2 of `#4040FE`. A shift means a colour-matrix mismatch.
5. **Export:** a native export (explicit request only) keeps the graphic and its alpha.
6. Record the CapCut version and result in `docs/oracle.md`, then set
   `IMPORT_VERIFIED = true` in `src/mograph.mjs` (per build if they differ).

If step 3 or 4 fails, switch the affected templates to `png-still` where their motion allows,
and file the finding before changing the encoder.

## Writing a template

A template is `mograph/templates/<id>.html`: it loads `../runtime.js` and calls `MG.define`.
Read `mograph/runtime.js` for the full contract; the essentials:

```js
MG.define({
  name: 'my-template', sfx: 'pop', motion: 'rich', pad: 24,
  build(root, params, tokens, mg) { /* create DOM once, in canvas pixels */ return state; },
  duration(params, tokens, mg) { return seconds; },
  still(params, tokens, mg) { return holdSeconds; },     // png-still frame / preview
  seek(t, state, mg) { /* set every animated property for time t — pure */ },
});
```

Rules (from the profile's motion grammar):

- Colours via `mg.color('indigo')`, sizes via `tokens.type`, easing via `mg.ease.enter/exit/pop`,
  timings in frames via `tokens.frames` and `mg.F(n)`. No literals.
- Entrances ease (`enter`), exits are faster (`exit`); pops overshoot at most 6%.
  Linear only for counters and progress.
- Arabic by word (`mg.words`), direction-aware entrances. Latin digits (`mg.digits`).
- Nothing spins or loops forever, no rotation, one font family, no text that repeats the
  whole spoken sentence.
- Default placement inside `mg.input.zones.textBands[params.layout]`.
- Add the template to `test/mograph-templates.test.mjs` (render, determinism, safe zone,
  Arabic, literal lint) and look at its `mograph preview` sheet before shipping it.
