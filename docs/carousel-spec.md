# Carousel slide spec

`capcutctl carousel build --spec pack.json` turns one JSON file into a static carousel:
PNG slides, a contact sheet, `index.html` and `metadata.json`, measured by QA before anything
can be staged. A reel twin is one feeder of this file; an idea scout, or a person, is another.
The engine holds no taste of its own: what QA enforces is `rules`, what the slides look like is
`theme`, and the template's fixed words are `labels`. A carousel skill tunes those three.

```bash
capcutctl carousel build --spec pack.json [--out DIR] [--json]
capcutctl carousel stage --pack DIR --dashboard URL --remote HOST:DIR [--item ID] [--dry-run]
```

Rendering needs a Chrome (`CAPCUTCTL_CHROMIUM`) and, for QA, the Vision OCR helper
(`swiftc -O -o tools/vision/ocr tools/vision/ocr.swift`, macOS).

## Output

```
<out>/
  exports/instagram-3x4/slide-01.png …   the slides at the canvas size (1080×1440)
  exports/instagram-4x5/slide-01.png …   the same files, for dashboards that publish from that folder
  exports/contact-sheet-instagram-3x4.jpg (and a -4x5 copy)
  shots/                                  the cut UI frames (not staged)
  index.html                              slides + captions + the resolved spec (no local paths)
  metadata.json                           format, output_size, captions, QA verdict per slide
```

`build` exits 1 when QA fails, and `stage` refuses a pack whose QA is not PASS.

## Top level

