# capcutctl

[![CI](https://github.com/RoXsaita/capcut-editor-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/RoXsaita/capcut-editor-cli/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/RoXsaita/capcut-editor-cli)](https://github.com/RoXsaita/capcut-editor-cli/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A transactional command-line editor for local CapCut projects on macOS.**

`capcutctl` edits CapCut's native project files while keeping the result editable in
CapCut. Clips remain clips, layouts remain transforms and masks, and audio changes remain
native timeline edits. It does not flatten the project into a rendered video.

The project is unofficial and is not affiliated with, endorsed by, or sponsored by
ByteDance, CapCut, or Lemon Inc.

## Why capcutctl?

CapCut projects contain multiple live documents, mirrored files, linked materials, and
machine-local resources. A quick JSON edit can appear to work while leaving the project
partly inconsistent or impossible to reopen.

`capcutctl` provides a safer interface for both humans and coding agents:

- transactional edits with snapshots and automatic rollback;
- validation across the root draft and active timeline;
- atomic synchronization of CapCut's JSON, backup, and temporary mirrors;
- deterministic, editable layouts for talking-head and screen-recording videos;
- A-roll analysis and reviewed recutting with acoustic boundary checks;
- native-resolution frame QA and lightweight preview rendering;
- a machine-readable CLI contract for agent tooling.

## Status

The current release is **v0.1.1**. It is an early public release used on real CapCut
projects, with 300+ automated tests around transactions, rollback, media provenance,
layouts, A-roll, and clean installation.

CapCut's draft format is undocumented and may change. Use a copy of an important project
until you trust the workflow on your version of CapCut. The transaction system reduces
risk; it cannot make an unofficial file format stable.

## Requirements

- macOS with CapCut Desktop installed and launched at least once;
- Node.js 20 or newer;
- Python 3.11 or newer;
- ffmpeg and ffprobe.

Install the system dependencies with Homebrew:

```bash
brew install node python@3.11 ffmpeg
```

## Quick start

```bash
git clone https://github.com/RoXsaita/capcut-editor-cli.git
cd capcut-editor-cli

npm link
python3.11 -m venv .venv
.venv/bin/python -m pip install -e .

capcutctl preflight
capcutctl projects
```

`preflight` checks the resolved Python interpreter, dependencies, ffmpeg, OCR support,
bundled artwork, local SFX resources, the CapCut drafts folder, permissions, and disk
space. It exits with a concrete fix when a required dependency is missing.

For a more detailed first-time setup, including the companion agent skills, see
[SETUP.md](SETUP.md).

## A first safe edit

List the scenes and inspect the project before changing it:

```bash
capcutctl scenes --project "My Edit"
capcutctl doctor --project "My Edit"
capcutctl snapshot --project "My Edit" --label before-layout
```

Preview a transactional edit without writing anything:

```bash
capcutctl layout split-screen \
  --project "My Edit" --at 12.5 --track 2 --dry-run
```

Close CapCut, then run the same command without `--dry-run`:

```bash
capcutctl close
capcutctl layout split-screen \
  --project "My Edit" --at 12.5 --track 2
```

Every committed transaction snapshots the project, validates the result, synchronizes
the mirrors, and rolls back if the post-write doctor fails.

## Common workflows

| Goal | Command |
|---|---|
| Check whether this Mac is ready | `capcutctl preflight` |
| List local CapCut projects | `capcutctl projects` |
| Inspect structure and timeline | `capcutctl inspect --project NAME` |
| Validate a project | `capcutctl doctor --project NAME` |
| Create an empty project | `capcutctl new --project NAME --blank --dry-run` |
| Analyze talking-head footage | `capcutctl cut VIDEO --lang en` |
| Apply a reviewed A-roll cut | `capcutctl cut VIDEO --review decisions.json --project NAME --dry-run` |
| Add full-frame source media | `capcutctl add --project NAME --media FILE --at 5 --dur 3 --track broll --dry-run` |
| Apply a native layout | `capcutctl layout split-screen --project NAME --at 5 --track 2 --dry-run` |
| Audit layout choices | `capcutctl layout audit --project NAME` |
| Check exact frames | `capcutctl qa --project NAME --at-cuts --sheet --out qa/` |
| Render a lightweight proxy | `capcutctl preview --project NAME --out preview.mp4` |
| Measure or apply colour matching | `capcutctl grade --project NAME --measure` |
| View or restore snapshots | `capcutctl history --project NAME` |
| Show the full command surface | `capcutctl help` |

The checked-in [CLI contract](docs/cli-contract.json) is generated from
`capcutctl contract`. The companion
[`capcut-skills`](https://github.com/RoXsaita/capcut-skills) repository validates its
agent instructions against that contract.

## Editing model

CapCut keeps a root draft and an active timeline as separate authoritative documents.
`capcutctl` resolves both and applies the same semantic operation independently rather
than copying one over the other.

For each committed transaction it:

1. refuses to write while CapCut is running unless explicitly overridden;
2. loads the root draft and active timeline;
3. applies the requested operation to both documents;
4. validates media, IDs, references, timing, transforms, masks, and overlaps;
5. creates a snapshot under the project's `.capcutctl/history/` directory;
6. stages and parses every changed file before atomically replacing it;
7. synchronizes `draft_info.json`, `draft_info.json.bak`, and `template-2.tmp`;
8. restores the snapshot if the post-write validation fails.

Transactional edit commands share the same `--dry-run` guarantee: resolve and validate
the edit, report what would change, and write nothing. The exact list is available at:

```bash
capcutctl contract | jq -r '.dryRun.commands[]'
```

## Editable-media contract

The tool rejects two common ways of accidentally making a project less editable:

- media that was cropped into its final layout before import;
- media imported from a temporary or agent scratch directory.

Use full-frame source recordings and express crops, placement, and zoom as native CapCut
properties. If preprocessing is deliberate, record the durable source with
`--derived-from`; use `--generated` for assets that genuinely have no editable original.

```bash
capcutctl add --project NAME --media graphic.mp4 --at 5 --dur 2 --track broll \
  --generated --dry-run

capcutctl add --project NAME --media cropped.mp4 --at 5 --dur 2 --track broll \
  --derived-from ~/Movies/source.mp4 --dry-run
```

## A-roll and visual QA

`cut` separates editorial selection from timing mechanics. The analysis pass transcribes
the source, indexes speech and acoustic boundaries, and writes a reviewable handoff. A
reviewed pass can then keep, reorder, trim, or safely recover selected beats.

```bash
capcutctl cut "Face Takes.mp4" --lang en
capcutctl cut "Face Takes.mp4" \
  --keep 0,2-6 --order 0,2,3,4,5,6 \
  --project "A-roll Review" --dry-run
```

`doctor`, `qa`, and `preview` answer different questions:

- `doctor` checks project structure;
- `qa` renders bounded native-resolution frame evidence;
- `preview` produces a watchable, lower-resolution proxy.

They are intentionally separate so a quick preview is not mistaken for pixel-level QA.

## Presets and machine-local resources

The built-in layout artwork ships in `assets/`. CapCut effect and sound IDs do not: CapCut
creates them when a user downloads those resources on a particular Mac. Missing SFX are
reported and skipped instead of creating an invalid project.

Third-party logos are not included. `capcutctl brands` reports which configured brands
have a usable local image.

Use your own preset or asset directories without changing the repository:

```bash
export CAPCUTCTL_PRESET_DIR=~/my-capcut-presets
export CAPCUTCTL_ASSET_DIR=~/my-capcut-assets
```

On first use, an agent should ask whether to use the bundled example style, harvest the
user's existing edits, or start from a blank project. It should not silently apply another
editor's branding or style.

## Optional transcription

Transcription is deliberately not installed by default because the packages and model
weights are large.

Apple silicon fast path:

```bash
uv tool install mlx-whisper
```

Portable fallback:

```bash
.venv/bin/python -m pip install -e '.[whisper]'
```

## Development

```bash
./scripts/check.sh --strict
```

That runs JavaScript syntax checks, the Node test suite, Python self-tests and compilation,
Ruff, Vulture, ShellCheck, and the macOS Vision OCR build. Tests use temporary synthetic
projects and do not edit the user's CapCut library.

CI runs on Node.js 20 and 24 with Python 3.11. The advisory AI reviewer is documented in
[`.github/AUTOMATION.md`](.github/AUTOMATION.md).

## Contributing

Forks and focused pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md), keep each PR to one job, and include the smallest test
that proves a non-trivial change.

Useful references:

- [new-machine setup](SETUP.md)
- [machine-readable CLI contract](docs/cli-contract.json)
- [release process](docs/PRE-PUBLISH.md)
- [agent skills](https://github.com/RoXsaita/capcut-skills)
- [issue tracker](https://github.com/RoXsaita/capcut-editor-cli/issues)

## License and disclaimer

MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This project reads and writes local CapCut project files. CapCut, its effects, fonts,
sounds, and project format belong to their respective owners. Use of this software with
CapCut remains subject to CapCut's terms and to the laws that apply to you.
