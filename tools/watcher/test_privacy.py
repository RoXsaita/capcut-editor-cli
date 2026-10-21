"""Watcher privacy gates. Synthetic events and OCR records only; nothing is decoded or sent.

python -m unittest discover -s tools/watcher -p 'test_*.py'
"""

import json
import os
import tempfile
import unittest

import pick
import privacy
import watch


def defaults():
    """The built-in lists, never the user's own denylist file."""
    return privacy.load(os.path.join(tempfile.gettempdir(), "watcher-no-such-denylist.json"))


def line(text, conf=0.9):
    return {"text": text, "conf": conf, "box": [0, 0, 0.1, 0.1]}


class OcrGate(unittest.TestCase):
    def setUp(self):
        self.apps, self.rules = defaults()

    def test_missing_record_is_dropped(self):
        stage, _, lines = pick.gate_ocr(None, self.rules)
        self.assertEqual(stage, "ocr-missing")
        self.assertEqual(lines, [])

    def test_error_record_is_dropped(self):
        stage, rule, _ = pick.gate_ocr({"file": "c000.jpg", "error": "decode"}, self.rules)
        self.assertEqual(stage, "ocr-error")
        self.assertEqual(rule, "ocr-decode")
        self.assertEqual(pick.gate_ocr({"file": "c000.jpg"}, self.rules)[0], "ocr-error")

    def test_low_confidence_line_still_gates(self):
        rec = {"file": "c000.jpg", "lines": [line("Settings"), line("Payment method", 0.2)]}
        stage, rule, _ = pick.gate_ocr(rec, self.rules)
        self.assertEqual((stage, rule), ("ocr", "billing"))

    def test_clean_frame_keeps_confident_lines(self):
        rec = {"file": "c000.jpg", "lines": [line("Terminal"), line("zzq", 0.1)]}
        self.assertEqual(pick.gate_ocr(rec, self.rules), (None, None, ["Terminal"]))
        self.assertEqual(pick.gate_ocr(rec, self.rules, min_conf=0)[2], ["Terminal", "zzq"])

    def test_empty_screen_passes(self):
        self.assertEqual(pick.gate_ocr({"file": "c000.jpg", "lines": []}, self.rules), (None, None, []))


class AppGate(unittest.TestCase):
    def setUp(self):
        self.apps, self.rules = defaults()

    def test_timeline_never_carries_a_denylisted_app_name(self):
        events = [
            {"type": "focus_change", "vt": 1.0, "app": "Messages"},
            {"type": "click", "vt": 2.0, "app": "Messages", "target": {"title": "Conversation"}},
            {"type": "drag", "vt": 3.0, "app": "Signal", "distance": 120},
            {"type": "click", "vt": 4.0, "app": "Terminal", "target": {"title": "Run"}},
        ]
        tl, filtered = pick.build_timeline(events, self.apps, self.rules)
        dumped = json.dumps(tl)
        for name in ("Messages", "Signal", "Conversation"):
            self.assertNotIn(name, dumped)
        self.assertIn("Terminal", dumped)
        self.assertEqual([f["what"] for f in filtered], ["focus_change", "click title", "drag"])
        self.assertTrue(all(f["stage"] == "trace" for f in filtered))

    def test_clicks_only_take_uses_the_first_click_app(self):
        events = [{"type": "click", "vt": 10.0, "app": "WhatsApp", "target": {"title": "Chats"}}]
        app = pick.frontmost(events, 2.0)
        self.assertEqual(app, "WhatsApp")
        self.assertEqual(pick.gate_app(app, self.apps), ("app", False))

    def test_focus_change_first_means_unknown(self):
        events = [{"type": "focus_change", "vt": 10.0, "app": "Safari"},
                  {"type": "click", "vt": 11.0, "app": "Safari", "target": {"title": "Reload"}}]
        app = pick.frontmost(events, 2.0)
        self.assertEqual(app, pick.UNKNOWN_APP)
        self.assertEqual(pick.gate_app(app, self.apps), (None, True))
        self.assertEqual(pick.frontmost(events, 10.5), "Safari")
        self.assertEqual(pick.frontmost([], 2.0), pick.UNKNOWN_APP)

    def test_known_app_gets_images(self):
        self.assertEqual(pick.gate_app("Terminal", self.apps), (None, False))

    def test_app_names_are_normalised(self):
        self.assertEqual(privacy.check_app("‎WhatsApp", self.apps), "app")
        self.assertEqual(privacy.check_app("whatsapp", self.apps), "app")
        self.assertEqual(privacy.check_app("ＷhatsApp", self.apps), "app")  # fullwidth W
        self.assertIsNone(privacy.check_app("Safari", self.apps))
        self.assertIsNone(privacy.check_app(pick.UNKNOWN_APP, self.apps))


