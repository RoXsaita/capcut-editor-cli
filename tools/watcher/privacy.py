"""Privacy denylist for the watcher. Runs locally, before anything leaves the machine.

Three gates, all applied by pick.py:
  1. app    - frontmost app at the keyframe time (from trace focus_change). Checked BEFORE the
              frame is even decoded.
  2. ocr    - the keyframe's on-device OCR text. A hit drops the JPEG and the OCR together.
  3. trace  - click-target titles that go into the timeline (e.g. a "Usage remaining 0%" menu item).
              A hit replaces the title with "[withheld: <rule>]".

rl2 records no window titles (session.json privacy.window_titles), so "title" rules can only see
what OCR reads off the screen and what the click target was called.

Rules are deliberately specific phrases, not bare words: Suheil's own work is about usage limits
and billing ("Claude Usage Limit" is a house look and a session title), so a bare /usage/ would
drop half his day. Logs record rule name + where, never the matched text.

Override or extend with ~/.config/capcutctl/watcher-denylist.json:
  {"apps": ["..."], "ocr": {"rule-name": "regex"}, "replace": false}
"""

import json
import os
import re

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

OCR_RULES = {
    "private-browser": r"\b(you've gone incognito|incognito window|private browsing|inprivate)\b",
    "password-manager": r"\b(1password|bitwarden|dashlane|lastpass|keychain access|saved passwords|show password|passwords\.google)\b",
    "messaging": r"\b(imessage|whatsapp|text message|signal desktop|telegram desktop)\b",
    "billing": r"\b(payment method|billing (history|information|address|details)|invoice (#|no\.?|number)|card ending|update card|settings/billing|manage subscription)\b",
    "plan-usage": r"\b(your usage|usage remaining|plan usage( limits)?|limit resets|resets (at|in|on) \w|current session\W+\d{1,3}\s?%|weekly limits?\W+\d{1,3}\s?%|extra usage|settings/usage)\b",
    "bank": r"\b(account balance|available balance|sort code|routing number|iban\b|swift/bic|seed phrase|recovery phrase|private key)\b",
    "card-number": r"\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b",
}


def load():
    apps, rules = set(APPS), dict(OCR_RULES)
    path = os.path.expanduser("~/.config/capcutctl/watcher-denylist.json")
    if os.path.exists(path):
        cfg = json.load(open(path))
        if cfg.get("replace"):
            apps, rules = set(), {}
        apps |= set(cfg.get("apps", []))
        rules.update(cfg.get("ocr", {}))
    return apps, {k: re.compile(v, re.I) for k, v in rules.items()}


def check_app(app, apps):
    return "app" if app and app in apps else None


def check_text(text, rules):
    """Return the first rule name that matches, or None. Never return the match itself."""
    for name, rx in rules.items():
        if rx.search(text or ""):
            return name
    return None
