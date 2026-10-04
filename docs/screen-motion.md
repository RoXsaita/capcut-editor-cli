# Smooth screen recordings

Recording Layout v2's **Polished** cursor mode preserves `screen-clean.mp4` without the system cursor,
keeps high-frequency pointer/press telemetry, and puts the animated pointer in `screen.mp4`.
Older takes use `screen.mp4` for clean footage and `screen-preview.mp4` for the finished recording.
The app labels the current preset **Poison dagger + click animations**: the user's supplied
RuneScape Dragon dagger(p) sprite, mirrored horizontally to point upper-left,
approximately 22 px tall at 1920 px recording width, with a subtle glow, 60 fps movement sway
and click recoil around its precise blade-tip hotspot.

For the simplest manual editing workflow, import **screen.mp4** and apply
`screen-motion` to that clip. The pointer then moves with the recording when you adjust the
native zoom keys; no cursor rebuild is needed. Record `--derived-from /path/to/take/screen-clean.mp4`
when adding the preview through the CLI, so the clean original remains traceable. The preview
changes only the pointer, not the recording's framing.

For a separately editable cursor, import **screen-clean.mp4** instead and use the camera-then-cursor
workflow below. Keep the take directory's sidecars beside it.

## Camera, then cursor

Choose focus rectangles from the recording's actual pixels. Region `start` and `end` are
absolute **timeline seconds**: entrance begins at `start`, and exit/connection begins at `end`.
`focus` is `[x,y,width,height]` in the original recording. An optional `viewport` uses canvas
pixels, following the existing `keyframe --focus` geometry and safety checks.

```json
[
  {"start": 1, "end": 3, "focus": [0, 0, 500, 700]},
  {"start": 4, "end": 6, "focus": [200, 300, 500, 700]}
]
```

```bash
capcutctl screen-motion --project NAME --segment SCREEN_ID --regions regions.json --plan
capcutctl screen-motion --project NAME --segment SCREEN_ID --regions regions.json
capcutctl cursor --project NAME --segment SCREEN_ID --style polished --plan
capcutctl cursor --project NAME --segment SCREEN_ID --style polished
```

Both edits support transactional `--dry-run`. Existing camera keys require an explicit
`screen-motion --replace`. Nearby regions connect without a return to wide. An isolated zoom
uses four editable poses: wide, focused, end of hold, and wide again. Two connected focus
regions normally use six poses. CapCut's native `FreeCurveInOut` handles provide the easing
between them; scale and position share the same timing. The bounded ease-in-out curve avoids
overshoot at screen edges. Default entrance is 0.65 seconds, exit 0.7 seconds; tune with
`--zoom-in`, `--zoom-out` and `--glide`. Source trims and constant speed are accounted for.
This favors human editability over exact reproduction of Recordly's frame-by-frame spring.

The polished cursor uses the recorded pointer preset, physical spring motion, 350 ms click
compression, and blue rings delayed 175 ms after each press and fading over 600 ms. Rings stay
at the clicked source location and follow camera motion. `--size` defaults to 2.5 (70 px pointer
height at 1920 px screen width before zoom). Ring layers are reused when their lifetimes do not
overlap. Reapplying the operation replaces its owned layers.
New takes marked `capture.cursor.style: poison-dragon-dagger` use the matching dagger artwork
and a tip-anchored press bounce in the editable cursor. Older unmarked takes retain the arrow.
The recorder preview includes the dagger's rotational sway and recoil; native editable cursor
layers retain the existing position/scale animation only.

Apply the cursor **after** camera motion and final timing edits. Rerun it after changing the
camera, cuts or speed; its editable native keys are a compiled path, not a live parent-child
constraint. The legacy halo remains the default for `cursor` without `--style polished`.

## Limits

- Replacement requires explicit `capture.shows_cursor: false` from the matching source take.
  A burned-in cursor cannot be removed by adding another pointer over it.
- Complex masks, cropped/rotated/flipped footage, variable-speed curves and unsupported source
  opacity are refused rather than placing the cursor incorrectly.
- Directional/temporal motion blur and cursor sway are not reproduced by the editable cursor.
  The ring image scales its stroke with its radius; it is an approximation of the reference.
- These are independent implementations of standard spring/easing math and original artwork,
  informed by Recordly v1.4.0's behavior. No Recordly code or assets are bundled. This is not
  an exact reproduction of its PixiJS renderer.
- Native compatibility and visual evidence for this change are recorded in the QA report;
  a pure plan or a passing structural doctor is not a native-rendering claim.
