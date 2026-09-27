# Presets

JSON the CLI clones from instead of inventing CapCut objects.

**Your brand does not live here.** Every file in this folder is looked up first in your user
dir — `$CAPCUTCTL_PRESET_DIR`, else `$XDG_CONFIG_HOME/capcutctl`, else `~/.config/capcutctl` —
and falls back to the copy here. `profile.json` is the exception that *merges* instead of
replacing: yours only has to hold what you change. Start it with `capcutctl profile init`;
see the layers with `capcutctl profile where`. Keep that folder in your own dotfiles if you
want it versioned; it never goes in this repo.

| File | Role |
|---|---|
| `profile.json` | **the shipped, brand-neutral style profile** — tokens, brand rules, styles per video type, camera, seams, sound, density targets, motion grammar. Your own profile merges over it |
| `profile.template.json` | what `capcutctl profile init` copies to your user dir as your own `profile.json` |
| `motion.json` | harvested native structures for the experimental `motion` recipes |
| `layouts.json` | split-screen / circle / full-face / background / screenRecording geometry + native mask templates |
| `sfx.json` | transition ↔ sound pairing for `polish` |
| `signature.json` | logo pop, endcard, talking-head push-in |
| `brands.json` | spoken aliases → path to a **local** transparent raster |
| `adjust.json` | CapCut's Adjust-panel effect template that `grade` fills in (harvested, not invented) |
| `adjust-layer.json` | harvested Custom adjustment lane that `grade --layer` clones |
| `volume-keyframes.json` | harvested `KFTypeVolume` block + its units/time base, for `music --duck` |
| `blank-draft.json` | the empty 1080×1920 draft `new --blank` starts from |
| `suheil-vertical.json` | measured card-layout geometry (documentation; its editing rules now live in `profile.json`) |

Paths are written `~/…` and expanded at load. CapCut still needs a real
absolute path inside `draft_info.json`.

**Machine-local (will not work on a fresh Mac until you download the effects
in CapCut and point the logo files at your own copies):**

- `~/Library/Containers/com.lemon.lvoverseas/…/Cache/effect|music/…`
- `brands.json` logo paths
- `sfx.json` → `fahhh.mp3` (optional personal sting)

`harvest.json` is **not shipped**. It is a catalogue of whatever drafts live
on the machine that ran `capcutctl harvest`. Gitignored. Do not add it.

Do not vendor a full CapCut project (no `Preset 3` dump). `capcutctl new`
duplicates a draft you already have (`--from`, default name `Preset 3`) or
builds `--blank`.
