"""Privacy denylist for the watcher. Runs locally, before anything leaves the machine.

Three gates, all applied by pick.py:
  1. app    - frontmost app at the keyframe time (from trace focus_change, or the first click/drag
              when the take opens without one). Checked BEFORE the frame is even decoded. A frame
              whose app cannot be known still gets OCR-gated but is never sent as an image.
  2. ocr    - the keyframe's on-device OCR text, every line whatever its confidence. A hit drops the
              JPEG and the OCR together; so does a failed or missing OCR record.
  3. trace  - app names and click-target titles that go into the timeline (e.g. a "Usage remaining
              0%" menu item). A hit replaces the name or title with "[withheld: <rule>]".

The app gate is the only cover for a frame with no readable text (a photo, a video call, a chat
full of images): OCR has nothing to match there, so keep the app list complete.

rl2 records no window titles (session.json privacy.window_titles), so "title" rules can only see
what OCR reads off the screen and what the click target was called.

Rules are deliberately specific phrases, not bare words: the creator's own videos are often about
usage limits and billing, so a bare /usage/ would drop most of a working day. Logs record rule name
+ where, never the matched text.

Override or extend with ~/.config/capcutctl/watcher-denylist.json (or the file named by
$CAPCUTCTL_WATCHER_DENYLIST, or load(path)):
  {"apps": ["..."], "ocr": {"rule-name": "regex"}, "replace": false}
"""

import json
import os
import re
import unicodedata
from pathlib import Path

APPS = {
    # password managers / keychain
    "1Password", "1Password 7", "Bitwarden", "Dashlane", "LastPass", "Keeper", "Proton Pass",
    "Keychain Access", "Passwords",
    # messaging
    "Messages", "WhatsApp", "Signal", "Telegram", "Discord", "Slack", "Mail", "Messenger",
    # banking / money
    "Revolut", "Wise", "PayPal", "Monzo", "N26", "Banking", "Wallet", "Coinbase", "Rabby",
    "Ledger Live", "MetaMask",
}

# Keep in sync with SECRET in tools/claude_timeline.py (watcher modules are standalone scripts, so
# this is a copy, not an import). claude_timeline.redact post-filters the bare 32+ char branch to
# runs that mix letters and digits; this copy does not, so a full commit hash after a space drops
# the frame. That errs on the private side, which is the right way for a gate to be wrong.
_ENV_WORD = r"(?:API)?KEYS?|SECRETS?|TOKENS?|PASSWORDS?|PASSWD|PATS?|AUTH"
SECRET = (
    r"(?:sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|AKIA[0-9A-Z]{12,}|xox[a-z]-[A-Za-z0-9\-]{10,}"
    r"|(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}"
    r"|tskey-[a-z]+-[A-Za-z0-9\-]{10,}|glpat-[A-Za-z0-9_\-]{20,}"
    r"|(?<![A-Za-z0-9])(?:hf|npm)_[A-Za-z0-9]{20,}"
    r"|AIza[0-9A-Za-z_\-]{30,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|(?P<hook>hooks\.slack\.com/services/)[A-Za-z0-9/_\-]{10,}"
    r"|(?P<url>://[^\s/:@]+:)[^\s/@]+(?=@)"
    r"|(?P<env>(?<![A-Za-z0-9_])(?:[A-Z0-9]+_)*(?:" + _ENV_WORD + r")(?:_[A-Z0-9]+)*(?![A-Za-z0-9])"
    r"[\"']?\s*[:=]\s*[\"']?)[^\s\"',;]{8,}"
    r"|(?i:bearer)\s+[A-Za-z0-9._\-]{20,}"
    r"|(?i:(?:api[_-]?key|secret|token|passw(?:or)?d|authorization)[\"']?\s*[:=]\s*[\"']?)[^\s\"',;]{8,}"
    r"|(?<![\w/.\-])[A-Za-z0-9]{32,}(?![\w/.\-]))")
# Screens where a key is about to appear: a provider's key page, a .env being edited.
_SECRET_PHRASES = (r"(?i:\b(?:api[ _-]?keys?|secret keys?|access tokens?|create (?:new )?(?:secret|api) key"
                   r"|copy key|personal access tokens?)\b)")
_ENV_ASSIGN = r"^\s*(?:export\s+)?[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET)\s*="
# Pre-compiled, and case-sensitive on purpose: the vendor prefixes and the ENV_NAME= branches lose
# their meaning under re.I ("Shortcut key: Command+Shift" would hit). re.M anchors _ENV_ASSIGN to
# each OCR line, which pick.py joins with "\n".
SECRET_RULE = re.compile("|".join((SECRET, _SECRET_PHRASES, _ENV_ASSIGN)), re.M)

OCR_RULES = {
    "private-browser": r"\b(you've gone incognito|incognito window|private browsing|inprivate)\b",
    "password-manager": r"\b(1password|bitwarden|dashlane|lastpass|keychain access|saved passwords|show password|passwords\.google)\b",
    "messaging": r"\b(imessage|whatsapp|text message|signal desktop|telegram desktop)\b",
    "billing": r"\b(payment method|billing (history|information|address|details)|invoice (#|no\.?|number)|card ending|update card|settings/billing|manage subscription)\b",
    "plan-usage": r"\b(your usage|usage remaining|plan usage( limits)?|limit resets|resets (at|in|on) \w|current session\W+\d{1,3}\s?%|weekly limits?\W+\d{1,3}\s?%|extra usage|settings/usage)\b",
    "bank": r"\b(account balance|available balance|sort code|routing number|iban\b|swift/bic|seed phrase|recovery phrase|private key)\b",
    "card-number": r"\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b",
    "secret": SECRET_RULE,
}

DEFAULT_PATH = "~/.config/capcutctl/watcher-denylist.json"


def norm_app(name):
    """NFKC, format characters (bidi marks, zero-width joiners) removed, casefolded, trimmed."""
    s = unicodedata.normalize("NFKC", name or "")
    return "".join(ch for ch in s if unicodedata.category(ch) != "Cf").casefold().strip()


def load(path=None):
    """(apps, rules). apps is a set of norm_app() names; rules maps rule name -> compiled regex.
    path, else $CAPCUTCTL_WATCHER_DENYLIST, else DEFAULT_PATH; a missing file means the defaults."""
    apps, rules = set(APPS), dict(OCR_RULES)
    path = os.path.expanduser(path or os.environ.get("CAPCUTCTL_WATCHER_DENYLIST") or DEFAULT_PATH)
    if os.path.exists(path):
        cfg = json.loads(Path(path).read_text())
        if cfg.get("replace"):
            apps, rules = set(), {}
        apps |= set(cfg.get("apps", []))
        rules.update(cfg.get("ocr", {}))
    apps = {n for n in map(norm_app, apps) if n}
    return apps, {k: v if isinstance(v, re.Pattern) else re.compile(v, re.I) for k, v in rules.items()}


def check_app(app, apps):
    """apps must come from load() (already normalised)."""
    return "app" if app and norm_app(app) in apps else None


def check_text(text, rules):
    """Return the first rule name that matches, or None. Never return the match itself."""
    for name, rx in rules.items():
        if rx.search(text or ""):
            return name
    return None
