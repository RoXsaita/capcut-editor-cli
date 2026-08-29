# Security policy

## This tool can destroy a CapCut library

`capcutctl` writes CapCut draft JSON on disk. A bug, a bad spec, or
`--force-running` while CapCut is open can corrupt a project. Snapshots under
`.capcutctl/history/` are the recovery path. Treat any untrusted spec file the
way you would treat a shell script.

## Reporting a vulnerability

Please **do not** open a public issue for:

- secret leakage (API keys, tokens, `.env` contents)
- path traversal or writes outside the intended project directory
- command injection via project names, media paths, or spec fields
- anything that would let a malicious spec/file run code

Use GitHub's private advisory form:

https://github.com/RoXsaita/capcut-editor-cli/security/advisories/new

Include a repro, the affected command, and whether a snapshot still restores.

We will acknowledge the report and fix before any disclosure.

## What is in scope

- The `capcutctl` CLI, Node sources under `src/`, Python helpers under `tools/`
- GitHub Actions under `.github/workflows/`
- Handling of `.env`, `GEMINI_API_KEY`, and other secrets
- Writes to `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`

## What is out of scope

- CapCut itself
- A user passing `--force-running` and losing work to CapCut's autosave
- Harvested effect/music cache IDs that only exist on one Mac
- The Gemini / Lyria API

## Secrets

Never commit `.env`. Copy `.env.example`. `finish --music` reads `GEMINI_API_KEY`
from the environment or `cli/.env` (gitignored) and must never log the value.
