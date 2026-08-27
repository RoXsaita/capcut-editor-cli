# Setting up the CapCut toolkit on a new Mac

Three repositories make one toolkit. Start here; each repo's own README goes deeper.

| Repo | Gives you |
|---|---|
| `capcut-editor-cli` (this one) | `capcutctl` — reads and writes CapCut's `draft_info.json` transactionally |
| `capcut-skills` | the four agent skills that teach an agent how to use `capcutctl` |
| `recording-layout-v2` | `rl2` — the instrumented screen recorder that produces the B-roll |

Requirements: **macOS**, **Node.js 20+**, **Xcode command line tools** (for Swift),
and **CapCut** installed and launched at least once.

---

## 1. Clone all three

These are private repos, so authenticate first — `gh auth login`, or an SSH key on
your GitHub account.

```bash
mkdir -p ~/Documents/Devving/capcut-cli && cd ~/Documents/Devving/capcut-cli
git clone https://github.com/RoXsaita/capcut-editor-cli.git cli
git clone https://github.com/RoXsaita/capcut-skills.git    skills
cd ~/Documents/Devving
git clone https://github.com/RoXsaita/recording-layout-v2.git rl2
```

(Swap in `git@github.com:RoXsaita/….git` if you use SSH.)

The directory names matter only to the symlinks below — put them wherever you like,
as long as you use the same paths consistently.

## 2. `capcutctl`

No runtime dependencies; Node 20+ is the only requirement.

```bash
cd ~/Documents/Devving/capcut-cli/cli
npm link                      # puts capcutctl on your PATH
capcutctl help
```

If you would rather not use `npm link` (it writes to your global npm prefix):

```bash
mkdir -p ~/.local/lib/node_modules ~/.local/bin
ln -s ~/Documents/Devving/capcut-cli/cli ~/.local/lib/node_modules/capcut-editor-cli
ln -s ../lib/node_modules/capcut-editor-cli/bin/capcutctl.mjs ~/.local/bin/capcutctl
# ensure ~/.local/bin is on your PATH
```

Verify:

```bash
capcutctl projects        # lists your CapCut drafts
capcutctl layout list     # the four locked layouts
npm test                  # 118 tests, no network, no CapCut required
```

`capcutctl` never writes while CapCut is running, always snapshots before a write,
and validates the whole document before committing. See **Safety model** in the README.

## 3. `rl2`

```bash
cd ~/Documents/Devving/rl2
swift build -c release                 # ~1 minute, no dependencies to fetch
mkdir -p ~/.local/bin
ln -s "$PWD/.build/release/rl2" ~/.local/bin/rl2
./make-app.sh                          # builds ~/Applications/Recording Layout v2.app
```

Then grant permissions in **System Settings → Privacy & Security**:

| Permission | Grant to |
|---|---|
| Screen Recording | `Recording Layout v2.app`, and the terminal you run `rl2` from |
| Accessibility | same |
| Input Monitoring | same |

```bash
rl2 doctor        # names exactly which of the three is missing
rl2 selftest      # proves the privacy guard blocks keystroke identity
```

**Do not change `BUNDLE_ID` in `make-app.sh`.** macOS attaches every TCC grant to the
ad-hoc code signature identified by `com.suheil.recording-layout-v2`; changing it
silently voids Screen Recording while System Settings still shows it as enabled.
Rebuilding the app has the same effect — the app detects it and offers `Fix…`.

### What rl2 records

It is a screen recorder *and* an input monitor, so it is worth knowing exactly what
lands on disk before you run it. Full detail in `rl2/README.md` → **Privacy**:

* **Keystroke identity is never recorded.** The event tap never reads
  `.keyboardEventKeycode`, and `InputSample` has no field that could carry one.
  Typing becomes `{start, end, count}` bursts.
* **No clipboard or pasteboard access anywhere in the source.**
* **No network egress** — no `URLSession`, no sockets. Everything stays in `--out`.
* **Element text** is the `title` of a clicked interactive control only; `AXValue`
  is never read.
* **Window titles**: in `--whole-screen` (the usual take) none are polled. In
  single-window mode the captured window's own title *is* recorded — that includes
  Chrome tab titles. Every take writes a `session.json` stating this.
* Every record passes `PrivacyGuard` on its way to disk; a banned field name drops
  the record and writes a loud `privacy_violation` marker instead.
* The pixels are still pixels: in whole-screen mode anything on screen — including
  notifications — is in the video.

## 4. The agent skills

Symlink the four skill directories into whichever agent directories you use:

```bash
for AGENT in ~/.claude ~/.codex ~/.grok ~/.hermes; do
  [ -d "$AGENT" ] || continue
  mkdir -p "$AGENT/skills"
  for S in capcut-cli capcut-editing capcut-editing-talking-head capcut-editing-screen-recording; do
    ln -sfn ~/Documents/Devving/capcut-cli/skills/$S "$AGENT/skills/$S"
  done
done
```

Read `capcut-editing/SKILL.md` first — it is the hub and links to the other three.

## 5. What will not work on your machine

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
