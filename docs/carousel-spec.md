# Carousel slide spec

`capcutctl carousel build --spec pack.json` turns one JSON file into a static carousel:
PNG slides, a 9:16 copy for TikTok, a contact sheet, `index.html` and `metadata.json`, measured
by QA before anything can be staged. A reel twin is one feeder of this file; an idea scout, or a
person, is another. The engine holds no taste of its own: what QA enforces is `rules`, what the
slides look like is the `theme` folder, and the template's fixed words are `labels`. A carousel
skill tunes those three.

```bash
capcutctl carousel build --spec pack.json [--out DIR] [--json]
capcutctl carousel stage --pack DIR --dashboard URL --remote HOST:DIR [--item ID] [--dry-run]
```

Rendering needs a Chrome (`CAPCUTCTL_CHROMIUM`), ffmpeg, and for QA the Vision OCR helper
(`swiftc -O -o tools/vision/ocr tools/vision/ocr.swift`, macOS).

## Output

```
<out>/
  exports/instagram-3x4/slide-01.png …   the slides at the canvas size (1080×1440)
  exports/instagram-4x5/slide-01.png …   the same files, for dashboards that publish from that folder
  exports/tiktok-9x16/slide-01.png …     each slide on a 1080×1920 page, bottom 10% left clear
  exports/contact-sheet-instagram-3x4.jpg (and a -4x5 copy)
  shots/                                  the cut UI frames (not staged)
  index.html                              slides + captions + the resolved spec (no local paths)
  metadata.json                           format, theme, captions, alt text, QA verdict per slide
```

The 9:16 copy pads the slide with the theme's `bg`, centred in the top 90% of the page
(a 1440 slide starts at y 144), so TikTok's caption and buttons cover no text.

`build` exits 1 when QA fails, and `stage` refuses a pack whose QA is not PASS. Staging an
updated pack under the same `slug` replaces its files and updates the captions of its open
draft job in place.

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
| `theme` | `"plain"` | the look, see below |
| `slides` | required | the slides, in order: a `cover` first, a `cta` last |

## Slides

Every slide has a `kind` and a `headline`. Text anywhere may put `code` in backticks: it renders
as a mono chip. `alt` sets the slide's alt text (default: the headline plus each shot's `alt`).

| kind | fields | renders |
|---|---|---|
| `cover` | `headline`, `sub`, `shot`, `needs` (list) | eyebrow label, the promise, the payoff shot, optional "what you need" chips, the swipe cue |
| `step` | `headline`, `sub`, `shot` (required), `number`, `kicker` | badge + kicker + headline + one-line sub, then the shot in a framed card |
| `proof` | `headline`, `sub`, `shot` (required), `figure` | a receipt: headline, the one number large (`figure`), the shot as evidence |
| `compare` | `headline`, `sub`, `shots: [a, b]` (each with `label`) | two results, equal treatment, each labelled |
| `note` | `headline`, `body` or `items`, `shot` | an honest step, takeaway or timeline: paragraphs (blank line = new one) or a numbered list, optional shot |
| `prompt` | `headline`, `sub`, `blocks: [{label, text}]` | copy-this blocks in mono |
| `cta` | `headline`, `keyword`, `after` | the comment keyword in a large card, or `labels.save` without one |

