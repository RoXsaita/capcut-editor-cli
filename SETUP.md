# Setting up the CapCut toolkit on a new Mac

Two repositories make the toolkit. Start here; each repo's own README goes deeper.

| Repo | Gives you |
|---|---|
| `capcut-editor-cli` (this one) | `capcutctl` — reads and writes CapCut's `draft_info.json` transactionally |
| `capcut-skills` | the four agent skills that teach an agent how to use `capcutctl` |

Requirements: **macOS**, **Node.js 20+**, **Python 3.11+**, **ffmpeg**
(`brew install ffmpeg`), **Xcode command line tools** (for Swift), and **CapCut**
installed and launched at least once.

After installing, `capcutctl preflight` checks every one of those and tells you what
is missing — run it before anything else. It reports the exact Python interpreter
`cut`, `qa` and `find` will use, so a green preflight and a `ModuleNotFoundError`
cannot happen in the same session.

---

## 1. Clone both

Both repositories are public, so no authentication is needed to clone them. (You will
need a GitHub account to open issues or pull requests.)

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/RoXsaita/capcut-editor-cli.git
git clone https://github.com/RoXsaita/capcut-skills.git
```

(Swap in `git@github.com:RoXsaita/….git` if you use SSH.)

The directory names matter only to the skill symlinks below — put them wherever you
like, as long as you use the same paths consistently. The rest of this file uses
`~/src/capcut-editor-cli` as the CLI path.

## 2. `capcutctl`

No npm runtime dependencies. Node 20+, Python 3.11+ and ffmpeg are the requirements.

```bash
brew install ffmpeg           # cut, qa, find, preview, music and review need it
brew install python@3.11      # or newer; 3.11 is the floor
cd ~/src/capcut-editor-cli
npm link                      # puts capcutctl on your PATH
python3 -m pip install -e .   # NumPy and Pillow, which qa/preview/review need
capcutctl preflight           # deps, Python runtime, artwork, SFX palette, drafts folder
```

### The Python runtime

`cut`, `qa`, `find`, `preview` and `review` are thin Node front ends over the scripts
in `tools/`. Those scripts are **not** stdlib-only and **not** version-agnostic —
`tools/aroll.py` uses `itertools.pairwise` (3.10+) and `tools/frame_qa.py` imports
NumPy and Pillow — so `capcutctl` does not spawn whatever `python3` happens to be
first on your PATH. Stock macOS still ships 3.9.6, which cannot run them.

`pyproject.toml` is the contract: `requires-python = ">=3.11"`, with NumPy and Pillow
as declared dependencies. The interpreter is chosen in this order, most explicit first:

| | |
|---|---|
| `$CAPCUTCTL_PYTHON` | You said so. If it is unusable that is an error — never a quiet fallback to something else. |
| `<repo>/.venv` | A project-managed environment, if you made one. |
| `$VIRTUAL_ENV` | An environment you have already activated. |
| `python3.14` … `python3.11` on PATH | A named interpreter that is new enough. |
| `python3`, `python` on PATH | Ambient, and only if it clears 3.11. |

Among the last two (the guesses, not the choices) an interpreter that can already
import NumPy and Pillow wins over a newer one that cannot — otherwise
`pip install -e .` under the `python3` you actually use would lose to a bare
`python3.13` that merely sorts first.

If you would rather keep the dependencies out of your system Python:

```bash
python3.11 -m venv .venv && .venv/bin/python -m pip install -e .
capcutctl preflight            # now reports ".venv" as the source
```

A missing or too-old Python is a named error (`PYTHON_NOT_FOUND`, `PYTHON_TOO_OLD`,
`PYTHON_MISSING_DEPENDENCY`) carrying the install command — not an import traceback.

Transcription for `cut` is deliberately **not** installed by default, because both
options pull large wheels and download model weights on first use:

```bash
uv tool install mlx-whisper          # the fast path on Apple silicon, and the default --model
python3 -m pip install -e '.[whisper]'   # the portable fallback, for plain --model names
```

`preflight` exits 1 if the install cannot work, and names the fix for each problem.
The overlay artwork the built-in layouts need is bundled in `assets/`, so
`layout split-screen` / `circle` / `screen` work immediately. The SFX palette is the
one thing that cannot be shipped — see the README section *What ships with the tool,
and what is yours*.

If you would rather not use `npm link` (it writes to your global npm prefix):

```bash
mkdir -p ~/.local/lib/node_modules ~/.local/bin
ln -s ~/src/capcut-editor-cli ~/.local/lib/node_modules/capcut-editor-cli
ln -s ../lib/node_modules/capcut-editor-cli/bin/capcutctl.mjs ~/.local/bin/capcutctl
# ensure ~/.local/bin is on your PATH
```

Verify:

```bash
capcutctl projects        # lists your CapCut drafts
capcutctl layout list     # the four locked layouts
npm test                  # no network, no CapCut required
```

`npm test` needs ffmpeg on PATH: the `cut.recut` suite builds genuine media to
validate against, and skips itself with a stated reason when ffmpeg is absent. No
test downloads a transcription model.

`capcutctl` never writes while CapCut is running, always snapshots before a write,
and validates the whole document before committing. See **Safety model** in the README.

## 3. The agent skills

Symlink the four skill directories into whichever agent directories you use:

```bash
for AGENT in ~/.claude ~/.codex ~/.grok ~/.hermes; do
  [ -d "$AGENT" ] || continue
  mkdir -p "$AGENT/skills"
  for S in capcut-cli capcut-editing capcut-editing-talking-head capcut-editing-screen-recording; do
    ln -sfn ~/src/capcut-skills/$S "$AGENT/skills/$S"
  done
