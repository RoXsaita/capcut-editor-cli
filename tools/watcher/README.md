# watcher (v0)

Cheap "watcher" tier for the video creation engine: reads an rl2 take without watching the video,
writes a journal per 15-min window. Prototype; nothing is scheduled.

    python3 cli/tools/watcher/run.py "<rl2 take dir>"... --out productions/watcher-v0 --modes mixed

- `pick.py`: picks keyframes from change.ndjson and trace.ndjson (settle, focus, prompt, typing, scroll,
  drift), caps them at 30 per 15 min, extracts 1280-px JPEGs by seeking, runs OCR, and applies the
  privacy gates.
- `ocr.swift`: Apple Vision OCR. It is compiled on first use to ~/.cache/capcutctl/watcher/ocr.
- `privacy.py`: the app / OCR-phrase / click-title denylist. It runs before anything reaches the
  model, and logs only rule and time. Your own overrides go in
  ~/.config/capcutctl/watcher-denylist.json.
- `prompt.md` + `watch.py`: one `claude -p --model claude-haiku-5-5` call per window. It runs on your
  login and strips any API key. The model cites keyframe ids, and code maps them to take + offset +
  wall clock. Modes: `ocr`, `mixed` (images only for low-text frames; default) and `images`.

Results and cost/quality notes: productions/watcher-v0/FINDINGS.md.
