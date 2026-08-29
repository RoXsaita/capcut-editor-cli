# Contributing

Thanks for wanting to work on `capcutctl`. This is a local, macOS + CapCut tool.
Most of the interesting bugs are "CapCut opened the project and silently dropped
the thing we wrote." Tests catch the structural ones; pixels still need a Mac.

## Ground rules

- One job per pull request.
- Never force-push `main` (maintainers: history rewrite is the exception, and already done).
- Do not commit `.env`, `presets/harvest.json`, compiled `tools/vision/ocr`,
  videos, QA frames, or anyone's CapCut drafts.
- Do not invent CapCut effect / mask / keyframe JSON. Harvest a real structure
  (`capcutctl harvest`) and clone it.
- A CLI change and the matching note in [capcut-skills](https://github.com/RoXsaita/capcut-skills)
  should land as a pair.

## Setup

```bash
git clone https://github.com/RoXsaita/capcut-editor-cli.git
cd capcut-editor-cli
npm test
npm run check
```

Node 20+. No runtime npm dependencies. Tests build synthetic drafts in a temp
dir and **do not** touch your CapCut library.

Optional, macOS only:

```bash
swiftc -O -o tools/vision/ocr tools/vision/ocr.swift   # qa --ocr
python3 tools/aroll.py --selftest
./scripts/check.sh
```

`cut` needs `mlx_whisper` and ffmpeg on Apple Silicon. `finish --music` needs
`GEMINI_API_KEY` in `.env` (see `.env.example`). Neither runs in CI.

## What CI runs

Every PR, on Ubuntu, Node 20 and 24:

- `npm run check` and `npm test`
- `python3 tools/aroll.py --selftest`
- Ruff, Vulture, ShellCheck

That is the merge gate. The Codex review on PRs is advisory. See
[`.github/AUTOMATION.md`](.github/AUTOMATION.md).

## Changing presets

`presets/*.json` ship with `~/…` paths, never `/Users/<name>/…`. `loadPreset`
expands the tilde. CapCut effect/music cache IDs are machine-local; a new Mac
must download the same effects and re-harvest. If you add a path, keep the `~/`
form and a test that does not require the file to exist on the runner.

`presets/harvest.json` is a dump of *your* drafts root. It is gitignored on
purpose. Never add it back.

## Style of change

Prefer a small, named command (`layout`, `add`, `polish`) over a new spec op
that only you will write. Every write goes through `applySpec`: snapshot, both
documents, mirrors, doctor, rollback. If your change bypasses that, it is a bug.

## License

By contributing you agree that your work is licensed under the MIT License
in `LICENSE`, and that you have the right to submit it.
