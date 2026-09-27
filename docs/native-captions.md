# Native editable word captions (experimental)

`capcutctl captions` uses the Staging caption engine for word grouping/correction
and inserts **ordinary editable CapCut text clips**. It never invokes CapCut's
paid recognition, subtitle templates, or premium caption effects. It never
burns captions into imported media and does not export a video.

**Not yet certified as visually identical to Staging.** Native size 28 was measured
in a CapCut export (a word about 94px tall at 1080x1920, outline included). A valid draft
is not evidence of correct Arabic shaping, font metrics, or face clearance.

## Usage

Close CapCut before project writes:

```sh
capcutctl captions --project "My Edit" --dry-run
capcutctl captions --project "My Edit"
capcutctl captions --project "My Edit" --script script.txt
capcutctl captions --project "My Edit" --track narration
```

With no cue file, the command mixes **the edited narration track only**, preserving
its source trims, order, constant speed, volume, and timeline gaps. Music and SFX
are excluded. It transcribes the resulting temporary audio, not the unedited
source take. Temporary analysis audio is never imported into the project.
The default narration track is the CLI's principal talking-head track; explicitly
select one video/audio track when that heuristic is not appropriate. Reverse and
curve-speed narration are refused, not silently mistimed.

Existing Staging cues can be imported without transcription or Python:

```sh
capcutctl captions --project "My Edit" --cues captions.json --dry-run
capcutctl captions --project "My Edit" --cues captions.json
```

Accepted input is a cue array, `{ "version": 1, "language": "ar", "cues": [...] }`,
or the command's own JSON report containing `bundle`. Cue timestamps must be
**seconds in the current edited timeline**, not source-media timestamps. Every cue
needs a unique `id`, numeric `start`/`end`, `text`, and optional `position` (percent
from bottom, default 20). Do not import cues from a differently cut video.
The JSON report retains original ASR words, cue timings, placement, and review
metadata, so it can also be saved as the reusable caption artifact.

Generated layers are on `captions:suheil`. Text, placement, timing, and later
keyframes remain native properties. `--name ID` changes that label, not the style.
One managed caption track is allowed: reruns with identical untouched imported
cues are no-ops; different inputs or native/manual edits refuse. Remove the old
caption track explicitly in CapCut before replacing it. Generation refuses an
existing track before doing ASR, protecting manual edits and avoiding duplicate
captions. Normal snapshots and root/active-timeline mirror transactions apply.

## Dependencies

Import mode needs the bundled Changa font, and a locally licensed Arial Unicode
font for cues containing Latin letters. Arial Unicode is not redistributed.
`CAPCUTCTL_LATIN_FONT=/absolute/path/to/font.ttf` overrides its location; use the
same face for Staging parity. Font files are localized into the project. No
system-wide font install or CapCut effect-cache download is required.

For generation, use the CLI's Python environment:

```sh
uv venv .venv
uv pip install --python .venv/bin/python -e '.[captions]' mlx-whisper
```

On non-Apple hardware, install `faster-whisper` instead. FFmpeg is required.
Strong large-v3/large-v2 model metadata and word timestamps are mandatory: a base
fallback is refused. First use can download model weights. There is no implicit
paid transcription API. Native UI acceptance currently targets macOS CapCut.

## Staging behaviour retained

- Hash-pinned snapshot of `dashboard/caption_engine`, including its license and
  Changa ExtraBold font. No dashboard server, database, or local dashboard path is
  required. The source Staging system is untouched.
- One word per cue, with Staging's two-token particle exception.
- Script-aware monotonic alignment and the deterministic برومبت spelling guard.
- Staging's bounded sparse typo-correction prompt and validation, when a model
  hook is configured. IDs, timings, and positions are not rewritten by that hook.
- Arabic stays in logical Unicode order; NFC, diacritic/digit normalization,
  mixed-Latin font fallback, white fill, and one black glyph outline. No box,
  shadow, glow, yellow karaoke, or uppercase conversion.
