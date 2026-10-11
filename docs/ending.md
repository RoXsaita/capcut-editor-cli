# Reusable follow ending

`ending` appends a three-second full-frame animation: the supplied frame collapses into a
circular avatar, a countdown dial sweeps around it, a badge appears, and a follow button
turns into a check. Sound follows those visible events. It uses the existing Chromium scene
renderer and procedural sound engine; there is no Remotion studio or Python audio dependency.

```bash
capcutctl ending --project "My Edit" --dry-run
capcutctl ending --project "My Edit"
# Review just the ending, without changing a CapCut project:
capcutctl ending --frame last-frame.png --out ending-preview.mp4
```

## In the pipeline

Set `"auto": true` in your profile's `ending` and every `build` appends it, after the graphics
(so it opens on the final picture) and before the sound stage (so the music bed and loudness
cover it). In `edit.json`, `"ending": false` skips it for one video and removes one placed
earlier; `"ending": { "pill": "…", "badge": "2" }` overrides the copy for one video; `"ending":
true` turns it on without `auto`. With no `ending` key and `auto` off, `build` leaves an ending
placed by hand alone.

## The opening frame

In a project, the opening frame is **the edit's own last picture**: the last displayed source
frame of the principal clip that ends the edit, fitted to the canvas with that clip's scale,
position and flip at that moment. A recut changes the frame, the frame changes the render, and
the ending follows. The report's `captured` says where it came from:

- `approximate` lists what the media cannot reproduce exactly: eased keyframes mid-ramp,
  rotation, opacity, masks, effects/filters on the clip, a crop. Empty means the frame is exact
  up to encoding (measured on a real export: 2.8/2.5/2.7 of 255 mean difference per channel,
  less than between two consecutive frames of that export, 4.2).
- `onTop` lists layers CapCut draws over the last frame (text such as the endcard, overlays).
  They are not in the media, so they cut away as the ending starts.

`--frame` (or `edit.json` `ending.frame`) replaces the capture. Without a project (`--out`),
the frame comes from `--frame` or the profile's `ending.frame`.
The first rendered frame preserves an opaque supplied image; other image sizes are cover fitted.
PNG transparency composites over the profile's ink color.
Face coordinates refer to the resulting 1080×1920 canvas, in pixels. Check a preview when
using a different crop. `ending` does not export or capture a CapCut project.

## Private profile

Run `capcutctl profile where` to find your user file (normally
`~/.config/capcutctl/profile.json`). Add only the fields you want to override:

```json
{
  "ending": {
    "auto": true,
    "frame": "media/ending-frame.png",
    "faceX": 540,
    "faceY": 920,
    "faceScale": 0.46,
    "pill": "Next up",
    "headline": "Follow",
    "sub": "New videos every week",
    "badge": "2"
  }
}
```

`auto` makes `build` append it. `badge: ""` hides the badge (and its sound).
`frame` is only used for `--out` previews; a relative profile path resolves beside the
profile layer that defines it. `--frame` resolves from the command's working directory.
PNG and JPEG are accepted, up to 20 MB. Use `--profile FILE` for per-video copy/position
overrides; that file merges over your user profile. `sub: null` uses `brand.handle`, then
`brand.name`, then an empty line. Arabic phrases remain joined and can replace every copy
field. Empty required labels, multiline or excessive copy, invalid coordinates, and text
that falls under the platform UI refuse before the draft changes.

`faceScale` controls the final image size inside the avatar (greater than zero, at most 1).
Colors use `tokens.color.brand`, `accent`, `ink`, and `text`; fonts use `tokens.font`.
Timing stays three seconds regardless of the profile's scene tempo. The canvas must be
1080×1920 and the project FPS must match `profile.canvas.fps` (default 30).

## Repeatability and project safety

Placement follows the principal picture's end, ignores parked template material, and replaces
only `mograph:follow-ender`. `build` re-places it on every rebuild; after a recut outside
`build`, rerun `ending`. The endcard and captions keep timing off the picture's end, never the
ending's, so a rebuild does not slide them into it.
Unrelated endcards and other overlays are left in place. A collision with the preserved
template range refuses rather than moving your material.

Project renders live in `<project>/mograph/ending-<hash>.mov`. The hash includes image bytes,
copy, profile tokens, scene code, and sound code. An unchanged render is reused, and an
unchanged placement is a no-op. New renders use separate filenames so failures leave the
previous ending's media intact. Placement uses normal snapshots, mirror validation, and
rollback; CapCut must be closed before a write. `--dry-run` decodes/probes/validates and writes
no files. `--no-sfx` renders silence and places a silent clip.

The repo ships the neutral animation and example profile fields. Keep real images, handles,
and personal copy in your user profile/media directory, outside the checkout. The animation
is a rendered clip in CapCut; rerun the command to change its internal copy or face crop.
Its motion/sound is an adaptation to the existing scene engine, rather than a pixel or
sample identical reproduction of the source composition. Repeatability applies to a fixed
renderer/font/toolchain; encoding bytes can differ between toolchains. Native CapCut import
still reports `importVerified: false` until checked on that CapCut build.
