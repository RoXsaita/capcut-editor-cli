# Scenes: how to use, extend and add one

A scene is a full-frame motion-design clip: an opener, a hook slam, a breather between sections, a reveal
or a name card. The library stays good only if every addition clears the same bar as what is
already here. This page is that bar. The runtime contract is in [`runtime.js`](runtime.js), the
commands are in [`docs/mograph.md#scenes`](../../docs/mograph.md#scenes), and the sound
vocabulary is in [`sound.mjs`](sound.mjs).

## 1. The catalog comes first

Most videos need at most three scenes, and every one of them should come from here with only
its params changed.

| Job in the video | Scene | Chains well with |
|---|---|---|
| Opener, section break | `ignition` | → `word-slam` with `bg` equal to its `to` |
| The one claim or hook | `word-slam` | → a shot (`to: "footage"`), `shape-grid` (`to: "paper"`) |
| Breather, textless transition | `shape-grid` | → `particle-word` with `from: "dots"` |
| Reveal a name, tool or number | `particle-word` | → `style-stinger`, a hard cut |
| Energy, a montage beat | `style-stinger` | a hard cut on either side |
| Sign-off | `dot-signature` | the end of the video |

Only in this order:

1. **An existing scene does the job**: use it and write params only.
2. **A param would do it**: add the param to that scene. That makes a variant, not a new scene.
   Document it in the header's `params:` line and add it to the test case.
3. **A new job, or a clearly different motion idea for an existing job**: fork the closest
   scene (`cp word-slam.js my-idea.js`, then change `id`) and rewrite only the choreography. The
   maths, colours, type, blur, grain, camera shake and sound all come from the kit, so a scene is
   choreography and nothing else.
4. **Never add** the same idea in a new colour, a scene with this video's copy baked in, or a
   scene without a job in the table above. Colour and copy are params. A job gets a row in
   the table.

## 2. Anatomy

```js
/*
 * my-idea — one sentence: what the viewer sees, in order.
 * params: { text: 1–3 words, to?: palette role (default paper) }
 * beats: 4 (2.0 s)
 * handoff: ink → params.to
 * use: when in a video this is the right scene, and how often.
 *
 * Timing: what happens on each beat, with the eases. Someone should be able to
 * redraw it from this paragraph.
 */
SCENE.define({
  id: 'my-idea',
  beats: () => 4,                                  // whole half beats only
  handoff: p => ({ in: 'ink', out: p.to || 'paper' }),
  impacts: () => [[0, 0.8]],                       // camera shake + aberration on hits
  cues: () => [{ at: 0, kind: 'impact' }],         // every hit has a sound
  setup(p, K) { /* measure and lay out once: K.words, K.textPoints */ return {}; },
  draw(ctx, t, p, s, K) {
    ctx.fillStyle = K.color('ink'); ctx.fillRect(0, 0, K.W, K.H);
    ctx.font = K.font(700, 200);
    K.text(ctx, p.text, K.CX, 900, { align: 'center' });   // readable text goes through K.text
  },
});
```

## 3. The motion grammar

These rules are what separate a motion designer's work from generated slop. Hold each one on
every scene:

- **Motivated transitions.** The last thing on screen becomes the first thing of the next
  scene: a dot becomes a line, a full stop becomes the dive, a grid becomes dots and the dots
  become particles. Declare it in `handoff`. A crossfade is never a transition.
- **Anticipation, action, follow-through.** A move winds up before it goes and overshoots
  before it settles (`K.spring`, `E.outBack`). Contact squashes (`K.wobble`), and speed
  stretches along the direction of travel.
- **Spacing over speed.** Use expo and spring eases. Linear is for counters and scrolling
  only. Exits are faster than entrances.
- **One idea per beat.** Hits land on beats and a transition finishes exactly on the last
  frame. Nothing waits and nothing idles: no loops, no ambient wiggle.
- **Stagger in reading order**: by word, never by letter for Arabic, with `K.dir` for
  punctuation.
- **Depth without gimmicks.** Use a slow camera push, parallax and the runtime's blur and
  grain. No drop shadows, bevels, lens flares or glow on everything.
- **Restraint.** Use `ink` and `paper` plus two or three roles per scene. Keep type big and
  short: 1–3 words, and captions of five words at most.
- **Sound is picture.** Every hit has a cue and every cue has a hit. A scene with no `cues` is
  unfinished.

## 4. Promotion checklist

A scene joins the library when all of these are true:

- [ ] The header has a summary plus `params:`, `beats:`, `handoff:` and `use:`, and a timing paragraph.
- [ ] Colours are roles only (`K.color`, `K.rgba`) and fonts come only from `K.font`. The lint test enforces this.
- [ ] There's no `Math.random`, clock or timer: use `K.hash` and `K.rand(seed)`.
- [ ] The length is whole half beats, and the last frame is exactly the declared hand-off.
- [ ] Readable text uses `K.text` or `K.mark`, and `scene-preview` reports no unsafe text for realistic Arabic and Latin params.
- [ ] It's added to `CASES` in `test/mograph-scenes.test.mjs`, and `node --test test/mograph-scenes.test.mjs` passes.
- [ ] A `scene-preview` sheet was looked at: hits, the hand-off frames, Arabic joins and punctuation.
- [ ] The catalog table above has its row.

## 5. The QA loop

```bash
capcutctl mograph scene-preview --scene my-idea --params '{"text":"كود"}' --out sheet.png            # 8 frames, zones outlined
capcutctl mograph scene-preview --scene my-idea --params '{"text":"كود"}' --out hits.png --times 0,0.5,1,1.95
capcutctl mograph scene-render  --scene my-idea --params '{"text":"كود"}' --out my-idea.mp4 --format mp4
```

Look at the sheet the way a viewer would. Is there one thing to look at per frame? Does the
last frame match the next scene's first? Do the words read, and do Arabic letters join?
