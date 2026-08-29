# Pre-publish checklist

Things that must be true **before** this GitHub repository is flipped from
private to public. Do not skip the history step: deleting a file in a new
commit does not remove it from GitHub.

## Secrets

- [x] `.env` is gitignored and was never committed (local key is fine)
- [ ] Confirm `.env` is still untracked: `git log --all -- .env` is empty
- [ ] Confirm no live key string in any commit:
      `git grep -a 'GEMINI_API_KEY=' $(git rev-list --all)`

## History rewrite (blocking)

`presets/harvest.json` was committed, then gitignored. The blob is still on
`origin/main` and names every local draft (unpublished video titles). Older
commits also contain `/Users/roxsa/…` absolute paths.

Either:

```bash
# from a clean clone, after installing git-filter-repo
git filter-repo --path presets/harvest.json --invert-paths
# inspect, then force-push ALL branches and tags, then rotate nothing else
# that was only in that file (titles, not credentials)
```

or publish a **new empty repository** with a squashed current tree.

Until one of those is done, **do not** make `RoXsaita/capcut-editor-cli` public.

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
