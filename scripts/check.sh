#!/usr/bin/env bash
# Everything, in the order that fails fastest.
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)" || exit 1

status=0
stage() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail()  { printf '\033[31mFAIL\033[0m %s\n' "$1"; status=1; }
ok()    { printf '\033[32mok\033[0m   %s\n' "$1"; }
have()  { command -v "$1" >/dev/null 2>&1; }

# Capture, then grep. Piping straight into `grep -q` under `set -o pipefail` makes grep
# exit early, SIGPIPE the producer, and fail the pipeline even when the tests all passed.
stage "node tests"
node_out=$(npm test 2>&1)
if printf '%s' "$node_out" | grep -qE '^# fail 0'; then
    ok "node ($(printf '%s' "$node_out" | grep -oE '^# pass [0-9]+' | grep -oE '[0-9]+') passing)"
else
    printf '%s\n' "$node_out" | tail -20
    fail "node tests"
fi

stage "python selftests"
aroll_out=$(python3 tools/aroll.py --selftest 2>&1)
if printf '%s' "$aroll_out" | grep -q 'all passed'; then ok "aroll"; else
    printf '%s\n' "$aroll_out" | tail -10
    fail "aroll selftest"
fi

stage "ruff"
# `ruff check` is the gate; `ruff format` is NOT run. These tools use a deliberately dense
# style (E701/E702 are ignored on purpose) and reformatting working code to please a
# formatter is how bugs get introduced into things nobody asked to change.
if have ruff; then
    if ruff check tools/; then ok "python clean"; else fail "ruff"; fi
else
    echo "SKIP — uv tool install ruff"
fi

stage "vulture (dead code)"
if have vulture; then
    out=$(vulture tools/ --min-confidence 80 2>&1)
    if [ -z "$out" ]; then ok "no dead code"; else echo "$out"; fail "vulture"; fi
else
    echo "SKIP — uv tool install vulture"
fi

stage "shellcheck"
if have shellcheck; then
    # find -exec, not $(...): macOS ships bash 3.2, which has no mapfile.
    if find . -name '*.sh' -not -path './node_modules/*' -exec shellcheck {} +; then
        ok "shell clean"
    else
        fail "shellcheck"
    fi
else
    echo "SKIP — brew install shellcheck"
fi

stage "vision ocr helper"
if [ "$(uname -s)" != "Darwin" ]; then
    echo "SKIP — macOS only"
elif [ -x tools/vision/ocr ]; then
    ok "built"
elif [ "${CI_REQUIRE_OCR:-}" = 1 ]; then
    echo "not built — swiftc -O -o tools/vision/ocr tools/vision/ocr.swift"
    fail "ocr helper"
else
    echo "SKIP — swiftc -O -o tools/vision/ocr tools/vision/ocr.swift"
fi

printf '\n'
if [ "$status" -eq 0 ]; then printf '\033[32mall checks passed\033[0m\n'; else printf '\033[31mchecks failed\033[0m\n'; fi
exit "$status"