class Watch(unittest.TestCase):
    def images(self, kfs, mode):
        timeline = {"events": [], "duration_s": 60.0}
        content, stats = watch.build_window(0, kfs, timeline, "take", None, mode, "/nonexistent")
        self.assertFalse(any(c["type"] == "image" for c in content))
        return stats["images"]

    def test_no_image_frames_never_attach(self):
        kf = {"id": "k01", "vt": 1.0, "app": pick.UNKNOWN_APP, "reasons": ["focus"], "ocr": [], "no_image": True}
        self.assertEqual(self.images([kf], "images"), 0)
        self.assertEqual(self.images([kf], "mixed"), 0)

    def test_mixed_judges_the_whole_text_not_the_new_lines(self):
        text = [f"a fairly long line of terminal output number {i}" for i in range(10)]
        a = {"id": "k01", "vt": 1.0, "app": "Terminal", "reasons": ["settle"], "ocr": text}
        b = dict(a, id="k02", vt=2.0)   # nothing new, still a screen full of text
        self.assertEqual(self.images([a, b], "mixed"), 0)


class Rules(unittest.TestCase):
    def setUp(self):
        self.apps, self.rules = defaults()

    def test_secret_rule(self):
        key = "sk-" + "proj-" + "Ab3" * 10
        for text in (f"key {key}", "OPENAI_API_KEY=" + "…", "Create new secret key",
                     "export STRIPE" + "_SECRET_KEY=" + "x", "Personal access tokens"):
            self.assertEqual(privacy.check_text(text, self.rules), "secret", text)

    def test_secret_rule_is_case_sensitive_where_it_must_be(self):
        for text in ("Claude Usage Limit", "Shortcut key: Command+Shift", "monkey: bananas-and-more"):
            self.assertIsNone(privacy.check_text(text, self.rules), text)

    def test_card_number_with_or_without_separators(self):
        for text in ("4242 4242 4242 4242", "4242-4242-4242-4242", "4242" * 4):
            self.assertEqual(privacy.check_text(text, self.rules), "card-number", text)
        self.assertIsNone(privacy.check_text("4242" * 5, self.rules))

    def test_load_replace_drops_the_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "denylist.json")
            with open(path, "w") as f:
                json.dump({"replace": True, "apps": ["‎Notes"], "ocr": {"diary": r"\bdear diary\b"}}, f)
            apps, rules = privacy.load(path)
        self.assertEqual(apps, {"notes"})
        self.assertEqual(list(rules), ["diary"])
        self.assertEqual(privacy.check_app("Notes", apps), "app")
        self.assertIsNone(privacy.check_app("WhatsApp", apps))
        self.assertEqual(privacy.check_text("Dear Diary, today", rules), "diary")

    def test_load_extends_by_default(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "denylist.json")
            with open(path, "w") as f:
                json.dump({"apps": ["Notes"]}, f)
            apps, rules = privacy.load(path)
        self.assertEqual(privacy.check_app("WhatsApp", apps), "app")
        self.assertEqual(privacy.check_app("Notes", apps), "app")
        self.assertIn("secret", rules)

    def test_env_names_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "denylist.json")
            with open(path, "w") as f:
                json.dump({"replace": True, "apps": ["Notes"]}, f)
            old = os.environ.get("CAPCUTCTL_WATCHER_DENYLIST")
            os.environ["CAPCUTCTL_WATCHER_DENYLIST"] = path
            try:
                apps, _ = privacy.load()
            finally:
                if old is None:
                    os.environ.pop("CAPCUTCTL_WATCHER_DENYLIST")
                else:
                    os.environ["CAPCUTCTL_WATCHER_DENYLIST"] = old
        self.assertEqual(apps, {"notes"})


if __name__ == "__main__":
    unittest.main()