- Staging's half-open render windows, so adjacent text clips do not overlap.
- Native split-screen shots use 50% from bottom; full-face shots use 20%.
  For one untouched, canvas-sized imported master, Staging's real shot detector
  and Apple Vision face placement inspect the source pixels. For native edited
  multi-layer projects, actual timeline layouts supply the shot presets, rather
  than trying to infer them again from a low-quality proxy.

This is a **pinned port**, not an automatically synchronized engine. Its original
NOTICE/font README describe the larger Staging package; only active Changa is
bundled here, not legacy Alexandria. `provenance.json` hashes every vendored file.
Keep adapter changes outside that directory; deliberately repin and rerun parity
tests when adopting future Staging changes. Ruff/Vulture exclude the immutable
vendor snapshot, not the new adapter.

## Model typo pass

On by default. With no `CAPCUTCTL_CAPTION_TEXT_COMMAND`, `tools/caption_text_llm.py` sends the
Staging prompt to the first signed-in CLI in `CAPCUTCTL_CAPTION_TEXT_CHAIN`
(default `codex-luna,claude-haiku,opencode`), falling through on error or unparseable output.
Each runs with tools off from an empty temp directory; missing CLIs are skipped. `off` disables it.

| Backend | Command | On the Dishwasher cues (119) |
|---|---|---|
| `codex-luna` | `codex exec -m gpt-6-luna`, low effort | 13s; caught القياسات and يقارن |
| `claude-haiku` | `claude -p --model haiku`, thinking off | 4s; missed القياسات, rewrote Gmail to email |
| `opencode` | `opencode run` (`CAPCUTCTL_OPENCODE_MODEL`) | not measured |

Models also replace a word with a different one. The adapter keeps a fix only when it changes
at most 1 character, or at most 2 that are no more than 30% of the word, and adds no words; the
rest are dropped one by one. It cannot recover a word the ASR heard as nonsense (الغشرية).

`CAPCUTCTL_CAPTION_TEXT_COMMAND` (a JSON argv array; prompt on stdin, `{"fixes":[]}` on stdout,
90-second timeout, no shell) still overrides the chain. A failed pass leaves the Whisper text
and a visible `text_polish` warning.

## Verification status and remaining acceptance gates

Exercised locally: real Arabic speech -> MLX large-v3-turbo -> Staging cues ->
Apple Vision/shot placement -> native text transaction in an isolated disposable
project. The 8.1-second fixture produced 19 clips, both 20/50 presets, and zero
structural doctor errors. Root/timeline mirrors, localized fonts, non-overlapping
windows, untouched source media tracks, conflict protection, and dry-run are
covered by tests. A valid file structure does not prove native playback.

Still required before claiming identical behaviour or a finished handoff:

1. Unlock the Mac and open the disposable project in real CapCut. The session was
   locked during implementation; no lock bypass, forced app termination, native
   screenshot claim, or final export was used as a substitute.
2. Select and edit Arabic and mixed Latin clips, save/reopen, and verify they
   remain editable text. Compare actual native pixels against Staging for size,
   baseline/center, black-outline thickness, shaping, and both position presets.
   Size 28 is measured on one export; stroke thickness is not yet compared with Staging.
3. Configure and exercise the selected model typo pass.
4. Inspect **native captioned pixels** for face clearance. No automated native
   captioned-grid review/correction loop is wired yet. The CLI correctly returns
   `needs_review`, `native_verified=false`; Staging's burned-grid QA cannot certify
   a different renderer. Existing CLI proxy QA does not render these text clips.
5. Test a longer, cut/reordered multi-layout real project, including short words
   at edit boundaries. Export only if explicitly requested.

`--dry-run` with cues validates the planned transaction without fonts/snapshots/
draft writes. Without cues it is explicitly `planOnly`: no audio extraction,
ASR, model calls, or side effects. It does not claim to validate captions that
have not been generated.
