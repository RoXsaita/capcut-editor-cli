# Open-source agent video editors — survey (September 2026)

What other coding-agent video editors do, what `capcutctl` already covers, and what was
adopted. Every repository below was cloned and read, not just its README skimmed.

## The field

| Project | Model of the edit | What it does best |
|---|---|---|
| [browser-use/video-use](https://github.com/browser-use/video-use) | A skill + Python helpers; ffmpeg renders an EDL to `final.mp4` | Text-first reasoning (a phrase-level packed transcript), on-demand filmstrip + waveform drill-down, 12 hard production rules, **self-eval of the rendered output at every cut before the user sees it**, a critic sub-agent for publishable work, `project.md` session memory |
| [veedstudio/open-edit](https://github.com/veedstudio/open-edit) | An npm CLI + skill; HTML/CSS documents rendered by VEED's engine | A gate chain (lint → verify → contrast → safe zones → mux), `check-delivery` on the finished file, **`creative-log`** (rejected/accepted looks keyed by footage, survives compaction), **`scoped-edit`** (proves a revision touched only what it was allowed to), brand checks |
| [krusemediallc/video-editor-agent](https://github.com/krusemediallc/video-editor-agent) | A Claude Code skill pack over HyperFrames + ffmpeg | **`reel-style-clone`** (a reference reel reverse-engineered into countable pacing rules), a 4-layer QA engine on the rendered MP4 (technical → transcript seams → multimodal → inspection packets), hook variants, a review canvas with timeline comments, resumable project state |
| [diffusionstudio/editor](https://github.com/diffusionstudio/editor) | A desktop editor whose timeline is code; MCP server for agents | The human and the agent edit the same real timeline |
| [poseljacob/agentic-video-editor](https://github.com/poseljacob/agentic-video-editor) | Gemini director → trim refiner → ffmpeg editor → reviewer | A reviewer agent that scores the render and feeds a retry loop (YAML pipelines, `retry_if` threshold) |
| [MartinDelophy/ai-video-editor](https://github.com/MartinDelophy/ai-video-editor) | Local-first editor + CLI | Creator and agent share one timeline |
| [WyattBlue/auto-editor](https://github.com/WyattBlue/auto-editor) | CLI | Silence/motion-threshold cutting, exports to NLE timelines |

## Where capcutctl already stands

Most of the field renders a flat MP4. `capcutctl` edits CapCut's native project and keeps
every clip, mask and keyframe editable, which none of the above do (krusemedia's CapCut export
is marked work-in-progress). The ideas the others converged on are mostly already here:

| Idea | Others | capcutctl |
|---|---|---|
| Word-level transcript, cuts on word/acoustic boundaries | video-use, open-edit | `cut` (energy10, acoustic boundary checks, reviewed keep/order) |
| Strategy confirmed before touching the cut | video-use hard rule 11 | the two-stage `cut` review handout; skills require sign-off |
| Style as one data file | agentic-video-editor `styles/`, open-edit recipes | `presets/profile.json` + `harvest --profile` |
| Ready-to-post gate from the style | open-edit gates | `gate` (hook, proof, static stretch, crowding, safe zones, seams) |
| Frame QA / contact sheets | all | `qa --at-cuts --sheet`, `review`, `export-grid`, `verify-shots` |
| Loudness to −14 LUFS / −1 dBTP | video-use, open-edit | `loudness`, `music --duck` |
| Deterministic HTML motion graphics | video-use (HyperFrames), open-edit | `mograph` (ProRes 4444 alpha, anchored to source words) |
| Snapshots and rollback | — | every transaction |

## Gaps, and what was adopted

1. **QA the render, not only the draft** (video-use self-eval; krusemedia L1; open-edit
   `check-delivery`). Every `capcutctl` check read the draft. The posted file can still open
   on black, carry a stray frame from a clip that ended a frame early, sit silent at a seam,
   or come out quiet. → **`capcutctl check-export`**: black inside/at the edges, 1-2 frame
   flashes, 1-2 frame micro-shots, frozen picture past `density.maxStatic`, late first sound,
   dead air, integrated loudness, true peak, and canvas/fps/length against the project.
   FAIL exits 1; every flagged moment is listed for `export-grid --times`.

2. **Clone a reference reel's pacing** (krusemedia `reel-style-clone`). "Edit it like this"
   was answered by eye. Its key lesson: perceived pace tracks *events* (cuts plus in-shot
   builds), not cuts alone. → **`capcutctl reference`** measures cuts and builds per second
   by section, first visual event, longest static stretch, median shot, speech ratio and
   loudness, side by side with the profile and (with `--project`) the edit's own gate values,
   and `--profile-out` writes a density override that `gate --profile` and `build` enforce.

3. **Prove a scoped revision stayed in scope** (open-edit `scoped-edit`). "Change only the
   second graphic" is the commonest revision note; a diff lists every change but leaves the
   agent to notice the one it was never meant to make. → **`capcutctl diff --allow`** names
   every change outside the allowed segment ids / `track:NAME`, with both values, and exits 1.

4. **Remember why** (open-edit `creative-log`; video-use `project.md`). Rejected looks lived
   in one agent's context and came back after a compaction. → **`capcutctl notes`**: rejected
   looks with reasons, the accepted look, decisions, outstanding notes, in
   `<project>/.capcutctl/notes.json` — outside snapshots, so `restore` never erases it.
   `notes --brief` is the first thing each round reads.

The skills repository adopts the process ideas that need no code: a fresh-eyes critic pass
on the render before hand-off (video-use), and reading the creative log at session start.

## Considered and not adopted

- **Flat ffmpeg rendering of an EDL** (video-use, auto-editor): the point of `capcutctl` is
  a project a person can keep editing in CapCut.
- **Hosted multimodal review scoring with automatic retry loops** (agentic-video-editor,
  krusemedia L3): needs paid API keys and returns scores, not locations; the local checks
  plus a critic sub-agent reading the sheets give locations without a key.
- **Hook variants joined by stream copy** (krusemedia `hook-variations`): a real need, but it
  is a batch over rendered files rather than an edit of one project. Left for later.
