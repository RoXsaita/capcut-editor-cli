# Prompt for a computer-use agent: CapCut harvest sessions Q02 + Q04

Hand everything below the line to the agent. It is self-contained.

---

You are driving **CapCut 9.4.x on macOS** to answer two questions about the app's own save
format. You are not editing a video and not producing anything creative. You are running a
controlled experiment: make CapCut write something by hand, then capture what it wrote.

A command-line tool called `capcutctl` is already installed and on `PATH`. You will use
exactly two of its subcommands, both read-only. Everything else you do is in the CapCut UI.

## Absolute rules

1. **Work only on projects you create during this session.** The user has ~100 real
   projects in CapCut. Do not open, edit, save, or capture any project you did not create.
   If you are unsure whether a project is yours, it is not — make a new one.
2. **Never run any `capcutctl` command other than `capcutctl oracle capture` and
   `capcutctl oracle diff`.** Those two only read and copy. Every other verb writes to a
   draft.
3. **Quit CapCut completely before every capture.** ⌘Q, then confirm the process is gone.
   A capture taken while CapCut is running may catch a half-written file. Waiting for the
   app to fully exit is the single most important step in this procedure.
4. **Do not guess, extrapolate, or tidy up.** If a step does not work — the control is not
   there, the app refuses, the menu differs — stop and report exactly what you saw. A
   wrong answer here is far worse than no answer. "I could not find the feather slider" is
   a useful result. An invented number is not.
5. Do not delete anything. Do not empty trash. Do not change CapCut preferences.

## The capture command

```bash
capcutctl oracle capture --project "PROJECT_NAME" --label LABEL
```

`PROJECT_NAME` is the project's name as CapCut shows it. It copies the whole project
folder to `.capcutctl/oracle/LABEL` inside that project. Each label may be used only once
per project — if you need to redo a step, use a new label like `b-written-2`.

To compare two captures:

```bash
capcutctl oracle diff \
  --before "/full/path/to/.capcutctl/oracle/LABEL_A" \
  --after  "/full/path/to/.capcutctl/oracle/LABEL_B" \
  --values
```

`--values` makes it print the actual JSON of every record that changed. **That JSON is the
deliverable.** The capture command prints the full path it wrote to; use that path.

Projects live under `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<PROJECT_NAME>`.

---

# Experiment 1 — Does CapCut store volume keyframes, and how?

**What we need to know:** whether a music clip can carry volume automation in the saved
file, and if so under what property name, in what units, and whether it survives a reopen.

We already know CapCut writes keyframes named `KFTypeScaleX`, `KFTypePositionX`,
`KFTypePositionY`, `KFTypeRotation`, `KFTypeScaleY`, `KFTypeWhite` and `KFTypeAlpha`.
We have never seen one for volume. **Do not assume it is called `KFTypeVolume`.** Report
whatever name actually appears.

### Steps

1. Open CapCut. Create a **new empty project**. Name it exactly `oracle-volume`.
2. Add any audio or music clip to the timeline — CapCut's own stock music is fine, or any
   audio file. One clip, at least 10 seconds long. Add nothing else.
3. ⌘S to save. ⌘Q to quit. **Wait until CapCut has fully exited.**
4. Capture the baseline:
   ```bash
   capcutctl oracle capture --project "oracle-volume" --label a-before
   ```
5. Reopen CapCut and the `oracle-volume` project.
6. Select the audio clip. Find the **volume** control, and add **three volume keyframes**
   along the clip:
   - one near the start at normal/full volume (0 dB)
   - one in the middle, clearly quieter — about **−12 dB**, or roughly a quarter of the
     way up the slider if the UI shows no number
   - one near the end back at normal/full volume (0 dB)

   In CapCut this is usually: select the clip → Audio panel → the diamond/keyframe button
   next to Volume, adding a keyframe at each playhead position. **Write down what the UI
   actually showed you** — whether the volume control was labelled in dB, in percent, or
   unlabelled, and what the three values read as on screen. We need this to interpret the
   numbers in the file.
7. Play it back briefly and confirm you can hear the volume dip and come back. Note
   whether you could.
8. ⌘S. ⌘Q. **Wait for full exit.**
9. Capture what CapCut wrote:
   ```bash
   capcutctl oracle capture --project "oracle-volume" --label b-written
   ```
10. Read off what changed — **this is the main result**:
    ```bash
    capcutctl oracle diff \
      --before "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/oracle-volume/.capcutctl/oracle/a-before" \
      --after  "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/oracle-volume/.capcutctl/oracle/b-written" \
      --values > ~/Desktop/oracle-volume-diff.json
    ```
    Then show the contents of that file.
