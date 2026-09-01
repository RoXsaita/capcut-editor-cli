# Publication and release

This repository **is public**. It was flipped from private after the checks below
passed, so most of this file is now a record of what was verified and a checklist for
the next release rather than a gate in front of one.

Distribution is source-first through GitHub Releases. npm and Homebrew publishing remain
out of scope; `"private": true` stays in `package.json` as the registry guard.

## What was verified before going public

- [x] `.env` is gitignored and was never committed — `git log --all -- .env` is empty.
- [x] No live key string in any commit. `.env.example` carries the bare key *names*
      with no values, which is the point of the file.
- [x] `presets/harvest.json` was stripped from all commits with `git filter-repo`
      (`--path presets/harvest.json --invert-paths`) and force-pushed;
      `git log --all -- presets/harvest.json` is empty.

Re-run all three before any release:

```bash
git log --all -- .env                      # must be empty
git log --all -- presets/harvest.json      # must be empty
git grep -aI 'GEMINI_API_KEY=.\+'          # must match nothing but this file
```

The repository is public. Older commits may still contain `/Users/<name>/…` in
files that were later rewritten to `~/…`; that is machine-local, not a credential.
Nothing in the current tree ships an absolute user path —
`test/clean-install.test.mjs` scans the packed tarball and fails if one appears.

## Working tree (not in git, still do not zip)

These sit in the parent folder `capcut-cli/` and are **not** part of this repo.
Never `git init` the parent. Never upload the umbrella as a zip.

- `outputs/` — talking-head video, transcripts, Instagram/Chrome stills
- `qa/` — face contact sheets
- `find-strip.png`
- `_archive/`
- `HANDOFF.md`
- `cli/presets/harvest.json` (gitignored, still on disk)

## Repository settings

- [ ] Branch protection on `main`: require `Node 20`, `Node 24`, `Python and shell quality`
- [ ] `gh label create ai-review-approved` (see `.github/AUTOMATION.md`)
- [ ] Enable private vulnerability reporting
- [x] Description and topics set (see below)

Suggested description:

> Transactional, agent-driven CapCut editor that turns raw talking-head and screen
> recordings into fully editable native CapCut projects.

Suggested topics: `capcut`, `video-editing`, `automation`, `cli`, `ai-agents`,
`agentic-workflows`, `macos`, `ffmpeg`.

## `"private": true` in package.json — deliberate

`package.json` carries `"private": true` while the *repository* is public. That is not
stale metadata; the two words mean unrelated things.

npm refuses to `npm publish` a package marked private. Since no npm release has been
decided, that flag is the guard that makes an accidental publish impossible rather than
merely unlikely. It does **not** block anything this project actually uses: `npm link`,
`npm install <path>`, `npm pack` and installing straight from the git URL all work.

Remove it in the same commit that adds a publish workflow, never before, and never as
a drive-by cleanup because it "looks wrong" next to a public repository.

## Versioning

One number, in three files, checked by `test/release-truth.test.mjs`:

| File | Field |
|---|---|
| `package.json` | `version` |
| `pyproject.toml` | `[project] version` |
| `README.md` | the version the prose refers to |

The test fails if they disagree, so a release is a single coordinated edit rather than
three chances to forget one.

## Releasing

There is no publish workflow, on purpose. A release is:

1. `scripts/check.sh --strict` — every gate, no skips.
2. `npm pack --dry-run --json` — read the file list; it must contain no catalogue,
   media, transcript, `.env`, or absolute user path. `test/clean-install.test.mjs`
   asserts this, but read it anyway.
3. Bump the version in the three files above; `npm test` will confirm they agree.
4. Tag: `git tag -a v0.1.1 -m 'v0.1.1' && git push origin v0.1.1`.
5. Create a GitHub Release from that tag. GitHub provides the source ZIP and tarball;
   do not attach an npm package unless npm distribution is separately approved.
6. Stop. Do not publish to npm or Homebrew without a new explicit decision and the
   corresponding install and maintenance plan.
