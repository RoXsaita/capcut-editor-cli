# Setting up the CapCut toolkit on a new Mac

Two repositories make the toolkit. Start here; each repo's own README goes deeper.

| Repo | Gives you |
|---|---|
| `capcut-editor-cli` (this one) | `capcutctl` — reads and writes CapCut's `draft_info.json` transactionally |
| `capcut-skills` | the four agent skills that teach an agent how to use `capcutctl` |

Requirements: **macOS**, **Node.js 20+**, **Xcode command line tools** (for Swift),
and **CapCut** installed and launched at least once.

---

## 1. Clone both

These repositories are private. Authenticate first (`gh auth login`, or an SSH key).

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

No runtime dependencies; Node 20+ is the only requirement.

```bash
cd ~/src/capcut-editor-cli
npm link                      # puts capcutctl on your PATH
capcutctl help
```

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

* **Logo and media folders.** `presets/brands.json` points at `~/Downloads/Logos` and
  `~/Downloads/Media/Images/2026`; `presets/sfx.json` points at one personal
  `~/Downloads/fahhh.mp3`. Repoint `svgFallbackDir`, `rasterCacheDir` and each brand's
  `logo` at your own files.

* **The legacy scripts.** `skills/capcut-editing/scripts/{build,full,match,render}.py`
  predate `capcutctl` and are kept as reference. Their media constants are now read
  from the environment:

  ```bash
  CAPCUT_CAM=/path/to/face.mp4 CAPCUT_BROLL=/path/to/screen.mp4 python3 render.py
  ```

Every one of these fails loudly rather than quietly: `capcutctl doctor` reports a
missing media path as an **error**, and a transaction that would write one is aborted
before anything reaches disk.
