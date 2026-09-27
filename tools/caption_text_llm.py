"""Default model for the caption typo pass: the cheapest CLI on this machine, with fallbacks.

The engine sends one prompt and wants {"fixes":[...]} back; it validates every fix itself.
Each backend here runs a locally signed-in CLI with tools off, from an empty directory, so
no project context, hooks or agent actions are involved. The first backend whose answer
parses as {"fixes": [...]} wins; the rest are fallbacks.

Models also "fix" a word into a different word (Gmail -> email, dialect -> formal). A typo is a
small edit, so each fix is kept only if it changes at most 1 character, or 2 characters that are
no more than 30% of the word, and adds no words. Anything else is dropped on its own instead of
failing the whole batch.

CAPCUTCTL_CAPTION_TEXT_CHAIN   comma list of backends, default "codex-luna,claude-haiku,opencode";
                               "off" disables the pass.
CAPCUTCTL_OPENCODE_MODEL       model for the opencode backend (default: opencode's own default).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

DEFAULT_CHAIN = 'codex-luna,claude-haiku,opencode'
TIMEOUT = 90


def _claude(prompt, work):
    argv = ['claude', '-p', '--model', 'haiku', '--tools', '', '--no-session-persistence',
            '--strict-mcp-config', '--output-format', 'text']
    # Thinking takes a one-line answer from ~4s to ~75s without improving it.
    env = dict(os.environ, MAX_THINKING_TOKENS='0')
    return subprocess.run(argv, input=prompt, text=True, capture_output=True, cwd=work, env=env,
                          timeout=TIMEOUT, check=True).stdout


def _codex(prompt, work):
    out = Path(work) / 'last.txt'
    argv = ['codex', 'exec', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=low', '-s', 'read-only',
            '--skip-git-repo-check', '--ephemeral', '-o', str(out), '-']
    subprocess.run(argv, input=prompt, text=True, capture_output=True, cwd=work, timeout=TIMEOUT, check=True)
    return out.read_text()


def _opencode(prompt, work):
    argv = ['opencode', 'run']
    if os.environ.get('CAPCUTCTL_OPENCODE_MODEL'):
        argv += ['-m', os.environ['CAPCUTCTL_OPENCODE_MODEL']]
    return subprocess.run(argv + [prompt], text=True, capture_output=True, cwd=work,
                          timeout=TIMEOUT, check=True).stdout


BACKENDS = {'claude-haiku': ('claude', _claude), 'codex-luna': ('codex', _codex), 'opencode': ('opencode', _opencode)}


def edit_distance(a, b):
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1]


def is_typo_fix(fix):
    if not isinstance(fix, dict):
        return False
    before, after = str(fix.get('before') or ''), str(fix.get('text') or '').strip()
    if not after or after == before or len(after.split()) > len(before.split()):
        return False
    distance = edit_distance(before, after)
    return distance <= 1 or (distance <= 2 and distance <= 0.3 * len(before.replace(' ', '')))


def fixes_json(raw):
    """The first {"fixes": [...]} object in a reply, typo fixes only; None when there is none."""
    decoder = json.JSONDecoder()
    text = str(raw or '')
    for index, char in enumerate(text):
        if char != '{':
            continue
        try:
            payload, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and isinstance(payload.get('fixes'), list):
            return json.dumps({'fixes': [f for f in payload['fixes'] if is_typo_fix(f)]}, ensure_ascii=False)
    return None


def chain():
    raw = os.environ.get('CAPCUTCTL_CAPTION_TEXT_CHAIN', DEFAULT_CHAIN).strip()
    if raw.lower() in ('off', 'none', '0', ''):
        return []
    names = [name.strip() for name in raw.split(',') if name.strip()]
    unknown = [name for name in names if name not in BACKENDS]
    if unknown:
        raise ValueError(f'Unknown CAPCUTCTL_CAPTION_TEXT_CHAIN backend(s): {", ".join(unknown)}')
    return [name for name in names if shutil.which(BACKENDS[name][0])]


def default_text_callback():
    names = chain()
    if not names:
        return None

    def run(prompt):
        errors = []
        with tempfile.TemporaryDirectory(prefix='capcut-caption-text-') as work:
            for name in names:
                try:
                    answer = fixes_json(BACKENDS[name][1](prompt, work))
                except (subprocess.SubprocessError, OSError) as exc:
                    errors.append(f'{name}: {str(exc)[:120]}')
                    continue
                if answer is not None:
                    return answer, name
                errors.append(f'{name}: no fixes JSON in reply')
        raise RuntimeError('every caption text backend failed: ' + '; '.join(errors))
    return run