| key | | |
|---|---|---|
| `slug` | required | lower-case letters, digits, dashes; the pack's folder name on the dashboard |
| `title` | | the pack's name on the dashboard |
| `handle` | | printed in every slide's footer |
| `canvas` | `"3x4"` | `"3x4"` = 1080×1440 (the feed's ratio), `"4x5"` = 1080×1350 |
| `caption`, `tiktokCaption` | | the Instagram and TikTok captions, staged exactly as written |
| `sourceItemId`, `sourcePostId`, `sourceUrl` | | what the carousel is a twin of, if anything |
| `labels` | | the template's fixed words, see below |
| `rules` | | what QA enforces, see below |
| `theme` | | the look, see below |
| `slides` | required | the slides, in order |

## Slides

Every slide has a `kind` and a `headline`. Text anywhere may put `code` in backticks: it renders
as a mono chip in the accent colour.

| kind | fields | renders |
|---|---|---|
| `cover` | `headline`, `sub`, `shot`, `needs` (list) | eyebrow label, the promise, the payoff shot, optional "what you need" chips |
| `step` | `headline`, `sub`, `shot` (required), `number`, `kicker`, `body` | badge + kicker + headline + one-line sub, then the shot in a framed card |
| `text` | `headline`, `sub`, `body`, `shot` | headline and paragraphs (blank line = new paragraph), optional shot |
| `prompt` | `headline`, `sub`, `blocks: [{label, text}]` | copy-this blocks in mono |
| `cta` | `headline`, `keyword`, `after` | the comment keyword in a large card |

Steps number themselves 1, 2, 3 … unless `number` is set; give two slides the same `number`
when one move takes two slides. The kicker reads `labels.stepOf` with `{n}` and `{total}`
(total = the highest step number), or the slide's own `kicker` (`""` drops it).

### Shots

A shot is a crop of a real frame. Coordinates are source pixels: `[x, y, w, h]`.

| key | |
|---|---|
| `take` | an rl2 take folder (`screen-clean.mp4` or `screen.mp4`, `frames.ndjson`, `trace.ndjson`) |
| `image` | or a still image instead of a take |
| `t` | seconds into the take's video |
| `click` | or a trace click id: the frame just after it (`after`, default +0.35 s), with the click marker drawn where it happened |
| `typing` | or a typing-burst id: the frame just before it ends (`after`, default −0.3 s), before Enter clears the input |
| `crop` | `[x, y, w, h]`, required |
| `highlight` | `[x, y, w, h]`, one rectangle drawn around what matters |
| `masks` | `[{rect: [x, y, w, h], color}]`, painted over private text |
| `dark` | `true` for a dark UI (the card's backing colour) |
| `marker` | `false` to hide the click marker |
| `width` | the pixel width to cut at (default: the card's inner width) |

The crop is scaled to the card width, so its width sets how large the UI text reads:
`text px on the slide ≈ source line height × card width / crop width`. A 1x capture with
~18 px lines needs a crop ≤ ~470 px wide to reach 36 px on a 952 px card; ~24 px terminal lines
allow ~630 px. Keep whole lines inside the crop: QA fails text that touches the card's edge.

## labels

| key | default |
|---|---|
| `eyebrow` | `دليل خطوة بخطوة` (cover; `""` hides it) |
| `needs` | `شو بتحتاج:` |
| `cta` | `اكتب بالتعليقات` |
| `stepOf` | `الحركة {n} من {total}` |

## rules

| key | default | QA |
|---|---|---|
| `canvas` | `"3x4"` | same as the top-level `canvas` |
| `safe` | `{x: 72, y: 45}` | every text line outside the shot stays this far from the sides and from top and bottom; y 45 keeps a centred 1080×1350 crop intact |
| `minTextPx` | 36 | the median OCR line height inside a step's shot |
| `minShotFill` | 0.55 | a step's card height ÷ the canvas height |
| `edgePadPx` | 20 | no OCR text (3+ characters) closer than this to the shot's left or right edge |
| `maxHeadlineWords` | 12 | |
| `slideCount` | `[6, 8]` | |
| `maxUpscale` | 2.8 | warns when a crop is scaled past this (reads soft) |
| `requirePrompt` | true | the carousel has a `prompt` slide |
| `requireKeyword` | true | the CTA has a `keyword` |

Privacy runs on every slide's OCR text and always fails the build: the screen watcher's rules,
home paths, shell prompts and emails. QA records rule names, never the matched text.

## theme

Each key becomes a `--kebab-case` CSS custom property in `mograph/carousel/guide.html`.
Numbers are pixels; strings are CSS values. The brand and accent colours come from the
user profile's `tokens.color` (the bundled defaults are neutral).

| key | default | | key | default |
|---|---|---|---|---|
| `bg` | `#F5F5F9` | | `h1` | 60 |
| `card` | `#FFFFFF` | | `h1Cover` | 80 |
| `muted` | `#4A4A5C` | | `sub` | 34 |
| `padX` | 90 | | `body` | 38 |
| `padTop` | 48 | | `kicker` | 30 |
| `padBottom` | 40 | | `badge` | 104 |
| `gap` | 40 | | `footer` | 30 |
| `cardMargin` | 60 | | `cardBorder` | 4 |
| `cardRadius` | 36 | | `shadow` | `0 18px 48px rgba(11,11,20,.12)` |

## A minimal spec

```json
{
  "slug": "routine-every-5h-guide-v1",
  "handle": "yourhandle",
  "caption": "…",
  "slides": [
    { "kind": "cover", "headline": "روتين بيشتغل لحاله كل ٥ ساعات",
      "shot": { "image": "history.png", "crop": [30, 400, 410, 372] } },
    { "kind": "step", "headline": "اعمل روتين جديد",
      "shot": { "take": "takes/Claude-20261010", "click": 22, "crop": [0, 120, 432, 330] } },
    { "kind": "step", "headline": "خلّيه يشتغل كل ٥ ساعات", "sub": "التوقيت `1 */5 * * *`",
      "shot": { "take": "takes/Claude-20261010", "t": 10.4, "crop": [30, 540, 440, 365], "highlight": [56, 668, 140, 40] } },
    { "kind": "prompt", "headline": "انسخ والصق", "blocks": [{ "label": "التوقيت", "text": "1 */5 * * *" }] },
    { "kind": "cta", "headline": "بدك الدليل الكامل؟", "keyword": "روتين" }
  ],
  "rules": { "slideCount": [5, 8] }
}
```
