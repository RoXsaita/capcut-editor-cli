# Repository automation

This repository uses two independent review lanes.

## Deterministic CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

- the Node.js suite and syntax checks on the minimum supported Node 20 and current Node 24;
- Python compilation and the A-roll self-tests on Python 3.11;
- Ruff, Vulture, and ShellCheck.

These checks are the merge gate. They are repeatable and should be required in the `main` branch
ruleset once branch rules are available for the repository.

## Codex pull request review

`.github/workflows/ai-review.yml` runs when a pull request is opened, reopened, marked ready, or
receives a new commit. Trusted contributors are reviewed automatically. After this repository is
public, an external contributor's first review requires a maintainer to add the
`ai-review-approved` label; subsequent commits retain the label and are reviewed automatically.
This prevents an anonymous PR-spam loop from spending the API budget. The workflow uses
`gpt-5.6-luna` at `max` effort and the defect-first contract in
`.github/codex/prompts/review.md`.

The workflow:

1. runs from the trusted default-branch workflow through `pull_request_target`;
2. checks out only the trusted base commit;
3. downloads the exact diff and changed text files through the GitHub API as inert review data;
4. runs Codex with a read-only permission profile, no network access, and dropped sudo privileges;
5. updates one durable PR summary and adds deduplicated inline comments for valid changed lines;
6. cancels stale runs and refuses to publish a result for an outdated head commit.

The AI review is advisory. A model finding should be fixed or explicitly resolved by a human, but
the model itself is not a deterministic merge veto.

The reviewer is deliberately repository-agnostic. The prompt contains only the general
defect-first contract; it learns project-specific behavior from the trusted base branch's
`AGENTS.md`, tests, documentation, call sites, and implementation. The workflow, schema, and two
scripts can therefore be copied to another repository without teaching it the bugs found here.
Only the deterministic CI commands and optional repository guidance should change per project.

### One-time setup

Create a repository Actions secret named `OPENAI_API_KEY`:

```bash
gh secret set OPENAI_API_KEY --repo RoXsaita/capcut-editor-cli
```

Paste a project-scoped OpenAI API key with a sensible monthly spend limit. The key is passed only
to the official `openai/codex-action`; the reviewer receives a local proxy credential instead of
the upstream key.

Create the approval label before accepting outside pull requests:

```bash
gh label create ai-review-approved \
  --repo RoXsaita/capcut-editor-cli \
  --color 1F6FEB \
  --description "Allow the controlled Codex reviewer to run on this external PR"
```

After the repository is public (or branch rules are otherwise available), protect `main` and
require these checks:

- `Node 20`
- `Node 24`
- `Python and shell quality`

Also require pull requests, require conversation resolution, dismiss stale approvals on new
commits, and require review from Code Owners for changes under `.github/`.

## Releases

Licensed MIT (`LICENSE`) with a CapCut disclaimer in `NOTICE`. The package remains
`"private": true` in `package.json` until a distribution channel is chosen.

There is intentionally no deployment workflow yet. Add release automation only after
deciding whether releases target npm, Homebrew, standalone GitHub archives, or some
combination; otherwise "CD" would be an unaudited publish button with no defined
destination.

Before making the GitHub repository public, follow `docs/PRE-PUBLISH.md` — git history
still contains a harvested catalogue of local draft names.
