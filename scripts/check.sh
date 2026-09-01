#!/usr/bin/env bash
# Everything CI runs, in the order that fails fastest.
#
# This is the local mirror of .github/workflows/ci.yml. The two must not be able to
# disagree about whether the tree is good: every gate CI runs is a stage here, and a gate
# this script could not run is reported as SKIPPED rather than folded into "all passed".
# A green local run with three missing linters is not the same result as a green CI run,
# and saying so is the whole point.
#
#   scripts/check.sh            run what this machine can
#   scripts/check.sh --strict   require every gate; a missing tool is a failure (what CI does)
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)" || exit 1

strict=0
for arg in "$@"; do
    case "$arg" in
        --strict) strict=1 ;;
        -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
        *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
    esac
done
# CI sets this so the workflow and a local --strict run mean the same thing.
[ "${CI_REQUIRE_ALL_GATES:-}" = 1 ] && strict=1

status=0
skipped=()
stage() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail()  { printf '\033[31mFAIL\033[0m %s\n' "$1"; status=1; }
ok()    { printf '\033[32mok\033[0m   %s\n' "$1"; }
have()  { command -v "$1" >/dev/null 2>&1; }

# A gate this machine cannot run. Under --strict that is a failure, because "we did not
# look" and "we looked and it was fine" are different answers to the same question.
skip() {
    if [ "$strict" -eq 1 ]; then
        fail "$1 (required under --strict; $2)"
    else
        printf '\033[33mSKIP\033[0m %s — %s\n' "$1" "$2"
        skipped+=("$1")
    fi
}

stage "javascript syntax"
if check_out=$(npm run --silent check 2>&1); then ok "syntax clean"; else
    printf '%s\n' "$check_out" | tail -20
    fail "npm run check"
fi

# Capture, then grep. Piping straight into `grep -q` under `set -o pipefail` makes grep
# exit early, SIGPIPE the producer, and fail the pipeline even when the tests all passed.
#
# Trust the exit status first and the summary second. `# fail 0` on its own would also be
# printed by a run that reported no failures because it never ran anything, so require a
# non-zero pass count alongside it.
stage "node tests"
node_out=$(npm test 2>&1)
node_status=$?
node_pass=$(printf '%s' "$node_out" | grep -oE '^# pass [0-9]+' | grep -oE '[0-9]+$')
node_fail=$(printf '%s' "$node_out" | grep -oE '^# fail [0-9]+' | grep -oE '[0-9]+$')
node_skip=$(printf '%s' "$node_out" | grep -oE '^# skipped [0-9]+' | grep -oE '[0-9]+$')
if [ "$node_status" -eq 0 ] && [ "${node_fail:-1}" = 0 ] && [ "${node_pass:-0}" -gt 0 ]; then
    note=""
    # A skipped test is a gate that did not run. ffmpeg gates the cut.recut suite, so on a
    # machine without it this number is not zero — say so instead of implying full coverage.
    [ "${node_skip:-0}" -gt 0 ] && note=" — ${node_skip} skipped"
    ok "node (${node_pass} passing${note})"
    if [ "$strict" -eq 1 ] && [ "${node_skip:-0}" -gt 0 ]; then
        fail "node tests skipped ${node_skip} (required under --strict; install ffmpeg)"
    fi
else
    printf '%s\n' "$node_out" | tail -20
    fail "node tests"
fi

# Resolve the same interpreter cut/qa/find will spawn, and use it for the Python gates
# below. Linting tools/ under a different Python than the one that runs them is how a
# clean check and a broken command coexist.
stage "python runtime contract"
if py=$(node -e '
  import("./src/python.mjs")
    .then(m => { process.stdout.write(m.resolvePython({ refresh: true }).executable); })
    .catch(error => { process.stderr.write(error.message + "\n"); process.exit(1); });
' 2>&1) && [ -n "$py" ]; then
    ok "python ($("$py" -c 'import sys;print(".".join(map(str,sys.version_info[:3])))') at $py)"
else
    printf '%s\n' "$py"
    fail "no supported Python interpreter"
    py=""
fi

stage "python selftests"
if [ -n "$py" ]; then
    aroll_out=$("$py" tools/aroll.py --selftest 2>&1)
    if printf '%s' "$aroll_out" | grep -q 'all passed'; then ok "aroll"; else
        printf '%s\n' "$aroll_out" | tail -10
        fail "aroll selftest"
    fi
else
    skip "python selftests" "no interpreter"
fi

stage "python compiles"
if [ -n "$py" ]; then
    if "$py" -m compileall -q tools; then ok "tools compile"; else fail "compileall"; fi
else
    skip "python compiles" "no interpreter"
fi

stage "ruff"
# `ruff check` is the gate; `ruff format` is NOT run. These tools use a deliberately dense
# style (E701/E702 are ignored on purpose) and reformatting working code to please a
# formatter is how bugs get introduced into things nobody asked to change.
if have ruff; then
    if ruff check tools/; then ok "python clean"; else fail "ruff"; fi
else
    skip "ruff" "uv tool install ruff"
fi

stage "vulture (dead code)"
if have vulture; then
    out=$(vulture tools/ --min-confidence 80 2>&1)
    if [ -z "$out" ]; then ok "no dead code"; else echo "$out"; fail "vulture"; fi
else
    skip "vulture" "uv tool install vulture"
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
    skip "shellcheck" "brew install shellcheck"
fi

stage "vision ocr helper"
if [ "$(uname -s)" != "Darwin" ]; then
    # Not a gate anywhere but macOS, so this one is a genuine no-op rather than a skip.
    printf '\033[33mSKIP\033[0m vision ocr helper — macOS only\n'
elif [ -x tools/vision/ocr ]; then
    ok "built"
elif [ "${CI_REQUIRE_OCR:-}" = 1 ]; then
    echo "not built — swiftc -O -o tools/vision/ocr tools/vision/ocr.swift"
    fail "ocr helper"
else
    skip "vision ocr helper" "swiftc -O -o tools/vision/ocr tools/vision/ocr.swift"
fi

printf '\n'
if [ "$status" -ne 0 ]; then
    printf '\033[31mchecks failed\033[0m\n'
elif [ ${#skipped[@]} -gt 0 ]; then
    # Deliberately not "all checks passed". This tree has not been held to the CI bar.
    printf '\033[33mchecks passed, %d gate(s) skipped: %s\033[0m\n' \
        "${#skipped[@]}" "$(printf '%s, ' "${skipped[@]}" | sed 's/, $//')"
    printf 'CI runs every gate. Install the missing tools, or run with --strict to require them.\n'
else
    printf '\033[32mall checks passed\033[0m\n'
fi
exit "$status"