`text` is accepted as an older name for `note`. A slide takes `shot` (one) or `shots` (a list).

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
| `label` | the shot's caption (required on `compare`) |
| `alt` | what the shot shows, for the slide's alt text |
| `width` | the pixel width to cut at (default: the card's inner width, 872 on the plain theme) |

The crop is scaled to the card width, so its width sets how large the UI text reads:
`text px on the slide ≈ source line height × card width / crop width`. A 1x capture with
~18 px lines needs a crop ≤ ~430 px wide to reach 36 px on an 872 px card; ~24 px terminal
lines allow ~580 px, which is too narrow for a full terminal line: record terminal moments at a
larger font. Keep whole lines inside the crop: QA fails text that touches the card's edge.

## labels

| key | default |
|---|---|
| `eyebrow` | `دليل خطوة بخطوة` (cover; `""` hides it) |
| `needs` | `شو بتحتاج:` |
| `cta` | `اكتب بالتعليقات` |
| `stepOf` | `الحركة {n} من {total}` |
| `save` | `احفظه، وارجعله وقت ما تحتاجه` (the CTA when there is no keyword) |
| `swipe` | `اسحب` (the cover's swipe cue; `""` hides it) |

## rules

QA measures the rendered page itself (every text's role, font size and box, every card's box),
and OCR only inside the shots.

| key | default | QA |
|---|---|---|
| `canvas` | `"3x4"` | same as the top-level `canvas` |
| `inset` | 100 | every text and card stays this far inside all four edges |
| `bottomClear` | 0.10 | nothing but the footer in the bottom 10% of the canvas |
| `minPx` | `{coverHeadline: 96, headline: 72, sub: 44, body: 44, code: 40, any: 28}` | the rendered font size per text role |
| `maxWords` | `{coverHeadline: 8, headline: 7}` | headline length, checked before rendering |
| `slideWords` | `[8, 22]` | words per slide; outside is a warning |
| `maxSlideWords` | 30 | over this fails, except on a dense slide (`dense: true`; `prompt` is dense) |
| `minTextPx` | 36 | the smallest shot's median OCR line height, on every slide with a shot except the cover |
| `minShotFill` | 0.55 | a step's card heights ÷ the canvas height |
| `edgePadPx` | 20 | no OCR text (3+ characters) closer than this to the shot's left or right edge |
| `slideCount` | `[6, 10]` | |
| `maxUpscale` | 2.8 | warns when a crop is scaled past this (reads soft) |
| `requirePrompt` | true | the carousel has a `prompt` slide |
| `requireKeyword` | false | the CTA has a `keyword`. Set it only when something real answers the keyword |

`minPx` and `maxWords` merge with the defaults key by key. Privacy runs on every slide's OCR text
and always fails the build: the screen watcher's rules, home paths, shell prompts and emails.
QA records rule names, never the matched text.

## Themes

A theme is a folder: `theme.json` plus the template it names. The bundled one is
`mograph/carousel/themes/plain`. `theme` in the spec is

- a name: `"plain"`, a folder under `mograph/carousel/themes/`;
- a path (anything with a `/`): a theme folder anywhere, resolved against the spec's folder;
- an object: `{ "name": "plain", "h1": 80 }`, a theme plus overrides of its `vars`.

```json
{
  "name": "plain",
  "about": "one line on the look",
  "template": "template.html",
  "fonts": [{ "family": "Plex Arabic", "file": "fonts/x.woff2", "weight": 700, "range": "U+0600-06FF" }],
  "vars": { "bg": "#F5F5F9", "h1": 72, "cardMargin": 100 }
}
```

Font `file`s resolve against the theme folder. Each `vars` key reaches the template as data and
is meant to become a `--kebab-case` CSS custom property; numbers are pixels. `cardMargin` and
`cardBorder` also set the width shots are cut at (canvas width − 2 × (cardMargin + cardBorder)).
The brand, accent and ink colours come from the user profile's `tokens.color`.

### The template contract

The engine opens the template once, then for every slide calls `window.renderSlide(data)` and
screenshots the canvas. `data` holds `kind`, `index`, `total`, `number` (Arabic digits),
`kicker`, `headline`, `sub`, `body`, `items`, `figure`, `needs`, `blocks`, `keyword`, `after`,
`handle`, `canvas {width, height}`, `inset`, `vars`, `fonts`, `colors {brand, accent, ink}`,
`labels`, and `shots: [{url, label, width, height, marker, highlight, masks, dark}]`, with
`marker`, `highlight` and `masks` already in the shot image's pixels. The template must

- size the page to `data.canvas` and keep every text and card inside `data.inset`;
- load `data.fonts` and apply `data.vars`;
- tag every piece of text with `data-role`: `coverHeadline`, `headline`, `kicker`, `sub`, `body`,
  `figure`, `label`, `code`, `eyebrow`, `hint`, `keyword`, `after`, `swipe`, `footer`;
- return `{ shots: [rect], cards: [rect], texts: [{role, px, rect, text}] }`, rects
  `{x, y, width, height}` in canvas pixels, one shot and one card per entry of `data.shots`.

QA reads only that return value and the screenshot, so any layout that keeps the contract passes
or fails on the same rules.

## A minimal spec

```json
{
  "slug": "routine-every-5h-guide-v1",
  "handle": "yourhandle",
  "caption": "…",
  "rules": { "slideCount": [5, 10], "requirePrompt": false },
  "slides": [
    { "kind": "cover", "headline": "روتين بيشتغل لحاله كل ٥ ساعات",
      "shot": { "image": "history.png", "crop": [30, 400, 410, 372], "alt": "four scheduled runs" } },
    { "kind": "step", "headline": "اعمل روتين جديد",
      "shot": { "take": "takes/Claude-20261010", "click": 22, "crop": [0, 120, 420, 330] } },
    { "kind": "step", "headline": "خلّيه يشتغل كل ٥ ساعات", "sub": "التوقيت `1 */5 * * *`",
      "shot": { "take": "takes/Claude-20261010", "t": 10.4, "crop": [34, 540, 420, 382], "highlight": [56, 668, 140, 40] } },
    { "kind": "note", "headline": "ليش ٥ ساعات؟", "body": "الليمت بيتجدد كل ٥ ساعات." },
    { "kind": "cta", "headline": "جرّبه بجلستك الجاية" }
  ]
}
```
