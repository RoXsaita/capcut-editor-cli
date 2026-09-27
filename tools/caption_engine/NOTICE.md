# Caption engine provenance

Core ASS generation, script-aware layout, and burn pipeline patterns are adapted from:

- **ai-video-captions** (MIT) — https://github.com/nicolaigaina/ai-video-captions  
  Copyright (c) 2026 AutoShorts

Suheil AI changes:
- Added `suheil` style matching reverse-engineered CapCut/IG look (white fill, thick black outline, short Arabic phrases, lower-mid position).
- Do **not** force uppercase on Arabic.
- Prefer macOS `SF Arabic Rounded` / `Geeza Pro` for Arabic.
- Cue JSON + WebVTT path for in-dashboard edit before burn.
- Integrated into the Suheil AI dashboard media pipeline (not a standalone service).
