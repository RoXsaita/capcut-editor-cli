# Public-release checklist

Things that must remain true for this public GitHub repository. Deleting a file
in a new commit does not remove it from Git history.

## Secrets

- [x] `.env` is gitignored and was never committed (local key is fine)
- [ ] Confirm `.env` is still untracked: `git log --all -- .env` is empty
- [ ] Confirm no live key string in any commit:
      `git grep -a 'GEMINI_API_KEY=' $(git rev-list --all)`

## History rewrite

`presets/harvest.json` was stripped from all commits with `git filter-repo`
(`--path presets/harvest.json --invert-paths`) and force-pushed. Confirm:

```bash
git log --all -- presets/harvest.json   # must be empty
```

The repository is public. Older commits may still contain `/Users/<name>/…` in
files that were later rewritten to `~/…`; that is machine-local, not a credential.

## Working tree (not in git, still do not zip)

These sit in the parent folder `capcut-cli/` and are **not** part of this repo.
Never `git init` the parent. Never upload the umbrella as a zip.

- `outputs/` — talking-head video, transcripts, Instagram/Chrome stills
- `qa/` — face contact sheets
- `find-strip.png`
- `_archive/`
- `HANDOFF.md`
- `cli/presets/harvest.json` (gitignored, still on disk)

## After going public

- [ ] Branch protection on `main`: require `Node 20`, `Node 24`, `Python and shell quality`
- [ ] `gh label create ai-review-approved` (see `.github/AUTOMATION.md`)
- [ ] Enable private vulnerability reporting
- [ ] Decide npm / Homebrew later — there is no publish workflow on purpose