done
```

Read `capcut-editing/SKILL.md` first — it is the hub and links to the other three.

**Agents: before the first write, ask which style to use** (bundled house style,
harvest their CapCut library, or start blank). See README → *Style — ask once*.

## 4. What will not work on your machine

Nothing in these repos hardcodes another person's home directory: every preset path
is written `~/…` and expanded at load. But some of those paths point at things that
are local *by nature*.

* **CapCut effect and music cache ids.** `presets/layouts.json`, `sfx.json` and
  `signature.json` reference
  `~/Library/Containers/com.lemon.lvoverseas/…/Cache/effect/<id>/<hash>`. CapCut
  writes those directories when *you* download an effect or a track, so they will not
  exist until you do. Download the same effects in CapCut, then re-capture the ids:

  ```bash
  capcutctl harvest        # walks your drafts root and writes presets/harvest.json
  ```

  `presets/harvest.json` is deliberately not in the repo — it names every project on
  the machine that produced it. Nothing in the shipped code reads it; it is a
  reference capture for you.

  `polish` does not need this to succeed: a sound that is not on your machine is
  **skipped and named** in the command's output, so you get the edit without the
  palette rather than a failed transaction. `capcutctl preflight` reports the ratio.

  To use your own sounds instead of downloading his, put an `sfx.json` in a directory
  and point at it — each preset falls back to the bundled one when absent:

  ```bash
  export CAPCUTCTL_PRESET_DIR=~/my-presets
  ```

* **Logo and media folders.** `presets/brands.json` points at `~/Downloads/Logos` and
  `~/Downloads/Media/Images/2026`. Those are third-party marks and are not
  redistributable. `capcutctl brands` lists which have a usable PNG and which do not;
  only `logo` / `wrap` need them. Repoint `svgFallbackDir`, `rasterCacheDir` and each
  brand's `logo` at your own files, or override the whole preset with
  `CAPCUTCTL_PRESET_DIR`.

* **Overlay artwork is bundled, not local.** The indigo bar and white ring the
  layouts need ship in `assets/`, so `layout split-screen` / `circle` / `screen`
  work on a fresh clone. `CAPCUTCTL_ASSET_DIR` overrides them with your own.

* **The legacy scripts.** `skills/capcut-editing/scripts/{build,full,match,render}.py`
  predate `capcutctl` and are kept as reference. Their media constants are now read
  from the environment:

  ```bash
  CAPCUT_CAM=/path/to/face.mp4 CAPCUT_BROLL=/path/to/screen.mp4 python3 render.py
  ```

Every one of these is visible before you hit it: `capcutctl preflight` reports the
whole environment up front, `capcutctl doctor` reports a missing media path as an
**error**, and a transaction that would write one is aborted before anything reaches
disk. Nothing here fails as a stack trace.
