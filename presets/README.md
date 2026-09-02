# Presets

JSON the CLI clones from instead of inventing CapCut objects.

| File | Role |
|---|---|
| `layouts.json` | split-screen / circle / full-face / background / screenRecording geometry + native mask templates |
| `sfx.json` | transition ↔ sound pairing for `polish` |
| `signature.json` | logo pop, endcard, talking-head push-in |
| `brands.json` | spoken aliases → path to a **local** transparent raster |
| `adjust.json` | CapCut's Adjust-panel effect template that `grade` fills in (harvested, not invented) |
| `blank-draft.json` | the empty 1080×1920 draft `new --blank` starts from |
| `suheil-vertical.json` | 1080×1920 house-style contract (documentation; not a renderer) |

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