11. **Survival check.** Reopen the project in CapCut. Do not change anything meaningful —
    drag one clip one frame to the right and back, so the app considers the project
    touched. ⌘S. ⌘Q. Wait for full exit.
    ```bash
    capcutctl oracle capture --project "oracle-volume" --label c-roundtripped
    capcutctl oracle diff \
      --before ".../oracle-volume/.capcutctl/oracle/b-written" \
      --after  ".../oracle-volume/.capcutctl/oracle/c-roundtripped" \
      --values > ~/Desktop/oracle-volume-roundtrip.json
    ```
    Show that file too.
12. Reopen once more and confirm by ear that the volume dip is **still there**. Say
    plainly whether it is.

### Report back for Experiment 1

- The full JSON from both diffs.
- The property name CapCut actually used for volume keyframes.
- What the UI showed for the three values (dB? percent? unlabelled slider?).
- Whether the dip was audible before the round trip, and still audible after.
- **If CapCut has no way to keyframe volume at all, say so and stop.** That is a valid and
  important answer. Do not substitute fade handles, a volume envelope drawn on the
  waveform, or clip-level volume — if that is all that exists, describe exactly what you
  found instead.

---

# Experiment 2 — How does CapCut store a rectangle mask's feather and corner radius?

**What we need to know:** the numeric encoding of a rectangle mask — specifically what
`feather` and corner-radius values look like in the file at known UI settings, so we can
write them from a script without guessing.

### Steps

1. Create a **new empty project** named exactly `oracle-mask`.
2. Add any **video** clip to the timeline. One clip. Add nothing else.
3. ⌘S, ⌘Q, wait for full exit, then:
   ```bash
   capcutctl oracle capture --project "oracle-mask" --label a-before
   ```
4. Reopen. Select the video clip → **Mask** → choose **Rectangle**.
5. Leave feather and corner radius at their defaults for now. Note the default values the
   UI shows. ⌘S, ⌘Q, wait, then:
   ```bash
   capcutctl oracle capture --project "oracle-mask" --label b-rect-default
   ```
6. Now do **four** passes. In each one: reopen the project, set **feather** to the target
   value, leave everything else alone, ⌘S, ⌘Q, wait for full exit, capture.

   | Feather setting in the UI | Capture label |
   |---|---|
   | 0 (minimum) | `c-feather-0` |
   | 25% (or a quarter of the slider) | `c-feather-25` |
   | 50% (halfway) | `c-feather-50` |
   | 100% (maximum) | `c-feather-100` |

   **Record what the UI displayed each time** — the number in the box, or if there is no
   number, describe the slider position.

7. Then two passes for **corner radius**, same procedure:

   | Corner radius setting | Capture label |
   |---|---|
   | 0 (square corners) | `d-corner-0` |
   | maximum (fully rounded) | `d-corner-max` |

8. Produce the diffs. The interesting ones are each setting against the default:
   ```bash
   B=".../oracle-mask/.capcutctl/oracle"
   for L in c-feather-0 c-feather-25 c-feather-50 c-feather-100 d-corner-0 d-corner-max; do
     capcutctl oracle diff --before "$B/b-rect-default" --after "$B/$L" --values \
       > ~/Desktop/oracle-mask-$L.json
   done
   ```
   Also the one that shows the mask being created in the first place:
   ```bash
   capcutctl oracle diff --before "$B/a-before" --after "$B/b-rect-default" --values \
     > ~/Desktop/oracle-mask-created.json
   ```
   Show all of these files.

9. While the mask is applied, also check and report: **is there an "invert" toggle** on the
   rectangle mask, and does the UI offer width/height/position controls for it? Do not
   change them — just say what exists.

### Report back for Experiment 2

- All the diff JSON files.
- A small table pairing **the value you set in the UI** with **the value that appeared in
  the file**, for feather and for corner radius. This pairing is the entire point — a file
  value with no UI value beside it is useless to us.
- Whether the mask's `resource_type` (or equivalent type field) says `rectangle` or
  something else.
- Whether an invert control exists.

---

## Finishing up

Leave both `oracle-volume` and `oracle-mask` projects in place — do not delete them. The
capture folders inside them are the raw evidence.

Report all JSON in full. Do not summarise the numbers, do not round them, and do not
reformat them. If any step failed or behaved unexpectedly, say exactly where and what you
saw rather than working around it.
