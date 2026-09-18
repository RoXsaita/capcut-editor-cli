# CapCut harvest sessions: Q02 (volume keyframes) and Q04 (rectangle mask)

**If you are the agent reading this file: this whole file is your brief. Start at
"Your task" below.**

---

## Your task

You are driving **CapCut on macOS** to answer two questions about the app's own save
format. You are not editing a video and not producing anything creative. You are running a
controlled experiment: make CapCut write something by hand in its UI, then capture what it
wrote to disk and report the raw JSON.

You need to be able to control the user's actual Mac — the real CapCut app and a real
terminal on that machine. If you are working in your own sandboxed VM and cannot see the
user's CapCut or their `~/Movies` folder, **stop now and say so**; this task is impossible
from a sandbox and nothing useful can be faked.

A command-line tool called `capcutctl` is already installed. You will use exactly two of
its subcommands, both read-only. Everything else you do is in the CapCut UI.

## Absolute rules

1. **Work only on projects you create during this session.** The user has ~100 real
   projects in CapCut, some of them client work. Do not open, edit, save, or capture any
   project you did not create. If you are unsure whether a project is yours, it is not —
   make a new one.
2. **Never run any `capcutctl` command other than `capcutctl oracle capture` and
   `capcutctl oracle diff`.** Those two only read and copy. Every other verb writes to a
   draft and could damage real work.
3. **Quit CapCut completely before every capture.** ⌘Q, then confirm the process is
   actually gone (`pgrep -x CapCut` should print nothing). A capture taken while CapCut is
   running may catch a half-written file. This is the single most important step in the
   procedure.
4. **Do not guess, extrapolate, or tidy up.** If a step does not work — the control is not
   there, the app refuses, the menu looks different — stop and report exactly what you saw.
   A wrong answer here is far worse than no answer. "I could not find the feather slider"
   is a useful result. An invented number is not, and will be acted on as if it were real.
5. Do not delete anything, do not empty the trash, do not change CapCut preferences, and
   do not sign into or out of any account.

## Setup — run these first

```bash
# 1. Confirm the tool is reachable. If `capcutctl` is not found, use this absolute path
#    everywhere below instead of the bare word `capcutctl`:
#       ~/.local/bin/capcutctl
which capcutctl || ls -l ~/.local/bin/capcutctl

# 2. The folder all CapCut projects live in. Every path below is relative to this.
DRAFTS="$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft"
ls "$DRAFTS" | head

# 3. Report the CapCut version — we need to know which build these answers describe.
defaults read /Applications/CapCut.app/Contents/Info.plist CFBundleShortVersionString
```

