# Reusable native motion

The text treatments demonstrated in `Native-Motion-Lab` were reviewed on the Mac by the user. Preserve that look rather than replacing it with a pixel-rendered imitation. These commands create **editable CapCut layers in an existing project**, not an exported MP4. The original reference's layered 3D effect is not implemented.

Close CapCut before a real write. List the surface without opening a project:

```sh
capcutctl motion list
```

## One command per effect

```sh
capcutctl motion shimmer --project "My Edit" --text "SUHEIL AI" --at 4 --duration 4
capcutctl motion orbit-glow --project "My Edit" --text "NATIVE" --at 8 --duration 4
capcutctl motion gradient --project "My Edit" --text "HELLO" --color FF641C --accent FFE66B
capcutctl motion spotlight --project "My Edit" --asset /absolute/path/logo.png --at 12 --duration 5
```

- `--asset FILE` and `--logo FILE` are aliases. Supply exactly one of text or an image. Do not supply both aliases.
- Gradient supports text only. Image inputs for other recipes are structurally tested but remain visually experimental. In particular, shimmer does not yet brighten the image duplicate, so use **text for a reliable shimmer treatment**.
- The instance name defaults to `RECIPE-AT`, for example `shimmer-4`. Set `--name custom-id` for another instance at the same time.
- Repeat identical inputs on an untouched instance safely: no duplicate layers. Changed inputs or manual edits refuse; choose a new name instead of silently overwriting work.
- Defaults: start 0 seconds, duration 4 seconds, centered, text scale 2, image scale 0.5. Set `--scale`, `--x`, `--y`, `--color`, `--accent` as needed. Coordinates use half-canvas units with positive Y up; colors are six hex digits without `#`.
- Add `--dry-run` to validate without modifying the project. The real command snapshots, checks references, and updates root/timeline mirrors through the standard transaction layer.
- Native text stays editable inside compounds. Image assets are localized into the project. Main/cover track remains empty.
- Local CapCut mask/Blur downloads are required. Missing resources fail with a named error; proprietary effect payloads are not bundled.

## Visual boundaries

These are the reusable demo treatments, not a claim of exact tutorial parity. Keys currently use linear interpolation. Spotlight is a traveling/expanding Circle mask with slight Blur rather than the tutorial's text-glow style. Gradient is static. Layered 3D is excluded.

## Export selection pitfall

A project cloned from a native draft may inherit a tiny `config.export_range`. Check that selection before export. With CapCut closed, clear it transactionally using `apply --spec`:

```json
{"version":1,"operations":[{"op":"timeline.set","exportRange":null}]}
```

This field is opt-in and only accepts null to clear the selection. Other timeline edits preserve it. Exported duration must still be independently checked; this command does not certify the GUI export bridge or auto-export anything.