**Finding the project you just made.** CapCut names new projects automatically (usually
today's date, like `0918`) and renaming one in the UI does not reliably rename its folder
on disk. So do not assume a name — after creating and saving a project, find its folder as
the most recently modified one:

```bash
ls -dt "$DRAFTS"/*/ | head -3
```

The top entry is the project you just made. Store it and use it for the rest of that
experiment:

```bash
VOL="$(ls -dt "$DRAFTS"/*/ | head -1)"; echo "$VOL"
```

Sanity-check that it is yours before continuing — `ls "$VOL"` should show a
`draft_info.json`, and the folder should not be one that existed before you started.

## The two commands you will use

**Capture** copies a whole project folder to `.capcutctl/oracle/LABEL` inside that project:

```bash
capcutctl oracle capture --project "$VOL" --label a-before
```

Each label may be used only once per project. If you need to redo a step, use a new label
like `a-before-2`.

**Diff** compares two captures and prints what changed. `--values` makes it print the
actual JSON of every changed record — **that JSON is the deliverable**:

```bash
capcutctl oracle diff --before "$VOL/.capcutctl/oracle/a-before" \
                      --after  "$VOL/.capcutctl/oracle/b-written" --values
```

---

# Experiment 1 — Does CapCut store volume keyframes, and how?

**What we need to know:** whether an audio clip can carry volume automation in the saved
file; if so, under what property name, in what units, and whether it survives a reopen.

We already know CapCut writes keyframes named `KFTypeScaleX`, `KFTypePositionX`,
`KFTypePositionY`, `KFTypeRotation`, `KFTypeScaleY`, `KFTypeWhite` and `KFTypeAlpha`. We
have never seen one for volume, and **we do not know what it is called**. Report whatever
name actually appears in the file. Do not go looking for a name you expect.

### Steps

1. Open CapCut and create a **new empty project**.
2. Add one **audio clip** to the timeline, at least 10 seconds long. Any audio file on the
   Mac works. If CapCut's stock music library asks you to sign in or shows a Pro badge,
   skip it and use a local file instead — a video file with audio is also fine, as long as
   there is a waveform you can keyframe. Add nothing else to the project.
3. ⌘S to save. ⌘Q to quit. Confirm CapCut has fully exited.
4. Find and store the project folder, then capture the baseline:
   ```bash
   VOL="$(ls -dt "$DRAFTS"/*/ | head -1)"; echo "$VOL"
   capcutctl oracle capture --project "$VOL" --label a-before
   ```
5. Reopen CapCut and that project.
6. Select the audio clip. Find the **volume** control, and add **three volume keyframes**
   along the clip:
   - one near the start at normal/full volume (0 dB)
   - one in the middle, clearly quieter — about **−12 dB**, or roughly a quarter of the way
     up the slider if the UI shows no number
   - one near the end, back at normal/full volume (0 dB)

   In CapCut this is usually: select the clip → Audio panel → the diamond/keyframe button
   beside Volume, adding a keyframe at each playhead position.

   **Write down what the UI actually showed you** — whether the volume control was labelled
   in dB, in percent, or was an unlabelled slider, and what each of the three settings read
   as on screen. Without this the numbers in the file cannot be interpreted.
7. Play it back and confirm you can hear the volume dip and return. Note whether you could.
8. ⌘S. ⌘Q. Confirm full exit.
9. Capture what CapCut wrote:
   ```bash
   capcutctl oracle capture --project "$VOL" --label b-written
   capcutctl oracle diff --before "$VOL/.capcutctl/oracle/a-before" \
                         --after  "$VOL/.capcutctl/oracle/b-written" \
                         --values > ~/Desktop/oracle-volume-diff.json
   cat ~/Desktop/oracle-volume-diff.json
   ```
10. **Survival check.** Reopen the project. Change nothing meaningful — drag one clip one
    frame right and back, so the app considers the project touched. ⌘S. ⌘Q. Confirm exit.
    ```bash
    capcutctl oracle capture --project "$VOL" --label c-roundtripped
    capcutctl oracle diff --before "$VOL/.capcutctl/oracle/b-written" \
                          --after  "$VOL/.capcutctl/oracle/c-roundtripped" \
                          --values > ~/Desktop/oracle-volume-roundtrip.json
    cat ~/Desktop/oracle-volume-roundtrip.json
    ```
11. Reopen once more and confirm **by ear** that the volume dip is still there. Say plainly
    whether it is.

### Report back for Experiment 1

- The full JSON from both diffs, verbatim.
- The property name CapCut actually used for volume keyframes.
- What the UI showed for each of the three values (dB? percent? unlabelled slider?).
- Whether the dip was audible before the round trip, and still audible after.
- **If CapCut offers no way to keyframe volume at all, say so and stop.** That is a valid
  and important answer. Do not substitute fade handles, a volume envelope drawn on the
  waveform, or a single clip-level volume setting — if one of those is all that exists,
  describe exactly what you found instead and say that keyframes were not available.

---

# Experiment 2 — How does CapCut store a rectangle mask's feather and corner radius?

**What we need to know:** the numeric encoding of a rectangle mask, so it can be written
from a script without guessing. Specifically: what feather and corner-radius values look
like in the file at **known** UI settings.

### Steps

1. Create a **new empty project**. Add one **video** clip to the timeline. Nothing else.
2. ⌘S, ⌘Q, confirm exit, then find and store this project's folder — note this is a
   different variable from Experiment 1:
   ```bash
   MASK="$(ls -dt "$DRAFTS"/*/ | head -1)"; echo "$MASK"
   capcutctl oracle capture --project "$MASK" --label a-before
   ```
3. Reopen. Select the video clip → **Mask** → choose **Rectangle**. Leave feather and
   corner radius at their defaults. **Note the default values the UI shows.** ⌘S, ⌘Q,
   confirm exit, then:
   ```bash
   capcutctl oracle capture --project "$MASK" --label b-rect-default
   ```
4. Now do **four** passes for feather. Each pass: reopen the project, set feather to the
   target, change nothing else, ⌘S, ⌘Q, confirm exit, capture.

   | Feather setting in the UI | Capture label |
   |---|---|
   | 0 (minimum) | `c-feather-0` |
   | 25% (or a quarter of the slider) | `c-feather-25` |
   | 50% (halfway) | `c-feather-50` |
   | 100% (maximum) | `c-feather-100` |

   ```bash
   capcutctl oracle capture --project "$MASK" --label c-feather-0     # etc.
   ```

   **Record what the UI displayed each time** — the number in the box, or if there is no
   number, the slider position as a fraction.

5. Then two passes for **corner radius**, same procedure:

   | Corner radius setting | Capture label |
   |---|---|
   | 0 (square corners) | `d-corner-0` |
   | maximum (fully rounded) | `d-corner-max` |

6. Produce the diffs:
   ```bash
   O="$MASK/.capcutctl/oracle"
   capcutctl oracle diff --before "$O/a-before" --after "$O/b-rect-default" --values \
     > ~/Desktop/oracle-mask-created.json
   for L in c-feather-0 c-feather-25 c-feather-50 c-feather-100 d-corner-0 d-corner-max; do
     capcutctl oracle diff --before "$O/b-rect-default" --after "$O/$L" --values \
       > ~/Desktop/oracle-mask-$L.json
   done
   head -200 ~/Desktop/oracle-mask-*.json
   ```
   Show all of these files.

7. While the mask is applied, also report: **is there an "invert" toggle** on the rectangle
   mask, and does the UI offer width / height / position controls for it? Do not change
   them — just say what exists.

### Report back for Experiment 2

- All the diff JSON files, verbatim.
- A table pairing **the value you set in the UI** with **the value that appeared in the
  file**, for feather and for corner radius. This pairing is the entire point: a file value
  with no UI value beside it is useless.
- Whether the mask's `resource_type` (or equivalent type field) says `rectangle` or
  something else.
- Whether an invert control exists.

---

## Finishing up

Leave both projects in place — do not delete them. The capture folders inside them are the
raw evidence, and they will be re-read.

Report all JSON in full. Do not summarise the numbers, do not round them, and do not
reformat them. If any step failed or behaved unexpectedly, say exactly where and what you
saw rather than working around it.
