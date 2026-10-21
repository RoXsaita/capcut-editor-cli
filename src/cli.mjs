import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { profileValue } from './profile.mjs';
import { pythonForTool } from './python.mjs';
import {
  CapcutError,
  DEFAULT_ROOT,
  allSegments,
  applySpec,
  assertCapcutClosed,
  contentEndUs,
  createdMetadata,
  createSnapshot,
  doctor,
  inspectProject,
  listSnapshots,
  loadProject,
  loadWorkingDoc,
  preflight,
  preservedRange,
  listProjects,
  capcutStatus,
  closeCapcut,
  isStageDir,
  readJson,
  repairProject,
  resolveProject,
  restoreProjectSnapshot,
  stableJson,
  syncMirrors
} from './core.mjs';

export const HELP = `capcutctl — transactional CapCut timeline control

Usage:
  capcutctl --version
  capcutctl version
  capcutctl cut VIDEO [--keep 0,2-9|--drop 1,7] [--order 0,2,3] [--trim-beat ID:out=-1.16]
                      [--recover-beat ID:out=0.8]
                      [--review decisions.json] [--project NAME] [--into PROJECT|--in-place] [--lang ar]
                      — talking-head cleanup and reviewed A-roll assembly. Use --order
                        for an exact kept-beat permutation, --trim-beat for safe inward
                        acoustic trims, opt-in word/acoustic outward recovery, or --review
                        for a source-tokened decision file.
                        --into recuts an existing project transactionally.
  capcutctl qa --project NAME [--times 3,9,15|--at-cuts|--at-scenes|--at-broll]
               [--guide 960] [--sheet] [--label L] [--cut-window S]
                      — targeted native-resolution pixel QA; --at-cuts samples both
                        sides of each cut. --preview is a separate streamed proxy job
                        and cannot be combined with selectors, --times, --sheet, or --expect.
  capcutctl find ["agent running"] --media FILE [--shows|--says|--moments] [--focus APP]
                 [--context] [--refresh] [--min-score N] [--boxes]
                 [--region chat|canvas|toolbar|any] [--kind action|any]
                      — when is it on screen / when was it said / when did anything happen.
                        --moments reads an rl2 take's own sidecars; search a plain recording with --shows.
                        --boxes prints per-word OCR geometry kept in the index.
                        --region filters those boxes: toolbar = static top/bottom strips,
                        chat = a side column of uniform line-height (scrolling mask column),
                        canvas = the changing 2D app surface. Default any (output unchanged).
                        --kind action prefers canvas/toolbar hits over chat that only describes
                        the thing; implied when the query contains a verb like click/tap/hit.
  capcutctl xray scan VIDEO [--project NAME] [--out DIR] [--json] [--no-text] [--speech [--lang ar]] [--jev]
                      — measure every frame and audio sample of a real export: an exact
                        frame ledger, PASS/FAIL/UNKNOWN/NOTE/NOT CHECKED verdicts, score.txt,
                        overview sheets and a ranked queue of windows to look at. Exit 1 on FAIL.
                        On a low-fps proxy (under 24 fps) frame-timed findings (flashes, glitches,
                        stutter, seams) and the export size/rate are NOTE: proxy-only, verify on
                        the full-rate export.
  capcutctl xray frame VIDEO [--frame N|--t S] [--crop X,Y,W,H] [--out PNG] [--xray DIR]
  capcutctl xray window VIDEO [--frames A-B|--from S --to S] [--crop X,Y,W,H] [--out PNG] [--xray DIR]
                      — exact frames, verified by PTS, at native resolution or as a strip.
  capcutctl xray audio VIDEO --from S --to S
  capcutctl xray bench VIDEO [--rounds 3] [--per-family 2] [--seed 7]
                      — plant known defects in re-encoded copies and measure what is caught.
  capcutctl xray jev-setup
  capcutctl xray selftest

  capcutctl preflight [--root PATH] [--json]   — will this work on this machine? deps, assets, tools, disk
  capcutctl projects [--root PATH] [--json]
  capcutctl rm --project NAME [--dry-run] [--force-running]   — to .recycle_bin, registry entry dropped
  capcutctl close [--timeout MS] [--json]      — quit CapCut and wait for it to exit
  capcutctl status [--json] [--wait-for-close [--timeout MS]]
                                report CapCut state; optionally request quit and return a branchable close result
  capcutctl export --project NAME --out FILE.mp4 [--overwrite] [--grid FILE.png] [--times 3,9,15] [--xray DIR]
                   [--pause SECONDS] [--script FILE] [--review-model sonnet] [--no-review] [--no-gate]
                   [--profile FILE] [--style NAME]
                      — explicitly requested native macOS export, verified before replacing output, then the
                        final gates: X-ray with the export's transcript (into --xray DIR, default FILE.xray),
                        gate + X-ray, and — only if that passes — the Gemini watch-review (review-video).
                        Exit 1 when the gates fail; the export stays. --pause allows a deliberate pause;
                        --no-gate is for a render that is not a final (no X-ray unless --xray). The gate uses
                        the profile/style build recorded; --profile/--style override it. Refuses
                        (EXPORT_TAIL_PAST_CONTENT) a draft that runs past the edit's end.
  capcutctl export-grid --media FILE --out GRID.png [--times 3,9,15]
                      — fast labelled grid from an existing exported video; no CapCut UI.
  capcutctl check-export --media FILE.mp4 [--project NAME] [--target -14] [--peak -1] [--sheet FILE.png] [--json]
                      — QA the RENDER, not the draft: black inside the edit, a black open/tail, 1-2 frame
                        flashes, frozen picture past maxStatic, late first sound, dead air, loudness,
                        true peak, and (with --project) canvas, fps and length against the edit.
                        Exit 1 on FAIL. Every flagged moment is listed for export-grid --times.
  capcutctl reference --media REEL.mp4 [--project NAME] [--profile FILE] [--sheet FILE.png]
                      [--profile-out FILE] [--overwrite] [--cut-threshold 0.3] [--build-threshold 0.06] [--json]
                      — measure a reference reel in the gate's terms: cuts and in-shot builds per second
                        by section, first visual event, longest static stretch, median shot, speech ratio,
                        loudness; side by side with the profile (and the project with --project).
                        --profile-out writes the density override; --sheet the first frame of every shot.
  capcutctl review-video --media FINAL.mp4 [--project NAME] [--script FILE] [--speech FILE] [--model sonnet]
                   [--reset-rounds] [--json]
                      — Gemini (the free web app, in your signed-in Chrome via Claude in Chrome) watches the
                        export as a cold viewer and returns JSON. Discarded unless it quotes the first
                        sentence; every issue gets evidence frames in FINAL.review/round-N/. Two rounds per
                        edit (--project), then hand off. Exit 1 on blockers or a discarded review.
  capcutctl review-video --decide REVIEW.json --issue ID --verdict accept|reject --reason "one line"
                      — log the verdict on one Gemini issue after checking its evidence.
  capcutctl review --project NAME [--out DIR] [--id NAME] [--fps 6] [--width 240] [--max-minutes 0]
                      — write outputs/<id>/proxy.mp4, edl.json, and contact-sheet.png (never CapCut export).
                        --max-minutes N stops the proxy (exit 3, PREVIEW_TOO_SLOW) past N minutes; 0 = no budget.
  capcutctl new --project NAME [--media FILE] [--scenes 0:6,6:12,12:18]
                [--from TEMPLATE] [--blank] [--canvas 1080x1920] [--fps 30] [--dry-run] [--force-running]
                [--no-localize] [--generated] [--derived-from ORIGINAL [--derived-offset S]] [--allow-ephemeral]
                [--new-timeline-id] [--width W --height H --duration S]   (probe override when ffprobe is missing)
  capcutctl inspect --project NAME_OR_PATH [--root PATH] [--json]
  capcutctl doctor --project NAME_OR_PATH [--root PATH] [--json] [--fix [--dry-run] [--force-running] [--no-backup]]
                      — --fix repairs what a CapCut save did, before reporting: merges duplicate
                        material ids, restores capcutctl's metadata (capcutctl_origin, mograph
                        identity, provenance) from .capcutctl/meta-ledger.json and history, and
                        shortens B-roll that reads past its source. Never moves, re-levels or
                        re-creates anything the user edited or deleted.
  capcutctl snapshot --project NAME_OR_PATH [--label NAME]
  capcutctl history --project NAME_OR_PATH
  capcutctl alpha FILE… | --project NAME [--check] [--force] [--dry-run] [--force-running]
                      — premultiply ProRes alpha overlays in place. CapCut composites alpha as
                        premultiplied; a straight file paints its glow's hidden colour as a haze.
                        --project fixes every leaking overlay on the timeline; --check only measures.
  capcutctl notes --project NAME [--reject TEXT --why TEXT | --accept TEXT --why TEXT | --decide TEXT [--why TEXT]
                  | --todo TEXT | --done N] [--brief] [--json]
                      — the project's creative log: --reject a look and --why, --accept the look, --decide a
                        decision, --todo an outstanding note (--done N closes it). Kept in <project>/.capcutctl/notes.json, outside snapshots,
                        so it survives restore, compaction and new sessions. Read --brief first each round.
  capcutctl restore --project NAME_OR_PATH --snapshot NAME|LABEL [--force-running] [--no-backup]
                      — LABEL picks the newest snapshot named <timestamp>-LABEL (e.g. --snapshot pre-build).
  capcutctl sync --project NAME_OR_PATH [--dry-run] [--force-running] [--no-backup]
  capcutctl stage start   --project NAME [--dry-run]
  capcutctl stage status  --project NAME
  capcutctl stage commit  --project NAME [--dry-run] [--force-running] [--no-backup]
  capcutctl stage discard --project NAME [--dry-run]
                      — stage-and-swap for multi-step edits. start copies the draft outside CapCut's
                        drafts folder (and repairs it, as doctor --fix); every later command on
                        --project NAME edits that copy, with CapCut open. commit is the one step that
                        needs CapCut closed: an atomic swap-in with a snapshot and rollback. It
                        refuses (exit 5, STAGE_CONFLICT) if CapCut saved the live draft since start,
                        so those edits are never overwritten. Stages live in $CAPCUTCTL_STAGE_DIR
                        (default ~/.capcutctl/stage).
  capcutctl variant --project NAME --hooks hooks.json [--hook ID] | --src IN-OUT [--name NEW]
                    [--opening S] [--words FILE] [--lang ar] [--no-gate] [--dry-run] [--force-running] [--json]
                      — duplicate a signed-off project under a unique name with another hook: the face
                        source window IN-OUT replaces the opening (up to the first cut, or --opening S),
                        the body shifts, opening graphics / frames / scenes are re-timed, the hook's
                        words are captioned from --words (default: cut's cached transcript), and every
                        audio level is kept. Then the gate runs; exit 1 when it fails.
  capcutctl apply --project NAME_OR_PATH --spec FILE [--dry-run] [--force-running] [--no-backup]
  capcutctl add --project NAME --media FILE --at S --dur S --track NAME|N
                [--src S] [--src-dur S | --cover IN-OUT] [--volume 0] [--desc TEXT] [--no-localize]
                [--layer top|under-face]
                [--generated] [--derived-from ORIGINAL [--derived-offset S]] [--allow-ephemeral]
                [--width W --height H --media-duration S]   (probe override when ffprobe is missing)
                      — a new --track NAME goes under the face (the default, under-face): invisible until
                        a layout opens a window onto it, so the result says underPrincipal + the hint.
                        --layer top puts a new track over the face, below the mograph/caption lanes.
                        Reusing a track on the other side of the face with --layer refuses (TRACK_PLACEMENT).
  capcutctl replace-media --project NAME --file FILE --at S --track NAME|N | --segments ID[,ID...] [--all]
                (--media FILE is an alias for --file FILE; --all relinks every clip that shares the
                named clip's media, keeping each one's source window and keyframes)
                [--retime] [--no-localize] [--generated] [--derived-from ORIGINAL] [--allow-ephemeral]
                [--derived-offset S] [--width W --height H --media-duration S]
                (--derived-offset S: FILE starts S seconds into ORIGINAL, so the clip's source window
                and its keyframes move S earlier; a window starting before S refuses, SOURCE_BEFORE_START)
  capcutctl localize --project NAME   — copy outside videos into the project (fixes Link media)
  capcutctl trim --project NAME --at S --track NAME|N | --segments ID  --src IN-OUT (source seconds) | --start S --dur S [--retime]
                      — the new source window plays in the same slot, so speed follows. The talking-head
                        track stays 1x: a window of another length refuses (PRINCIPAL_TRACK); recut with
                        cut --keep, or --retime to keep the speed and resize the clip on the timeline.
  capcutctl shift --project NAME --at S --track NAME|N | --segments ID  --by SECONDS
  capcutctl split --project NAME --at S --segments ID | --track NAME|N [--dry-run]
                      — cut one clip in two at timeline second S (snapped to the frame grid). The
                        left half keeps the id; the output names leftId and rightId. Speed, extras,
                        transition (moves right), fades and intro/outro split cleanly; keyframed
                        clips are refused; S on an existing boundary changes nothing.
  capcutctl ripple --project NAME --from S --to S [--dry-run]
                      — delete a timeline range on every track and pull everything after it up
                        (dead air between words); clips keep their speed, the face stays 1x.
  capcutctl remove --project NAME --at S --track NAME|N | --segments ID[,ID...]
  capcutctl volume --project NAME --at S --track NAME|N | --segments ID[,ID...]  --level 0
  capcutctl fade --project NAME --at S --track NAME|N | --segments ID[,ID...]  [--in 0.08] [--out 0.12] [--plan]
  capcutctl sfx --project NAME --sound typing|click|enter|"PALETTE NAME" | --file PATH.wav --cues AT[:DUR[:SRC]],…
                [--volume 0.6] [--fade-in S] [--fade-out S] [--lead S] [--track sfx-keys] [--dry-run]
                      — named palette sound, or your own audio file (a WAV whoosh, a click, a voice
                        patch: copied into the draft, never an alpha-0 video), at explicit timeline
                        seconds; SRC starts inside a long bed, --lead moves every cue earlier.
                        Overlapping cues take the next free lane (sfx-keys, sfx-keys-2, …);
                        an exact repeat of a placed cue is skipped. Output lists tracks[].
  capcutctl keyframe --project NAME --at S --track NAME|N | --segments ID
                    [--from SCALE] [--to SCALE] [--hold 1.6] [--ramp 0.2] [--clear] [--plan]
                    [--focus X,Y,W,H] [--viewport X,Y,W,H] [--no-ease] [--ease] [--ease-position]
                    focus uses source pixels; viewport uses canvas pixels. Default: current scale ×1.15.
                    Camera moves are EASED BY DEFAULT: harvested FreeCurveInOut on ScaleX/ScaleY,
                    and on PositionX/Y wherever position keys are written (--focus, a split mask
                    holding its seam, a linked screen frame). --no-ease restores Line; --ease and
                    --ease-position are kept and now name the default. Scale and position curves
                    round-tripped in CapCut 9.4.0; check curveType, not just control objects.
  capcutctl animate  --project NAME --at S --track NAME|N | --segments ID[,ID...]
                    [--intro fade-in [--intro-dur S]] [--outro fade-out [--outro-dur S]]
                    [--replace-existing] [--plan] [--dry-run]
                    — attach CapCut-native editable clip animations through material_animations.
                      Starter catalogue: fade-in, flash-in, pulsing-zooms, scroll-up, stripe-merge,
                      zoom-out, fade-out, blur-out, smoke.
  capcutctl match   --project NAME --screen FILE [--face FILE] [--out shots.json]
                    [--min-margin 0.15] [--shots shots.json] [--apply] [--dry-run] [--json]
                    — sentence → moment matcher. Default writes nothing: emits a shot list
                      (JSON) with per-sentence source in/out, score breakdown, margin to the
                      runner-up, decision place|flag|none, and the add / layout screen /
                      pace / punch / ramp ops that would realise a place.
                      Intended loop: match → review flags → match --apply
                      (or hand-edit shots.json then match --apply --shots shots.json).
                      Weak matches stay on the face (flag/none) and are never placed wrong.
                      "No B-roll" is a valid answer.
  capcutctl verify-shots --project NAME [--shots shots.json] [--out DIR] [--json]
                    — blind before / action / after strip + SUPPORTED / CONTRADICTED /
                      INSUFFICIENT. A deterministic baseline runs in-process. prompt.md
                      per shot is for a fresh agent in the session (no API billing) to
                      second-guess from the strip alone. CONTRADICTED exits non-zero and
                      blocks the build; INSUFFICIENT flags only. Never writes the draft.
  capcutctl punch   --project NAME --on TEXT --segment ID|--at T|--word TEXT [--words FILE] [--track NAME|N] [--segments ID]
                    [--kind click|result] [--zoom 1.6] [--hold auto|S] [--ramp 0.2]
                    [--no-ease] [--ease] [--ease-position] [--plan] [--dry-run]
                    — name an on-screen element; the CLI locates it via OCR boxes and writes
                      a native camera move through the existing focus-rectangle path. The
                      model never outputs a coordinate. Click arrives 250 ms early and holds
                      through the reaction; a result settles first. Refuses a zoom above 2.0×
                      and a second punch-in before a return to wide. Time it with --at T
                      (timeline seconds) or --word "PHRASE" (the first kept place the talking
                      head says it, from its Whisper words or --words FILE), never both.
  capcutctl preview --project NAME --out preview.mp4 [--fps 6] [--from S] [--to S]
                    [--resolution 360x640|--native] [--no-cache] [--no-grade] [--max-minutes 15]
                      — lightweight streamed proxy; defaults to 360x640 and never writes
                        one PNG per frame. Use qa for bounded seam/pixel evidence.
                        Stops (exit 3, PREVIEW_TOO_SLOW) when it projects past --max-minutes
                        or no frame advances for 180s; --max-minutes 0 turns that off.
  capcutctl diff --project NAME --against NAME|--snapshot NAME|LABEL [--allow ID|track:NAME[,…]]
                      — what changed. --allow proves a scoped revision stayed in scope: every
                        change outside those segment ids / tracks is listed with both values
                        under scope.outOfScope, and the command exits 1.
  capcutctl harvest [--root PATH] [--projects A,B] [--out FILE] [--profile FILE] [--plan]
                      — catalogue real structures; --profile FILE writes a style-profile override measured from the drafts
  capcutctl init-spec [--output FILE]
  capcutctl contract [--json] [--markdown]     — the machine-readable command/option surface
                                                 the skills repo validates its docs against;
                                                 --markdown renders the generated skill reference
  capcutctl oracle capture --project NAME [--label SLUG] [--out DIR]
  capcutctl oracle diff --before DIR --after DIR [--baseline DIR] [--values] [--resource-noop ID[,ID…]] [--json]
                    — dev-only round-trip sanitation harness. JSON that parses can still
                      no-op in CapCut: 'capture' copies a WHOLE project directory (root,
                      Timelines/**, draft_meta_info.json, template-2.tmp and any cache the
                      app materialises), 'diff' classifies what a CapCut open/save did to it
                      as preserved | normalized | materialized-cache | pruned | reset |
                      authority-miss | resource-noop. Only the first three are success; it
                      exits non-zero otherwise. Neither writes into a draft, and neither
                      drives the CapCut UI — a human captures the directories. Run this on a
                      DISPOSABLE copy before claiming a new field is production-safe.
                      --values includes each record's before/after JSON, which is how the
                      shape of an unknown field gets read off a real CapCut write.
                      See docs/oracle.md.

  capcutctl scenes --project NAME_OR_PATH [--track N] [--transcript] [--name SUBSTR]
  capcutctl layout split-screen --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--no-overlay] [--dry-run]
  capcutctl layout circle       --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--no-overlay] [--dry-run]
  capcutctl layout full-face    --project NAME_OR_PATH --segments IDS|--at SECONDS [--track N] [--dry-run]
  capcutctl layout background   --project NAME_OR_PATH [--at SECONDS] [--include-template] [--dry-run]
  capcutctl layout broll        --project NAME_OR_PATH --at SECONDS --track N --row ROW [--scale S] [--no-seam]
  capcutctl layout screen       --project NAME_OR_PATH --at SECONDS --media FILE
                                [--dur S] [--src S] [--src-dur S] [--track NAME] [--no-localize] [--plan] [--dry-run]
                                [--width W --height H --media-duration S]
                                — add a centred rl2 screen recording through the layout.screen contract
  capcutctl brands              list known brands, their spoken aliases, and which have a logo
  capcutctl logo                --project NAME_OR_PATH --logo FILE[,FILE…]|DIR | --brand NAME[,NAME…] | --auto
                                [--at S[,S…]] [--name N[,N…]] [--scale] [--hold] [--pos x,y] [--words FILE]
                                [--track N] [--motion RECIPE] [--glow] [--plain] [--no-sfx] [--plan]
                                the artwork is the primitive: any image pops; --brand/--auto time
                                themselves off the transcript. Default entrance is the profile's
                                logo.reveal: the measured 0.13s pop with its pop cue. --glow is the
                                halo pop; --motion RECIPE (experimental native recipe) is opt-in.
  capcutctl captions            --project NAME_OR_PATH [--cues FILE.json] [--script FILE.txt]
                                [--track NAME|N] [--name ID] [--lang ar] [--replace] [--restyle]
                                [--reposition] [--clamp] [--dry-run]
                                generate Staging-style word cues from edited narration; insert editable text layers
                                --cues imports existing timeline-time cues; --dry-run without cues prints a plan
                                no paid caption service; native visual parity remains experimental
                                --restyle puts every existing caption word in the one house style (Changa
                                ExtraBold, size 28, white, black stroke); text, timing and position are kept
                                --replace swaps every existing caption layer (captions:*, SRT, CapCut
                                auto-captions) for the new words in one transaction; without it a second
                                caption layer refuses with CAPTION_CONFLICT. Redo captions with --replace,
                                not restore
                                --reposition re-derives positions after a layout change: only words on the
                                face move (split → the seam, 50; full face → 20, or the highest of 5–19 that
                                clears a punched-in face); keyframed words and words under a scene stay.
                                --clamp also trims a word that straddles a layout cut to the side holding
                                ≥70% of it (≥80ms left); without it such words are reported
  capcutctl motion list         list native recipes, accepted inputs, and limitations; no project needed
  capcutctl motion [RECIPE]    --project NAME_OR_PATH --text TEXT|--asset FILE|--logo FILE [--name ID]
                                [--at S] [--duration S] [--scale N] [--x N] [--y N] [--color HEX] [--accent HEX]
                                EXPERIMENTAL native recipes (Line keys, not visually accepted); prefer mograph.
                                RECIPE defaults to orbit-glow.
                                gradient, shimmer, spotlight, orbit-glow. Name defaults to RECIPE-AT.
                                --asset aliases --logo; gradient is text-only; image variants remain experimental
                                --dry-run validates without writing; creates editable layers, not an MP4
  capcutctl endcard             --project NAME_OR_PATH [--text Follow] [--at S] [--hold S] [--scale S] [--no-sfx]
  capcutctl ending              --project NAME_OR_PATH [--frame FILE.png|FILE.jpg] [--profile FILE] [--no-sfx] [--dry-run]
                                — append a deterministic 3-second avatar/dial/follow animation with sound.
                                  Opens on the edit's own last frame (or --frame); copy and face position
                                  come from profile ending; reruns replace it. build runs it when ending.auto.
  capcutctl ending              --out PATH.mov|PATH.mp4 [--frame FILE.png|FILE.jpg] [--profile FILE] [--no-sfx] [--dry-run]
                                — render the ending alone for review; no CapCut project needed.
  capcutctl zoom                --project NAME_OR_PATH --at S[,S...] | --auto | --stress
                                [--min-length 2.5] [--to 1.15] [--hold 1.6] [--track N] [--plan]
                                [--no-ease] [--ease] [--words FILE]
                                --stress: a small push (profile camera.stress) on the word hit hardest
                                (energy10 peak vs its sentence median), at most once per spacing
                                window. Full-face only; circle is refused; masked insets skip.
                                --auto (a push on every scene) is deprecated: it reads as clockwork.
  capcutctl wrap                --project NAME_OR_PATH [--words TRANSCRIPT.json] [--text Follow] [--only BRANDS]
                                [--zoom-at S[,S…]|--no-zoom] [--track N] [--glow] [--no-sfx] [--no-ease] [--plan]
                                — brand logos from what is said + the endcard, in one pass. Face pushes
                                are zoom --stress (or build); --zoom-at S places explicit ones.
  capcutctl build               --project NAME --edit edit.json [--dry-run] [--force] [--json]
                      — after A-roll sign-off, one edit plan becomes the finished project:
                        shots (once), layout auto, stress pushes, mograph graphics on their
                        words, logo pops (brand-chip when art is missing), endcard, motivated
                        seams, music aligned to the graphics, loudness, duck, then the gate.
                        Graphics anchor to SOURCE words, so a recut rebuilds exactly; an
                        unchanged plan on an unchanged cut is a no-op. Exit 1 when the gate fails.
                        Replaced graphics, pops and seam cues keep their hand-set volume and fade.
                        Loudness holds the mix true peak at or under profile sound.peak by
                        lowering levels (never raising music); stages.peakLimit lists the changes.
  capcutctl gate                --project NAME [--profile FILE] [--style NAME] [--record] [--json] [--xray DIR]
                                [--pause SECONDS] [--review REVIEW.json]
                      — the blocking ready-to-post check: hook, proof, longest static stretch,
                        crowding, template repeats, safe zones, graphics without a sound, seams.
                        Thresholds come from the profile; --style NAME applies that style's pace (build
                        passes edit.json's "style"). Exit 1 on FAIL; WARNs go in the hand-off.
                        Also: captions present on one layer, the follow ender on the last frame, length (warn).
                        --xray DIR folds an export X-ray in: its FAILs block, its UNKNOWNs warn, its NOTEs
                        (proxy-only) are listed without blocking, and the final
                        gates run on it: first word by 0.5s, no gap over 0.7s (--pause allows one), last word
                        not clipped, 1080x1920@30 with sound to the ender, -14 LUFS with no sudden steps.
                        --review folds a review-video log in: undecided or accepted Gemini blockers block.
  capcutctl profile show        [--profile FILE] [--json]   — the effective style profile (tokens, brand, styles, camera, sound, density, grammar);
                        bare "capcutctl profile" is the same
  capcutctl profile where       [--profile FILE]   — each layer in merge order (bundled → yours → --profile) and whether it exists
  capcutctl profile init        [--force] [--dry-run]   — write your own profile.json from the template into your user dir
                        (~/.config/capcutctl, or $CAPCUTCTL_PRESET_DIR). Your brand lives there, not in the repo.
  capcutctl mograph list        templates, their params and paired sound; no project needed
  capcutctl mograph preview     --template ID --params JSON|--params-file FILE --out SHEET.png [--times S,S] [--background IMG]
                      — frames on a dark canvas with the platform-UI zones tinted, for review.
  capcutctl mograph render      --template ID --params JSON|--params-file FILE --out PATH [--format prores|png-still|webm] [--scale 2]
                      — deterministic HTML/JS graphic → tight-bbox ProRes 4444 alpha clip (or a PNG hold frame).
  capcutctl mograph scenes      full-frame motion-design scenes (inserts, transitions, openers, name cards):
                                params, length in beats, hand-off; no project needed
  capcutctl mograph scene-preview --scene ID --params JSON|--params-file FILE --out SHEET.png [--times S,S] [--samples N]
                      — motion-blurred frames with the platform-UI zones outlined; lists unsafe text.
  capcutctl mograph scene-render --scene ID --params JSON|--params-file FILE --out PATH [--format prores|mp4]
                                [--samples N] [--workers N] [--allow-unsafe]
                      — full 1080×1920 clip with motion blur, grain and its synthesised sound:
                        ProRes 4444 + PCM (alpha where the scene reveals footage) or an H.264 mp4 to watch.
  capcutctl mograph add         --project NAME --template ID --params JSON|--params-file FILE --at S | --say WORDS [--occurrence N]
                                [--id ID] [--format prores|png-still] [--words FILE] [--no-sfx] [--allow-unsafe] [--dry-run]
                                [--scene ID] instead of --template places a full-frame scene with its own sound
                      — render into <project>/mograph/ and place it above the picture, with its sound,
                        on the exact canvas pixels the template drew. --say anchors to source words.
  capcutctl mograph rerender    --project NAME --id ID [--params JSON|--params-file FILE] [--dry-run]
                      — fix text or a value; timing, anchor, placement, volume and fades are kept.
  capcutctl pace                --project NAME_OR_PATH [--track N] [--max 100] [--min-gap 5.0]
                                no flags = print the plan; --auto applies it
                                --at T --speed X | --at T --cover IN-OUT for one clip
  capcutctl ramp                --project NAME --segment ID|--at T --speed 20 [--settle 0.5]
                                [--result-at T] [--reach-back 0] [--reach-forward 0] [--track N] [--dry-run]
                                — split a B-roll clip at the result (first change-index peak
                                  after a quiet stretch), pace the waiting half, leave the
                                  result at 1×. Faces never ramp. Never writes curve_speed.
                                  The wait never plays source before the in-point (minus
                                  --reach-back S) or source another clip of the file shows;
                                  short of source, the wait shortens and the result runs on
                                  at 1× past the out-point only within --reach-forward S;
                                  else the wait paces slower, else REACH_LIMITED names the
                                  span it needs.
  capcutctl polish              --project NAME_OR_PATH [--lead 0.14] [--track N] [--motivated] [--dry-run]
                                [--no-transitions] [--no-sfx] [--no-interactions]
                                transitions ride the principal (talking-head) track; it is sliced to fit
                      — his transitions + matching SFX. --motivated: only on picture
                        changes (B-roll shot or layout class), not every A-roll splice.
                        Also clicks every rectangle/arrow/circle callout (Enter / click / select).
                        rl2 click/typing events on the chopped B-roll (Mouse click / Typing).
                        --no-interactions skips that pass.
  capcutctl loudness            --project NAME [--target -14] [--segments ID[,ID...]] [--allow-boost] [--plan] [--measure] [--peak -1] [--peak-only]
                                — measure edited ranges and mix; match speech to −14 LUFS with peak headroom.
                                  SFX keep their placed level (never raised; --segments matches a named one).
                                  Parked parts-bin clips past the edit are skipped; volume keys (the duck) scale
                                  with their clip. --measure is read-only. --peak is the true-peak ceiling (dBTP): a mix still
                                  over it after the clip pass is limited by lowering the SFX/music around the
                                  voice, then the whole mix; the result's peakLimit lists every change.
                                  --peak-only skips the clip pass and only limits the current mix to --peak.
                                  Attenuation < 1.0 is round-tripped. A needed boost is
                                  VOLUME_BOOST_UNVERIFIED unless --allow-boost (UNVERIFIED).
                                  Music beds are never raised. Does not touch loudnesses.enable.
  capcutctl grade               --project NAME [--measure] [--plan] [--strength 1] [--samples 3]
                                [--apply] [--dry-run] [--target JSON] [--reference FILE] [--reference-at S]
                                [--set 'FILE:brightness=0.05,white=0.2'] [--reset [--source FILE]]
                                [--face-detail] [--sharpen 0.15] [--clarity 0.1] [--vignette 0]
                                [--layer NAME --set 'contrast=0.1,saturation=0.05' --from S --to S]
                                --layer creates/updates a shared native adjustment lane; --reset --layer removes it.
                                preserve colour by default; an explicit target/reference enables the approximate solver.
                                --reset removes CLI-owned grades (all sources unless --source is supplied).
                                --face-detail writes native sharpen/clarity/vignette on FACE clips only.
                                Verified in CapCut 9.4.0. Vignette is opt-in after native calibration.
  capcutctl timeline            --project NAME [--width 64] [--json]   — ASCII dump of the stacked timeline
  capcutctl finish              --project NAME [--plan] [--music] [--polish] [--regen]
                                [--volume 0.08] [--prompt TEXT] [--file FILE] [--hits S[,S...]] [--offset S] [--track N] [--width 64] [--json]
                                scorecard + ASCII. --plan is read-only. --music generates
                                a Lyria bed timed to picture changes and beat-aligned.
                                --polish runs motivated polish. Voice is never recut.
  capcutctl denoise --project NAME [--plan] [--dry-run]

  capcutctl blur-broll --project NAME --segment ID [--plan] [--dry-run]
                      — opt-in motion-compensated mix for muted B-roll already at ≥8x.
  capcutctl reframe --project NAME --segment ID | --auto [--plan] [--dry-run]
                      — on-device face camera path; masked/existing moves are excluded.
  capcutctl cursor --project NAME --segment ID | --auto [--style halo|polished] [--size 2.5] [--plan] [--dry-run]
                      polished: editable spring pointer + blue click ripples from cursor-free rl2 captures.
                      Apply screen-motion first, then cursor; rerun cursor after camera/cut changes.
  capcutctl screen-motion --project NAME --segment ID --regions FILE.json
                      [--zoom-in 0.65] [--zoom-out 0.7] [--connect-gap 1.5] [--glide 1]
                      [--replace] [--plan] [--dry-run]
                      regions: [{start,end,focus:[x,y,width,height]}], timeline seconds/source pixels.
                      Native eased camera: four poses per isolated zoom; connected targets glide without returning wide.
  capcutctl music               --project NAME [--plan] [--regen] [--volume 0.08] [--prompt TEXT] [--file FILE] [--hits S[,S...]] [--offset S] [--width 64] [--json]
                                --duck [--under-db 12] [--attack-ms 120] [--release-ms 380] [--min-gap-ms 450]
                                [--track N] [--words FILE] ducks an existing bed from speech indexes; --plan writes nothing.
                                supply a video-specific brief or local music; saved briefs survive later runs
                                --hits selects emphasis times; --offset overrides music shift (−0.4..0.4s).
                                --plan --json measures a local file and reports beats/alignment without writes.
  capcutctl layout auto         --project NAME_OR_PATH [--plan]   — split-screen where B-roll covers, full face where it does not
  capcutctl layout audit        --project NAME_OR_PATH            — what each clip is vs what it should be
  capcutctl layout list

Layouts are exact, measured geometry (presets/layouts.json) — not judgement:
  split-screen  subject fills the BOTTOM half from y=960, indigo bar on the seam
  circle        subject as the upper-left circular avatar, inside the white ring
  full-face     subject at scale 1, no mask — the whole picture
  background    deletes any blurred face copy and puts the clear room plate under every circle scene
  screen        a centred rl2 window recording inside the indigo frame (layout screen)

New projects clone "Preset 3" by default: leftover preset clips are parked 30s after
the talking head (a parts bin — do not delete them). Follow/CTA is written on the
talking head, never on that leftover. Use --blank for an empty timeline — it needs no
local draft, so it works on a machine that has never made one.

The origin contract — every frame stays editable in CapCut:
  Enforced by add, replace-media, layout screen, and new --media.
  Media is refused when its framing was baked in before import (a file exactly half the
  canvas is a crop, not a capture) or when it comes from a temp/scratchpad directory (the
  origin recorded in media-map.json would be a dead link). Crop, pan and zoom with
  "layout broll --row" / "layout screen" on the FULL-frame source instead — those write
  clip.scale + clip.transform, which the human can still drag.
    --generated              a rendered asset with no editable original (Remotion, AE)
    --derived-from ORIGINAL  you pre-processed anyway; record where the real source is
  "doctor" reports MEDIA_PREFRAMED / MEDIA_ORIGIN_LOST for projects built before this.

Portability — what is bundled and what is yours:
  The overlay artwork the built-in layouts need ships in assets/, so a fresh clone can run
  split-screen / circle / screen with no setup. The SFX and transition palette cannot: those
  are CapCut's own effect/music cache, minted on the machine where you downloaded the sound.
  polish SKIPS any sound that is not on this machine and names it, instead of writing a
  reference that fails validation. Bring your own with either:
    CAPCUTCTL_ASSET_DIR=DIR    overlay artwork, searched before the bundled assets/
    CAPCUTCTL_PRESET_DIR=DIR   your user dir (default ~/.config/capcutctl): profile.json, sfx.json,
                               brands.json, layouts.json; each file falls back to the bundled one
  ffmpeg and ffprobe are required (cut, qa, find, preview, music, review).
  Run "capcutctl preflight" to see all of it at once.

Safety defaults:
  • refuses writes while CapCut is running
  • snapshots before every committed transaction
  • applies semantic operations to root + active timeline independently
  • atomically synchronizes draft_info.json, .bak, and template-2.tmp
  • validates media, IDs, refs, timing, masks, and mirror drift
`;

const r2 = n => Math.round(n * 100) / 100;

/**
 * Flags that take no value, for every command at once. One list serves the whole CLI, so a
 * name in it is a boolean everywhere: if another command documents `--name VALUE`, the value
 * would be read as a positional and the flag silently set to true. test/cli-contract.test.mjs
 * scans HELP for `--flag VALUE` and fails on any such collision.
 */
export const BOOLEAN_FLAGS = Object.freeze(new Set([
  'json', 'dryRun', 'forceRunning', 'noBackup', 'help', 'noOverlay', 'blank', 'includeTemplate', 'newTimelineId',
  'transcript', 'noTransitions', 'noSeam', 'auto', 'plan', 'noSfx', 'noZoom', 'retime',
  'noLocalize', 'motivated', 'regen', 'music', 'polish', 'noInteractions', 'duck',
  'waitForClose', 'force', 'reindex', 'noRepair', 'inPlace',
  'generated', 'allowEphemeral', 'measure', 'apply', 'native', 'noCache', 'noGrade',
  'glow', 'plain', 'clear', 'reset', 'overwrite', 'ease', 'noEase', 'easePosition', 'stress', 'allowBoost', 'peakOnly', 'values',
  'faceDetail', 'replaceExisting', 'replace', 'record', 'allowUnsafe', 'markdown', 'brief', 'check', 'restyle',
  'reposition', 'clamp',
  'resetRounds', 'noReview', 'noGate', 'fix', 'all',
]));

/** Value flags that may repeat; each occurrence is kept, in order. */
const REPEAT_VALUE_KEYS = new Set(['trimBeat', 'recoverBeat', 'set', 'allow', 'pause']);

/**
 * Value flags whose repeat is a mistake rather than a list. `--segments A --segments B` used
 * to keep B alone and act on it as if A had never been named.
 */
const NO_REPEAT_KEYS = new Set(['segments']);

export function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    // `--key=value` is the same flag as `--key value`. Split on the FIRST '=' so a value may
    // itself contain one (`--recover-beat=3:out=0.8`).
    const equals = token.indexOf('=');
    const name = equals > 2 ? token.slice(0, equals) : token;
    const inline = equals > 2 ? token.slice(equals + 1) : null;
    const key = name.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (BOOLEAN_FLAGS.has(key)) {
      if (inline != null) {
        throw new CapcutError(`${name} takes no value; pass ${name} on its own.`, { code: 'FLAG_TAKES_NO_VALUE', exitCode: 2 });
      }
      result[key] = true;
      continue;
    }
    let value = inline;
    if (value == null) {
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new CapcutError(`Missing value for ${token}.`, { exitCode: 2 });
      value = argv[++i];
    }
    if (REPEAT_VALUE_KEYS.has(key)) {
      if (!Array.isArray(result[key])) result[key] = [];
      result[key].push(value);
    } else {
      if (NO_REPEAT_KEYS.has(key) && result[key] != null) {
        throw new CapcutError(`${name} was given twice; name every id once, comma-separated: ${name} A,B.`,
          { code: 'DUPLICATE_FLAG', exitCode: 2 });
      }
      result[key] = value;
    }
  }
  return result;
}

/**
 * The number behind `--key`, or `def` when the flag is absent. `Number('0,5')` is NaN, and a
 * NaN reached the draft as null (JSON has no NaN): a clip at volume null, a clip added at 0,
 * a default keyframe scale. So every numeric flag goes through here and fails loudly instead.
 */
export function num(args, key, { min, max, int = false, def, flag } = {}) {
  const raw = args?.[key];
  if (raw == null) return def;
  return parseNumber(raw, flag || flagName(key), { min, max, int });
}

/** A comma-separated list of numbers (`--at 3,9.5,12`); each item is checked like num(). */
export function nums(args, key, { min, max, int = false, def, flag } = {}) {
  const raw = args?.[key];
  if (raw == null) return def;
  const name = flag || flagName(key);
  const items = String(raw).split(',').map(item => item.trim());
  if (!items.length || items.some(item => item === '')) {
    throw new CapcutError(`${name} "${raw}" has an empty item; give numbers separated by commas, e.g. 3,9.5.`,
      { code: 'BAD_NUMBER', exitCode: 2 });
  }
  return items.map(item => parseNumber(item, name, { min, max, int, list: raw }));
}

const flagName = key => `--${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;

function parseNumber(raw, name, { min, max, int, list = null }) {
  const text = String(raw).trim();
  const value = text === '' ? NaN : Number(text);
  const quoted = list != null ? `"${text}" in ${name} "${list}"` : `${name} "${text}"`;
  if (!Number.isFinite(value)) {
    let hint = 'give a plain number';
    if (list == null && /^-?\d+,\d+$/.test(text)) hint = `use ${text.replace(',', '.')}`;
    else if (/^-?(\d+\.?\d*|\.\d+)\s*[a-z%]+$/i.test(text)) {
      const [figure] = text.match(/^-?(\d+\.?\d*|\.\d+)/);
      const unit = text.slice(figure.length).trim().toLowerCase();
      hint = unit === 'ms' ? `times are seconds: use ${Number(figure) / 1000}` : `drop the unit: use ${figure}`;
    }
    throw new CapcutError(`${quoted} is not a number; ${hint}.`, { code: 'BAD_NUMBER', exitCode: 2 });
  }
  if (int && !Number.isInteger(value)) {
    throw new CapcutError(`${quoted} must be a whole number.`, { code: 'BAD_NUMBER', exitCode: 2 });
  }
  if (min != null && value < min) throw new CapcutError(`${quoted} must be at least ${min}.`, { code: 'BAD_NUMBER', exitCode: 2 });
  if (max != null && value > max) throw new CapcutError(`${quoted} must be at most ${max}.`, { code: 'BAD_NUMBER', exitCode: 2 });
  return value;
}

/** `--segments A, B,,C` → ['A', 'B', 'C']. */
export function segmentIds(args) {
  if (args?.segments == null) return [];
  return String(args.segments).split(',').map(id => id.trim()).filter(Boolean);
}

/** One clip only: refuse a list instead of acting on its first id and ignoring the rest. */
function singleSegment(command, args) {
  const ids = segmentIds(args);
  if (ids.length > 1) {
    throw new CapcutError(`${command} acts on one clip; --segments named ${ids.length} (${ids.join(', ')}). `
      + `Run ${command} once per clip.`, { code: 'MULTIPLE_SEGMENTS', exitCode: 2 });
  }
  return ids[0] ?? null;
}

/** POSIX shell quoting for a command line we print for an agent to paste. */
export function shq(value) {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The first build never writes captions, so its gate always FAILs on `captions` and the exit
 * code 1 reads like a broken build. When that is the ONLY failure (and there is no caption
 * layer, not a double one), say the next command instead of leaving the agent to guess.
 * The exit code stays 1: the draft is not ready to post until the captions are on it.
 */
export function buildNextHint(gate, project) {
  if (!gate || gate.verdict !== 'FAIL' || !Array.isArray(gate.checks)) return null;
  const failing = gate.checks.filter(c => !c.ok && c.level === 'FAIL');
  if (failing.length !== 1 || failing[0].id !== 'captions' || !/^no captions\b/.test(String(failing[0].message || ''))) return null;
  return `next: capcutctl captions --project ${shq(project ?? 'NAME')}`;
}

/**
 * Where command output goes. A test that wants to read it must set this rather than
 * monkeypatching `process.stdout.write`: under Node 20's test runner that hook also carries the
 * runner's OWN binary reporting protocol, so a test capturing it got the protocol bytes mixed
 * into the JSON it was trying to parse — green on Node 24, `Unexpected token '\x0f'` on Node 20.
 */
let SINK = null;
export function setOutput(write) {
  const previous = SINK;
  SINK = write;
  return () => { SINK = previous; };
}
const emit = text => (SINK ? SINK(text) : process.stdout.write(text));

// Media probed from disk, or the --width/--height/--media-duration the caller supplied
// when the file cannot be probed (placeholders, offline media).
async function probeOrOverride(file, args) {
  const { probeMedia } = await import('./create.mjs');
  try {
    return probeMedia(path.resolve(file));
  } catch (error) {
    if (args.width && args.height && args.mediaDuration != null) {
      return { width: num(args, 'width', { min: 1, int: true }), height: num(args, 'height', { min: 1, int: true }),
        duration: Math.round(num(args, 'mediaDuration', { min: 0 }) * 1e6) };
    }
    throw error;
  }
}

// The media-origin contract every importing command shares.
function originOptions(args) {
  return {
    generated: Boolean(args.generated),
    derivedFrom: args.derivedFrom ? path.resolve(args.derivedFrom) : null,
    derivedOffset: num(args, 'derivedOffset', { def: null }),
    allowEphemeral: Boolean(args.allowEphemeral)
  };
}

// --plan prints what the operation would do; otherwise it runs as a one-operation transaction.
async function planOrApply(projectDir, name, op, args, options, loadPlanner) {
  if (args.plan) return print((await loadPlanner())(await loadWorking(projectDir), op, { projectDir }), true);
  return print(applySpec(projectDir, { version: 1, name, operations: [op] }, options), true);
}

/** --pause 12.3,40 (repeatable): timeline seconds of deliberate pauses the speech-gap gate allows. */
function pauseList(value) {
  return [value].flat().filter(v => v != null && v !== true).flatMap(v => String(v).split(',')).map(Number).filter(Number.isFinite);
}

function print(value, asJson = false) {
  if (asJson || typeof value !== 'string') emit(stableJson(value));
  else emit(`${value}\n`);
}

function printDoctor(report, asJson) {
  if (asJson) return print(report, true);
  const fix = report.repair;
  if (fix?.error) emit(`Repair failed [${fix.error.code}]: ${fix.error.message}\n`);
  else if (fix) {
    emit(`Repair${fix.dryRun ? ' (dry run)' : ''}: merged ${fix.merged} duplicate id(s), restored ${fix.restored} key(s), `
      + `clamped ${fix.clamped} clip(s)${fix.unclamped ? `, ${fix.unclamped} overrun(s) left for you (principal track)` : ''}`
      + `${fix.details?.unmerged?.length ? `, ${fix.details.unmerged.length} conflicting id(s) left for you` : ''}.\n`);
  }
  emit(`Project: ${report.project}\nActive timeline: ${report.activeTimelineId || 'root only'}\nErrors: ${report.errors}  Warnings: ${report.warnings}\n`);
  for (const item of report.issues) emit(`${item.level === 'error' ? 'ERROR' : 'WARN '} ${item.code}: ${item.message}\n`);
  if (!report.issues.length) emit('OK: no issues found.\n');
}

const EXAMPLE_SPEC = {
  version: 1,
  name: 'safe-capcut-edit',
  operations: [
    {
      op: 'segment.patch',
      selector: { id: 'SEGMENT-ID' },
      set: {
        clip: {
          scale: { x: 1, y: 1 },
          transform: { x: 0, y: 0 }
        }
      }
    },
    {
      op: 'mask.patch',
      segment: { id: 'SEGMENT-ID' },
      mask: { name: 'Circle' },
      set: { config: { feather: 0, expansion: 0 } }
    }
  ]
};

const HERE = path.dirname(fileURLToPath(import.meta.url));


/**
 * `--track` is a name or an index everywhere. `layout` parsed it with Number(), so the
 * `layout broll --track broll` line that `add` prints as the next step resolved to NaN and
 * matched nothing — and `add`'s primary form is the named one.
 */
async function loadWorking(projectDir, { withRestored = false } = {}) {
  // The ledger-restored copy: a CapCut save strips desc / capcutctl_* and every reader that
  // judges ownership (gate, the planners) would otherwise misread the draft.
  const working = loadWorkingDoc(projectDir);
  return withRestored ? working : working.doc;
}

const r3 = n => Math.round(n * 1000) / 1000;
const sigRules = sig => sig.sigPresets().rules;

/** The face's cached transcript: { file, offset } (offset: seconds into the indexed original). */
const findWhisperCache = async (doc, principalIndex = null, projectDir = null) =>
  (await import('./anchors.mjs')).findWords(doc, principalIndex, { projectDir });

async function trackIndex(projectDir, spec) {
  if (spec == null || spec === '') return null;
  if (/^\d+$/.test(String(spec))) return Number(spec);
  const doc = await loadWorking(projectDir);
  const index = (doc.tracks || []).findIndex(t => t.type === 'video' && t.name === String(spec));
  if (index < 0) {
    throw new CapcutError(`no video track named "${spec}". Run \`capcutctl inspect\` to list them.`,
      { code: 'TRACK_MISSING', exitCode: 2 });
  }
  return index;
}

export const FIELD_REPORT_OPERATIONS = Object.freeze({
  screenLayout: 'layout.screen',
  cutRecut: 'cut.recut',
});

/**
 * Builder B contract for `layout screen`. Core owns the native segment/material/frame
 * construction; the CLI owns validation, media probing, and the transactional spec.
 */
export function buildScreenLayoutSpec({
  media,
  at,
  duration,
  sourceStart = 0,
  sourceDuration = duration,
  width,
  height,
  mediaDuration,
  track = 'screen',
  localize = true,
} = {}) {
  if (!media) throw new CapcutError('layout screen requires --media FILE.', { exitCode: 2 });
  const target = Number(at);
  const dur = Number(duration);
  const src = Number(sourceStart);
  const srcDur = Number(sourceDuration);
  if (!Number.isFinite(target) || target < 0) throw new CapcutError('layout screen requires --at SECONDS >= 0.', { code: 'BAD_TIME', exitCode: 2 });
  if (!Number.isFinite(dur) || dur <= 0) throw new CapcutError('layout screen requires media with a positive duration.', { code: 'BAD_TIME', exitCode: 2 });
  if (!Number.isFinite(src) || src < 0 || !Number.isFinite(srcDur) || srcDur <= 0) {
    throw new CapcutError('layout screen has an invalid source window.', { code: 'BAD_SOURCE_WINDOW', exitCode: 2 });
  }
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (value != null && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
      throw new CapcutError(`layout screen has an invalid ${name}.`, { code: 'BAD_DIMENSIONS', exitCode: 2 });
    }
  }
  if (mediaDuration != null && (!Number.isFinite(Number(mediaDuration)) || Number(mediaDuration) <= 0)) {
    throw new CapcutError('layout screen has an invalid media duration.', { code: 'BAD_MEDIA_DURATION', exitCode: 2 });
  }
  if (width != null && height != null && Number(width) / Number(height) > 1) {
    // The indigo card is for portrait window captures; the op refuses too, this is earlier.
    throw new CapcutError(`layout screen: ${width}x${height} is a landscape capture; the indigo card is for portrait `
      + 'window captures (rl2 720x1050). Frame a landscape capture natively in the split instead: '
      + 'capcutctl layout broll --at SECONDS --track N --row R --scale S.',
      { code: 'SCREEN_NEEDS_PORTRAIT_WINDOW', exitCode: 2, details: { width: Number(width), height: Number(height) } });
  }
  if (mediaDuration != null && src + srcDur > Number(mediaDuration) / 1e6 + 1e-6) {
    throw new CapcutError('layout screen source window exceeds the probed media duration.', {
      code: 'BAD_SOURCE_WINDOW', exitCode: 2,
      details: { sourceStart: src, sourceDuration: srcDur, mediaDuration: Number(mediaDuration) / 1e6 }
    });
  }
  if (track == null || String(track).trim() === '') {
    throw new CapcutError('layout screen requires a destination track name.', { code: 'TRACK_REQUIRED', exitCode: 2 });
  }
  const operation = {
    op: FIELD_REPORT_OPERATIONS.screenLayout,
    contract: 'layout.screen.v1',
    media: path.resolve(media),
    at: target,
    duration: dur,
    src,
    srcDur,
    track,
    preset: 'screenRecording',
    frame: 'screen-frame',
    localize: Boolean(localize),
    ...(width != null ? { width: Number(width) } : {}),
    ...(height != null ? { height: Number(height) } : {}),
    ...(mediaDuration != null ? { mediaDuration: Number(mediaDuration) } : {}),
  };
  return { version: 1, name: 'layout-screen', operations: [operation] };
}

/**
 * Builder A/core contract for in-place A-roll recutting. `plan` is the normal arroll.py
 * plan, while `preserve` tells core to source-map anchored B-roll, layout, SFX, and music.
 */
export function buildCutRecutSpec({ projectDir, plan, planFile = null, media = null, force = false } = {}) {
  if (!projectDir) throw new CapcutError('cut --into requires a target project.', { exitCode: 2 });
  if (!plan || !Array.isArray(plan.timeline) || !plan.timeline.length) {
    throw new CapcutError('cut --into requires a non-empty arroll plan.', { code: 'CUT_PLAN_EMPTY', exitCode: 2 });
  }
  if (!media && !plan.media) {
    throw new CapcutError('cut --into requires the source media in the arroll plan.', { code: 'CUT_MEDIA_MISSING', exitCode: 2 });
  }
  const sourceMedia = path.resolve(media || plan.media);
  const operation = {
    op: FIELD_REPORT_OPERATIONS.cutRecut,
    contract: 'cut.recut.v1',
    into: path.resolve(projectDir),
    media: sourceMedia,
    plan: {
      media: sourceMedia,
      kept: plan.kept || [],
      ...(Array.isArray(plan.order) ? { order: plan.order } : {}),
      timeline: plan.timeline,
      duration: plan.duration,
      lint: plan.lint || [],
      ...(plan.source_token != null ? { source_token: plan.source_token } : {}),
      ...(plan.sourceToken != null ? { sourceToken: plan.sourceToken } : {}),
      ...(plan.editorial ? { editorial: plan.editorial } : {}),
      ...(plan.adjustments ? { adjustments: plan.adjustments } : {}),
      ...(plan.repairs ? { repairs: plan.repairs } : {}),
      ...(plan.fps != null ? { fps: plan.fps } : {}),
      ...(plan.blocking_lint ? { blocking_lint: plan.blocking_lint } : {}),
    },
    audioRamps: (plan.handoff?.operations || []).filter(item => item?.op === 'clip.fade'),
    preserve: ['broll', 'layout', 'sfx', 'music'],
    retimeAnchored: true,
    force: Boolean(force),
    ...(planFile ? { planFile: path.resolve(planFile) } : {}),
  };
  return { version: 1, name: 'cut-recut', operations: [operation] };
}

export function statusPayload(capcut = capcutStatus(), { project = null, waitForClose = false, close = null } = {}) {
  const state = capcut?.state || (capcut?.unknown ? 'unknown' : capcut?.running ? 'running' : 'closed');
  const running = state === 'running';
  const closed = state === 'closed';
  const unknown = state === 'unknown';
  const pids = Array.isArray(capcut?.pids) ? capcut.pids.map(String) : [];
  return {
    version: 1,
    state,
    running,
    closed,
    unknown,
    ...(capcut?.probeError ? { probeError: capcut.probeError } : {}),
    pids,
    processes: Array.isArray(capcut?.processes) ? capcut.processes : [],
    openDraft: capcut?.openDraft || null,
    openDraftInfo: capcut?.openDraftInfo || null,
    capcut: { state, running, closed, unknown, pids },
    waitForClose: Boolean(waitForClose),
    ...(project ? { project } : {}),
    ...(close ? { close } : {}),
  };
}

export function serializeCloseFailure(error) {
  const reason = error?.reason || error?.details?.reason;
  return {
    code: error?.code || 'CAPCUT_CLOSE_FAILED',
    exitCode: error?.exitCode ?? 2,
    message: error?.message || String(error),
    ...(reason ? { reason } : {}),
    ...(error?.details != null ? { details: error.details } : {}),
  };
}

function statusText(payload) {
  const pids = payload.pids.length ? ` (PID ${payload.pids.join(', ')})` : '';
  const line = `CapCut: ${payload.state}${pids}`;
  if (payload.closeFailure) return `${line}\nclose failed [${payload.closeFailure.code}]: ${payload.closeFailure.message}`;
  if (payload.waitForClose) return `${line}\nwait-for-close: ${payload.closed ? 'closed' : 'still running'}`;
  return line;
}

// Keep the Python handoff deliberately explicit. These are the only arroll.py options that
// belong to the analysis/plan step; --into/--in-place/--root and transaction-only flags stay
// in this Node process and must never leak into argparse.
const ARROLL_VALUE_OPTIONS = Object.freeze([
  ['keep', '--keep'],
  ['drop', '--drop'],
  ['order', '--order'],
  ['review', '--review'],
  ['trimBeat', '--trim-beat'],
  ['recoverBeat', '--recover-beat'],
  ['lang', '--lang'],
  ['model', '--model'],
  ['fps', '--fps'],
]);
const ARROLL_BOOLEAN_OPTIONS = Object.freeze([
  ['reindex', '--reindex'],
  ['noRepair', '--no-repair'],
  ['force', '--force'],
  ['dryRun', '--dry-run'],
]);

export function buildArrollArgs(args, media) {
  const forwarded = [String(media)];
  for (const [key, flag] of ARROLL_VALUE_OPTIONS) {
    if (Array.isArray(args?.[key])) {
      for (const value of args[key]) forwarded.push(flag, String(value));
    } else if (args?.[key] != null) {
      forwarded.push(flag, String(args[key]));
    }
  }
  for (const [key, flag] of ARROLL_BOOLEAN_OPTIONS) {
    if (args?.[key]) forwarded.push(flag);
  }
  return forwarded;
}

/**
 * The environment every Python tool runs in. aroll.py calls capcutctl back (`new`, `apply`);
 * these name THIS checkout's node and bin, so it never reaches a different capcutctl on PATH.
 */
export function toolEnv(extra = {}) {
  return {
    ...process.env,
    CAPCUTCTL_NODE: process.execPath,
    CAPCUTCTL_BIN: path.join(HERE, '..', 'bin', 'capcutctl.mjs'),
    ...extra,
  };
}

/**
 * The spoken-CTA role patterns `cut` checks (profile `ending.ctaPatterns`), as the JSON array
 * aroll.py reads from CAPCUTCTL_CTA_PATTERNS. A profile that cannot be read costs the CTA
 * warning, never the cut, so this returns no variable rather than throwing.
 */
export function ctaPatternEnv() {
  let patterns;
  try { patterns = profileValue('ending.ctaPatterns', []); } catch { return {}; }
  if (!Array.isArray(patterns)) return {};
  const strings = patterns.filter(value => typeof value === 'string' && value);
  return strings.length ? { CAPCUTCTL_CTA_PATTERNS: JSON.stringify(strings) } : {};
}

/**
 * The edit range a Python reader must use, as `CAPCUTCTL_CONTENT_RANGE_US=start,end`. Node is
 * the only source of it: created.json's `contentEnd` is a write-time snapshot, so a preview
 * read from it cut the CTA after a later edit, or rendered dead parked material.
 */
export function contentRangeEnv(projectDir) {
  try {
    const doc = loadWorkingDoc(projectDir).doc;
    const end = contentEndUs(doc, projectDir);
    if (!(end > 0)) return {};
    const parked = preservedRange(projectDir);
    const recorded = Number(createdMetadata(projectDir)?.contentStart);
    let start = Number.isFinite(recorded) ? recorded : Infinity;
    if (!Number.isFinite(recorded)) {
      for (const { track, segment } of allSegments(doc)) {
        const tt = segment.target_timerange;
        if (track.type !== 'video' || !(tt?.duration > 0)) continue;
        if (parked && tt.start >= parked.start) continue;
        start = Math.min(start, tt.start);
      }
    }
    if (!Number.isFinite(start)) start = 0;
    return { CAPCUTCTL_CONTENT_RANGE_US: `${Math.max(0, Math.min(start, end))},${end}` };
  } catch {
    return {};                                   // no readable project: the tool reports it
  }
}

/** A value flag in a raw argv (`--flag X` or `--flag=X`), or null. */
function rawValueArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? null;
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return null;
}
const rawProjectArg = argv => rawValueArg(argv, '--project');

function runPython(interpreter, script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, [script, ...args], { stdio: 'inherit', env: toolEnv(env) });
    const forward = signal => { if (child.exitCode == null && child.signalCode == null) child.kill(signal); };
    const onInt = () => forward('SIGINT');
    const onTerm = () => forward('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
}

/** Levenshtein distance, for "did you mean". Inputs are short command and flag names. */
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const here = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = here;
    }
  }
  return row[b.length];
}

/** Candidates within two edits, or sharing a prefix/substring, nearest first. */
function nearest(word, candidates, limit = 3) {
  const w = String(word).toLowerCase();
  return candidates
    .map(name => ({ name, d: editDistance(w, name.toLowerCase()) }))
    .filter(({ name, d }) => d <= 2 || (w.length >= 3 && (name.startsWith(w) || name.includes(w) || w.includes(name))))
    .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name);
}

/** Words agents reach for that are another command's name here. */
const COMMAND_ALIASES = Object.freeze({ list: ['projects'], ls: ['projects'], tracks: ['inspect', 'timeline'] });

/**
 * A short, pointed refusal. It used to append the whole 37 KB HELP and suggest nothing, which
 * costs an agent its context and still leaves it guessing.
 */
export async function unknownCommandError(command) {
  const { buildContract } = await import('./contract.mjs');
  const names = Object.keys(buildContract().commands);
  const guesses = [...new Set([...(COMMAND_ALIASES[command] || []), ...nearest(command, names)])];
  const hint = guesses.length ? ` Did you mean: ${guesses.join(', ')}?` : '';
  return new CapcutError(`Unknown command: ${command}.${hint} Run \`capcutctl help\`.`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function unknownOptionError(command, key, options) {
  const flag = `--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
  const guesses = nearest(flag.slice(2), options.map(option => option.slice(2))).map(name => `--${name}`);
  const hint = guesses.length ? ` Did you mean ${guesses.join(' or ')}?` : '';
  return new CapcutError(`Unknown ${command} option: ${flag}.${hint} ${command} takes: ${options.join(' ')}.`,
    { code: 'UNKNOWN_OPTION', exitCode: 2 });
}

async function validateOptions(command, args) {
  const { buildContract } = await import('./contract.mjs');
  const commands = buildContract().commands;
  if (!Object.hasOwn(commands, command)) return;
  const entry = commands[command];
  const allowed = new Set(['_', 'root', 'project', 'json', 'help',
    ...entry.options.map(flag => flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())),
    ...(entry.transactional || command === 'cut' ? ['forceRunning', 'noBackup', 'label'] : []),
  ]);
  const unknown = Object.keys(args).find(key => !allowed.has(key));
  if (unknown) throw unknownOptionError(command, unknown, entry.options);
}

/**
 * Names agents guess for `notes` flags. The log's sections are called decisions and
 * outstanding, so --decision and --outstanding (or --add) are the natural misreadings.
 */
const NOTES_ALIASES = Object.freeze({ decision: 'decide', outstanding: 'todo', add: 'todo' });

function applyNotesAliases(args) {
  for (const [alias, key] of Object.entries(NOTES_ALIASES)) {
    if (args[alias] == null) continue;
    if (args[key] != null) {
      throw new CapcutError(`notes --${alias} is --${key}; pass one of them.`, { code: 'NOTES_ARGS', exitCode: 2 });
    }
    args[key] = args[alias];
    delete args[alias];
  }
}

/** `cut` recuts an existing project in place when it names one: --into P, --into=P or --in-place. */
export function isInPlaceCut(argv) {
  return argv.some(token => token === '--into' || token.startsWith('--into=') || token === '--in-place');
}

/**
 * Whether a cut invocation carries an editorial decision, i.e. whether it is the second,
 * applying run rather than the first run's review handout. --recover-beat is a decision too:
 * leaving it out meant `cut --into P --recover-beat 3:out=0.8` printed a table and applied nothing.
 */
export function hasEditorialDecision(args) {
  const listed = key => Array.isArray(args?.[key]) ? args[key].length > 0 : Boolean(args?.[key]);
  return Boolean(args?.keep || args?.drop || args?.order || args?.review || listed('trimBeat') || listed('recoverBeat'));
}

async function runInPlaceCut(args, root, apply = applySpec) {
  if (args.inPlace) {
    if (args.into) throw new CapcutError('cut accepts either --into PROJECT or --in-place, not both.', { code: 'CUT_TARGET_CONFLICT', exitCode: 2 });
    args.into = '.';
  }
  if (!args.into) throw new CapcutError('cut --into requires PROJECT.', { code: 'MISSING_PROJECT', exitCode: 2 });
  if (args.project) throw new CapcutError('cut accepts either --project (new build) or --into (in-place recut), not both.', { code: 'CUT_TARGET_CONFLICT', exitCode: 2 });
  const media = args._[1];
  if (!media) throw new CapcutError('cut requires VIDEO.', { exitCode: 2 });
  const projectDir = resolveProject(args.into, root);
  const script = path.join(HERE, '..', 'tools', 'aroll.py');
  const forwarded = buildArrollArgs(args, media);
  const python = pythonForTool('aroll.py');
  const run = spawnSync(python.executable, [script, ...forwarded], { stdio: 'inherit', env: toolEnv({ CAPCUTCTL_IN_PLACE_CUT: '1', ...ctaPatternEnv() }) });
  if (run.error) throw new CapcutError(`could not run ${script}: ${run.error.message}`, { exitCode: 2 });
  if ((run.status ?? 1) !== 0) { process.exitCode = run.status ?? 1; return null; }

  // The first invocation without a decision is intentionally still the review handout.
  // This preserves the two-stage talking-head decision before any in-place mutation.
  if (!hasEditorialDecision(args)) {
    process.stderr.write('review handout only, nothing applied (pass --keep/--drop/--order/--review/--trim-beat/--recover-beat)\n');
    return null;
  }
  const mediaPath = path.resolve(media);
  const planPath = path.join(path.dirname(mediaPath), `${path.basename(mediaPath).replace(/\.[^.]+$/, '')}.plan.json`);
  if (!fs.existsSync(planPath)) {
    throw new CapcutError(`aroll.py did not write its plan: ${planPath}`, { code: 'CUT_PLAN_MISSING', exitCode: 2 });
  }
  const plan = readJson(planPath);
  const spec = buildCutRecutSpec({
    projectDir,
    plan,
    planFile: planPath,
    media: mediaPath,
    force: Boolean(args.force),
  });
  return print({ plan: planPath, result: apply(projectDir, spec, {
    dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning),
    backup: !args.noBackup, label: 'cut-recut'
  }) }, true);
}

function mographParams(args) {
  if (args.params && args.paramsFile) throw new CapcutError('Use --params JSON or --params-file FILE, not both.', { code: 'MOGRAPH_PARAM', exitCode: 2 });
  if (args.paramsFile) return readJson(path.resolve(args.paramsFile));
  if (!args.params) return {};
  try { return JSON.parse(args.params); }
  catch (error) { throw new CapcutError(`--params is not JSON: ${error.message}`, { code: 'MOGRAPH_PARAM', exitCode: 2 }); }
}

export async function main(argv, dependencies = {}) {
  loadEnv();
  const command = argv[0];
  if (command === '--version' || command === 'version') {
    return print(readJson(path.join(HERE, '..', 'package.json')).version);
  }
  if (command === 'cut' && isInPlaceCut(argv)) {
    const cutArgs = parseArgs(argv);
    await validateOptions(command, cutArgs);
    const cutRoot = cutArgs.root ? path.resolve(cutArgs.root) : DEFAULT_ROOT;
    return runInPlaceCut(cutArgs, cutRoot, dependencies.applySpec || applySpec);
  }
  if (command === 'cut' || command === 'qa' || command === 'find' || command === 'xray') {
    const tool = { cut: 'aroll.py', qa: 'frame_qa.py', find: 'find.py', xray: 'xray.py' }[command];
    const script = path.join(HERE, '..', 'tools', tool);
    // Resolve and verify the interpreter first. A missing runtime is a named CapcutError
    // with an install line, never a ModuleNotFoundError traceback from a child process.
    // The argv goes in because some requirements are flag-triggered: find.py only imports
    // frame_qa, and so only needs NumPy and Pillow, when --strip asks for a contact sheet.
    const python = pythonForTool(tool, { argv: argv.slice(1) });
    // qa and X-ray read the edit range off the draft; hand them the live one.
    let rangeEnv = command === 'cut' ? ctaPatternEnv() : {};
    const projectArg = (command === 'qa' || command === 'xray') ? rawProjectArg(argv) : null;
    if (projectArg && !argv.includes('--help') && !argv.includes('-h')) {
      const rawRoot = rawValueArg(argv, '--root');
      try { rangeEnv = contentRangeEnv(resolveProject(projectArg, rawRoot ? path.resolve(rawRoot) : DEFAULT_ROOT)); }
      catch { rangeEnv = {}; }
    }
    let status;
    try { status = await runPython(python.executable, script, argv.slice(1), rangeEnv); }
    catch (error) { throw new CapcutError(`could not run ${script}: ${error.message}`, { exitCode: 2 }); }
    process.exitCode = status;
    return;
  }
  const args = parseArgs(argv);
  if (!command || command === 'help' || command === '--help') return print(HELP);
  if (args.help) {
    // `capcutctl notes --help` is a question about notes, not about all 60 commands.
    const { commandHelp } = await import('./contract.mjs');
    const slice = commandHelp(command);
    if (!slice) throw await unknownCommandError(command);
    return emit(slice);
  }
  if (command === 'notes') applyNotesAliases(args);
  await validateOptions(command, args);
  const root = args.root ? path.resolve(args.root) : DEFAULT_ROOT;

  if (command === 'profile') {
    const { loadProfile, profileLayers, initUserProfile, userDir } = await import('./profile.mjs');
    const sub = args._[1] || 'show';
    if (sub === 'show') return print(loadProfile({ file: args.profile || null }), true);
    if (sub === 'where') return print({ userDir: userDir(), layers: profileLayers({ file: args.profile || null }) }, true);
    if (sub === 'init') return print(initUserProfile({ force: !!args.force, dryRun: !!args.dryRun }), true);
    throw new CapcutError(`Unknown profile subcommand: ${sub}. Use show, where or init.`, { code: 'UNKNOWN_SUBCOMMAND', exitCode: 2 });
  }
  if (command === 'ending') {
    const { runEnding } = await import('./ending.mjs');
    if (args.project && args.out) throw new CapcutError('ending takes --project or --out, not both.', { code: 'ENDING_TARGET', exitCode: 2 });
    if (!args.project && !args.out) throw new CapcutError('ending needs --project NAME or --out PATH.mov|PATH.mp4.', { code: 'ENDING_TARGET', exitCode: 2 });
    const endingDir = args.project ? resolveProject(args.project, root) : null;
    if (isStageDir(endingDir)) args.forceRunning = true;
    return print(await runEnding(endingDir, {
      frame: args.frame, profileFile: args.profile, out: args.out, noSfx: Boolean(args.noSfx),
      dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning), backup: !args.noBackup,
    }), true);
  }
  if (command === 'mograph' && ['scenes', 'scene-preview', 'scene-render'].includes(args._[1])) {
    const scenes = await import('./mograph-scene.mjs');
    const sub = args._[1];
    if (sub === 'scenes') {
      return print({ scenes: scenes.listScenes(), formats: scenes.SCENE_FORMATS, contract: 'mograph/scenes/runtime.js',
        importVerified: false }, true);
    }
    if (!args.scene) throw new CapcutError(`mograph ${sub} needs --scene ID (see mograph scenes).`, { code: 'SCENE_ID', exitCode: 2 });
    if (!args.out) throw new CapcutError(`mograph ${sub} needs --out PATH.`, { code: 'SCENE_OUT', exitCode: 2 });
    const params = mographParams(args);
    if (sub === 'scene-preview') {
      return print(await scenes.previewScene({ scene: args.scene, params, out: path.resolve(args.out),
        times: args.times ? String(args.times).split(',').map(Number) : null,
        ...(args.samples ? { samples: Number(args.samples) } : {}) }), true);
    }
    const out = path.resolve(args.out).replace(/\.(mov|mp4)$/i, '');
    return print(await scenes.renderScene({ scene: args.scene, params, out, format: args.format || 'prores',
      samples: args.samples ? Number(args.samples) : null, workers: args.workers ? Number(args.workers) : null,
      allowUnsafe: Boolean(args.allowUnsafe) }), true);
  }
  if (command === 'mograph' && ['list', 'render', 'preview'].includes(args._[1])) {
    const mograph = await import('./mograph.mjs');
    const sub = args._[1];
    if (sub === 'list') {
      return print({ templates: mograph.listTemplates(), formats: mograph.FORMATS,
        importVerified: mograph.IMPORT_VERIFIED, contract: 'mograph/runtime.js' }, true);
    }
    if (!args.template) throw new CapcutError(`mograph ${sub} needs --template ID (see mograph list).`, { code: 'MOGRAPH_TEMPLATE', exitCode: 2 });
    if (!args.out) throw new CapcutError(`mograph ${sub} needs --out PATH.`, { code: 'MOGRAPH_OUT', exitCode: 2 });
    const params = mographParams(args);
    if (sub === 'preview') {
      return print(await mograph.previewSheet({ template: args.template, params, out: path.resolve(args.out),
        times: args.times ? String(args.times).split(',').map(Number) : null,
        background: args.background || null }), true);
    }
    const out = path.resolve(args.out).replace(/\.(mov|png|webm)$/i, '');
    return print(await mograph.renderMograph({ template: args.template, params, out,
      format: args.format || 'prores', scale: args.scale ? Number(args.scale) : 1 }), true);
  }
  if (command === 'motion' && args._[1] === 'list') {
    const { MOTION_RECIPES } = await import('./motion.mjs');
    return print({ recipes: MOTION_RECIPES.map(name => ({
      name, inputs: name === 'gradient' ? ['text'] : ['text', 'asset'],
      native: true, imageVariantsExperimental: name !== 'gradient',
      note: name === 'shimmer' ? 'Text sweep; logo brightening is not implemented.'
        : name === 'spotlight' ? 'Traveling circle mask; uses Blur, not tutorial text glow.'
        : name === 'gradient' ? 'Static two-color text treatment.' : 'Rotating masked blurred underlay.',
    })), creates: 'editable CapCut layers; no automatic export' }, true);
  }
  if (command === 'oracle') {
    // Dev-only and non-transactional: `capture` copies a project tree somewhere else and
    // `diff` only reads. Neither goes through applySpec, because neither edits a draft.
    const oracle = await import('./oracle.mjs');
    const sub = args._[1];
    if (sub === 'capture') {
      const projectDir = resolveProject(args.project, root);
      return print(oracle.captureProject(projectDir, { out: args.out, label: args.label || 'capture' }), true);
    }
    if (sub === 'diff') {
      if (!args.before || !args.after) {
        throw new CapcutError('oracle diff requires --before DIR --after DIR.', { code: 'ORACLE_ARGS', exitCode: 2 });
      }
      const report = oracle.diffCaptures({
        before: args.before, after: args.after, baseline: args.baseline || null,
        resourceNoop: args.resourceNoop ? String(args.resourceNoop).split(',').map(s => s.trim()).filter(Boolean) : [],
        values: Boolean(args.values),
      });
      // A pruned / reset / authority-miss / resource-noop record is not a passing round
      // trip, and the exit code has to say so or the harness is decoration.
      if (!report.ok) process.exitCode = 1;
      return print(report, true);
    }
    throw new CapcutError('oracle takes `capture` or `diff`.', { code: 'ORACLE_ARGS', exitCode: 2 });
  }

  if (command === 'layout' && args._[1] === 'list') {
    const { presets } = await import('./layouts.mjs');
    const p = presets();
    const rows = Object.entries(p.layouts).map(([name, l]) => ({ name, description: l.description }))
      .concat([{ name: 'background', description: p.background.description }]);
    // The row is named as `capcutctl layout <name>` accepts it; the preset key is screenRecording.
    if (p.screenRecording) rows.push({ name: 'screen', preset: 'screenRecording', description: p.screenRecording.description });
    return print(rows, true);
  }
  if (command === 'contract') {
    // The machine-readable command/option surface, for the skills repository and anything
    // else that documents this CLI. Always JSON: it exists to be parsed, not read.
    const { buildContract } = await import('./contract.mjs');
    const pkg = readJson(path.join(HERE, '..', 'package.json'));
    const contract = buildContract({ version: pkg.version });
    if (args.markdown) {
      const { renderReference } = await import('./command-docs.mjs');
      return print(renderReference(contract));
    }
    return print(contract, true);
  }
  if (command === 'harvest') {
    const { harvestDrafts, writeHarvest, DEFAULT_HARVEST } = await import('./harvest.mjs');
    const names = args.projects ? String(args.projects).split(',').map(s => s.trim()).filter(Boolean) : undefined;
    if (args.profile) {
      const { profileFromDrafts } = await import('./harvest.mjs');
      const profile = profileFromDrafts(root, names);
      if (!args.plan) {
        const dest = path.resolve(args.profile);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, stableJson(profile));
        return print({ wrote: dest, profile }, true);
      }
      return print({ wrote: null, profile }, true);
    }
    const catalogue = harvestDrafts(root, names);
    const dest = args.out ? path.resolve(args.out) : DEFAULT_HARVEST;
    if (!args.plan) writeHarvest(catalogue, dest);
    return print({ wrote: args.plan ? null : dest, ...catalogue }, true);
  }
  if (command === 'brands') {
    const { brandPresets } = await import('./signature.mjs');
    const rows = Object.entries(brandPresets().brands).map(([name, b]) => ({
      brand: name, aliases: b.aliases,
      logo: b.logo || null, usable: Boolean(b.logo && fs.existsSync(b.logo)),
    }));
    return print({ usable: rows.filter(r => r.usable).map(r => r.brand),
                   needsATransparentPng: rows.filter(r => !r.usable).map(r => r.brand),
                   brands: rows }, true);
  }
  if (command === 'close') {
    try {
      return print(closeCapcut({ timeoutMs: args.timeout ? Number(args.timeout) : 25000 }), true);
    } catch (error) {
      if (!args.json) throw error;
      const payload = statusPayload(capcutStatus({ root }), { waitForClose: true });
      payload.closeFailure = serializeCloseFailure(error);
      payload.ok = false;
      process.exitCode = payload.closeFailure.exitCode;
      return print(payload, true);
    }
  }
  if (command === 'status') {
    const unknown = Object.keys(args).find(key => !['_', 'root', 'project', 'json', 'waitForClose', 'timeout'].includes(key));
    if (unknown) throw new CapcutError(`Unknown status option: --${unknown}.`, { exitCode: 2 });
    if (args._.length !== 1) throw new CapcutError('status does not take positional arguments.', { exitCode: 2 });
    let timeoutMs = 25000;
    if (args.timeout != null) {
      timeoutMs = Number(args.timeout);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new CapcutError('status --timeout requires a non-negative number of milliseconds.', { exitCode: 2 });
      }
      if (!args.waitForClose) throw new CapcutError('status --timeout requires --wait-for-close.', { exitCode: 2 });
    }
    let project = null;
    if (args.project) project = resolveProject(args.project, root);
    let close = null;
    let failure = null;
    if (args.waitForClose) {
      try {
        close = closeCapcut({ timeoutMs });
      } catch (error) {
        failure = serializeCloseFailure(error);
      }
    }
    const payload = statusPayload(capcutStatus({ root }), { project, waitForClose: Boolean(args.waitForClose), close });
    if (failure) {
      payload.ok = false;
      payload.closeFailure = failure;
      process.exitCode = failure.exitCode;
    } else if (payload.unknown) {
      payload.ok = false;
      process.exitCode = 3;
    } else {
      payload.ok = true;
    }
    return args.json || args.waitForClose ? print(payload, true) : print(statusText(payload));
  }
  if (command === 'export-grid') {
    if (!args.media || !args.out) throw new CapcutError('export-grid requires --media FILE --out GRID.png', { exitCode: 2 });
    const { exportGrid } = await import('./export.mjs');
    return print(exportGrid(args.media, args.out, args.times), true);
  }
  if (command === 'check-export' || command === 'reference') {
    if (!args.media) throw new CapcutError(`${command} requires --media FILE.`, { exitCode: 2 });
    const media = path.resolve(args.media);
    if (!fs.existsSync(media)) throw new CapcutError(`no such media: ${media}`, { code: 'MEDIA_MISSING', exitCode: 2 });
    const check = await import('./media-check.mjs');
    const { loadProfile } = await import('./profile.mjs');
    const profile = loadProfile({ file: args.profile || null });
    const projectDir = args.project ? resolveProject(args.project, root) : null;
    const number = (key, flag) => {
      if (args[key] == null) return null;
      const value = Number(args[key]);
      if (!Number.isFinite(value)) throw new CapcutError(`${flag} must be a number.`, { exitCode: 2 });
      return value;
    };
    if (command === 'check-export') {
      const scan = check.scanMedia(media, { sheet: args.sheet || null });
      const report = check.checkExportReport(scan, {
        profile, expected: await check.expectedDelivery(projectDir, profile),
        target: number('target', '--target'), peak: number('peak', '--peak'), project: args.project || null,
      });
      if (!report.ok) process.exitCode = 1;
      return args.json ? print(report, true) : print(check.checkExportText(report));
    }
    if (args.profileOut && fs.existsSync(path.resolve(args.profileOut)) && !args.overwrite) {
      throw new CapcutError(`${path.resolve(args.profileOut)} exists; pass --overwrite to replace it.`, { code: 'REFERENCE_EXISTS', exitCode: 2 });
    }
    const scan = check.scanMedia(media, {
      sheet: args.sheet || null,
      cutThreshold: number('cutThreshold', '--cut-threshold'),
      buildThreshold: number('buildThreshold', '--build-threshold'),
    });
    const report = check.referenceReport(scan, {
      profile, project: projectDir ? await check.projectPacing(projectDir, profile) : null,
    });
    if (args.profileOut) {
      if (!report.override) throw new CapcutError('no visual events were detected, so there is no density to write.', { code: 'REFERENCE_EMPTY', exitCode: 2 });
      const out = path.resolve(args.profileOut);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, stableJson(report.override));
      report.profileOut = out;
    }
    return print(report, true);
  }
  if (command === 'export') {
    if (!args.project) throw new CapcutError('export requires --project NAME', { exitCode: 2 });
    const { exportProject } = await import('./export.mjs');
    const liveDir = resolveProject(args.project, root, { live: true });
    const { activeStage } = await import('./core.mjs');
    if (activeStage(liveDir)) {
      throw new CapcutError('This project has an active stage: CapCut would export the draft without its staged edits. '
        + 'Run `capcutctl stage commit --project NAME` (or discard) first.', { code: 'STAGE_ACTIVE', exitCode: 2 });
    }
    const result = await exportProject(liveDir, args);
    if (result.gate?.verdict === 'FAIL') process.exitCode = 1;
    return print(result, true);
  }
  if (command === 'review-video') {
    const { reviewVideo, decideIssue, reviewText } = await import('./review-video.mjs');
    if (args.decide) {
      const verdict = { accept: 'accepted', reject: 'rejected' }[args.verdict];
      if (!args.issue || !verdict) throw new CapcutError('review-video --decide FILE --issue ID --verdict accept|reject --reason "…"', { exitCode: 2 });
      return print(decideIssue(path.resolve(args.decide), args.issue, verdict, args.reason), true);
    }
    if (!args.media) throw new CapcutError('review-video requires --media FINAL.mp4', { exitCode: 2 });
    const record = await reviewVideo({ media: path.resolve(args.media), projectDir: args.project ? resolveProject(args.project, root) : null,
      script: args.script ? path.resolve(args.script) : null, speech: args.speech ? path.resolve(args.speech) : null,
      model: args.model || 'sonnet', resetRounds: Boolean(args.resetRounds) });
    if (record.status === 'discarded' || record.issues.some(i => i.blocker)) process.exitCode = 1;
    return args.json ? print(record, true) : print(reviewText(record));
  }
  if (command === 'review') {
    if (!args.project) throw new CapcutError('review requires --project NAME.', { exitCode: 2 });
    const projectDir = resolveProject(args.project, root);
    const { reviewProject } = await import('./review.mjs');
    return print(reviewProject(projectDir, {
      outputRoot: path.resolve(args.out || 'outputs'),
      id: args.id,
      fps: args.fps != null ? Number(args.fps) : 6,
      width: args.width != null ? Number(args.width) : 240,
      maxMinutes: args.maxMinutes != null ? Number(args.maxMinutes) : 0,
    }), true);
  }
  if (command === 'rm') {
    if (!args.project) throw new CapcutError('rm requires --project NAME.', { exitCode: 2 });
    const { removeProject } = await import('./create.mjs');
    return print(removeProject(args.project, { root, dryRun: Boolean(args.dryRun),
                                               forceRunning: Boolean(args.forceRunning) }), true);
  }
  if (command === 'new') {
    if (!args.project) throw new CapcutError('new requires --project NAME.', { exitCode: 2 });
    const { createProject } = await import('./create.mjs');
    return print(createProject(args.project, {
      root, from: args.from, media: args.media, scenes: args.scenes,
      canvas: args.canvas, fps: args.fps, blank: Boolean(args.blank),
      width: args.width, height: args.height, duration: args.duration,
      newTimelineId: Boolean(args.newTimelineId),
      localize: !args.noLocalize,
      ...originOptions(args),
      dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning)
    }), true);
  }
  if (command === 'alpha') {
    // Premultiply alpha overlays in place: CapCut composites ProRes alpha premultiplied (alpha.mjs).
    const { premultiplyFile, projectAlphaLeaks } = await import('./alpha.mjs');
    const files = args._.slice(1);
    if (!files.length && !args.project) throw new CapcutError('alpha takes FILE… or --project NAME.', { exitCode: 2 });
    let targets = files.map(f => path.resolve(f));
    if (args.project) {
      const { resolveMediaPath } = await import('./core.mjs');
      const dir = resolveProject(args.project, root);
      if (isStageDir(dir)) args.forceRunning = true;
      targets.push(...projectAlphaLeaks(await loadWorking(dir), dir, { resolve: resolveMediaPath }).map(l => l.file));
    }
    if (!args.dryRun && !args.check) assertCapcutClosed({ forceRunning: Boolean(args.forceRunning) });
    const { straightAlphaLeak } = await import('./alpha.mjs');
    const results = [...new Set(targets)].map(file => args.check || args.dryRun
      ? { file, ...straightAlphaLeak(file) }
      : premultiplyFile(file, { force: Boolean(args.force) }));
    return print({ files: results.length, results }, true);
  }
  if (command === 'preflight') {
    // --project is accepted and ignored: preflight checks the machine, not a project, and an
    // agent that passes it out of habit should get the report, not an error.
    const unknown = Object.keys(args).find(key => !['_', 'root', 'json', 'project'].includes(key));
    if (unknown) throw unknownOptionError('preflight', unknown, ['--json', '--root']);
    if (args._.length !== 1) {
      throw new CapcutError('preflight does not take positional arguments.', { exitCode: 2 });
    }
    const report = preflight({ root });
    if (!report.ok) process.exitCode = 1;
    if (args.json) return print(report, true);
    const lines = [`capcutctl preflight — ${report.ok ? 'ready' : 'NOT ready'}`, ''];
    for (const c of report.checks) {
      const optional = c.blocking === false ? ' (optional)' : '';
      lines.push(`${c.ok ? '  ok  ' : '  --  '} ${c.name}${optional}: ${c.detail}`);
      if (c.fix) lines.push(`         fix: ${c.fix}`);
    }
    emit(`${lines.join('\n')}\n`);
    return;
  }
  if (command === 'projects') return print(listProjects(root), args.json);
  if (command === 'init-spec') {
    const data = stableJson(EXAMPLE_SPEC);
    if (args.output) { fs.writeFileSync(path.resolve(args.output), data); return print(`Wrote ${path.resolve(args.output)}`); }
    return emit(data);
  }

  if (command === 'stage') {
    const sub = args._[1] || 'status';
    const liveDir = resolveProject(args.project, root, { live: true });
    const stage = await import('./stage.mjs');
    if (sub === 'status') return print(stage.stageStatus(liveDir), true);
    if (sub === 'start') {
      if (args.dryRun) return print({ dryRun: true, live: liveDir, stageRoot: stage.stageRoot(), ...stage.stageStatus(liveDir) }, true);
      return print(stage.startStage(liveDir), true);
    }
    if (sub === 'commit') {
      return print(stage.commitStage(liveDir, { dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning),
        backup: !args.noBackup }), true);
    }
    if (sub === 'discard') {
      if (args.dryRun) return print({ dryRun: true, ...stage.stageStatus(liveDir) }, true);
      return print(stage.discardStage(liveDir), true);
    }
    throw new CapcutError('stage takes start | status | commit | discard.', { code: 'STAGE_SUBCOMMAND', exitCode: 2 });
  }
  if (command === 'variant') {
    const projectDir = resolveProject(args.project, root, { live: true });
    const { readHook, normalizeHook, runVariant } = await import('./variant.mjs');
    if (Boolean(args.hooks) === Boolean(args.src)) {
      throw new CapcutError('variant takes --hooks hooks.json [--hook ID] or --src IN-OUT.', { code: 'HOOK_MISSING', exitCode: 2 });
    }
    const hook = args.hooks ? readHook(path.resolve(args.hooks), args.hook ?? null)
      : normalizeHook({ src: String(args.src), id: args.hook });
    const { findWords, loadWords } = await import('./anchors.mjs');
    const { shiftWords } = await import('./video-index.mjs');
    let words = { file: args.words ? path.resolve(args.words) : null, offset: 0 };
    if (!words.file) try { words = findWords(await loadWorking(projectDir), null, { projectDir }); } catch { words = { file: null, offset: 0 }; }
    const result = await runVariant(projectDir, {
      hook, name: args.name || null, opening: num(args, 'opening', { min: 0, def: null }),
      words: words.file ? shiftWords(loadWords(words.file), Number(words.offset) || 0) : null, language: args.lang || 'ar',
      dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning), gate: !args.noGate,
    });
    if (result.gate?.verdict === 'FAIL') process.exitCode = 1;
    if (args.json || !result.gate) return print(result, true);
    const { gateText } = await import('./gate.mjs');
    const plan = result.plan;
    return print(`variant: ${result.name} (hook ${plan.hook.id}: opening ${plan.opening.was}s → ${plan.opening.now}s)\n`
      + `${result.project}\n${plan.warnings.map(w => `WARN ${w}`).join('\n')}${plan.warnings.length ? '\n' : ''}${gateText(result.gate)}`);
  }

  const NEEDS_PROJECT = new Set([
    'inspect', 'doctor', 'snapshot', 'history', 'restore', 'sync', 'scenes',
    'denoise', 'blur-broll', 'reframe', 'cursor', 'screen-motion', 'pace', 'ramp', 'punch', 'match', 'verify-shots', 'captions', 'motion', 'logo', 'endcard', 'zoom', 'wrap', 'polish', 'layout', 'add',
    'replace-media', 'localize', 'trim', 'shift', 'split', 'ripple', 'remove', 'volume', 'fade', 'sfx', 'keyframe', 'animate',
    'preview', 'diff', 'apply', 'timeline', 'finish', 'music', 'grade', 'loudness', 'gate', 'build', 'mograph', 'notes'
  ]);
  if (!NEEDS_PROJECT.has(command)) throw await unknownCommandError(command);
  const projectDir = resolveProject(args.project, root);
  // A staged copy is outside CapCut's drafts folder: no write to it waits for CapCut to close.
  if (isStageDir(projectDir)) args.forceRunning = true;
  if (command === 'inspect') return print(inspectProject(projectDir), true);
  if (command === 'doctor') {
    let repair = null;
    if (args.fix) {
      try {
        const fixed = repairProject(projectDir, { dryRun: Boolean(args.dryRun), forceRunning: Boolean(args.forceRunning),
          backup: !args.noBackup, label: 'doctor-fix' });
        repair = { dryRun: fixed.dryRun, committed: fixed.committed, snapshot: fixed.snapshot, ...fixed.repaired,
          details: { merged: fixed.merged, unmerged: fixed.unmerged, restored: fixed.restored, clamped: fixed.clamped, unclamped: fixed.unclamped } };
      } catch (error) {
        if (error.code === 'CAPCUT_RUNNING' || error.code === 'CAPCUT_PROCESS_UNKNOWN') throw error;
        repair = { error: { code: error.code, message: error.message, details: error.details } };
      }
    }
    const report = doctor(projectDir);
    if (repair) report.repair = repair;
    try {
      const { lintProjectBroll } = await import('./broll-lint.mjs');
      const loaded = loadProject(projectDir);
      const doc = loaded.groups.find(g => g.name.startsWith('timeline:'))?.doc || loaded.groups[0]?.doc;
      if (doc) {
        const broll = lintProjectBroll(doc, { projectDir });
        report.issues.push(...broll.issues);
        report.brollLint = { findings: broll.findings, skipped: broll.skipped };
        report.errors = report.issues.filter(item => item.level === 'error').length;
        report.warnings = report.issues.filter(item => item.level === 'warning').length;
      }
    } catch {
      // Structural doctor already ran. A missing sidecar or unreadable draft
      // must not swallow those findings or the JSON report.
    }
    if (report.errors > 0) process.exitCode = 1;
    return printDoctor(report, args.json);
  }
  if (command === 'snapshot') return print({ snapshot: createSnapshot(projectDir, args.label || 'manual') }, true);
  if (command === 'history') return print(listSnapshots(projectDir), true);
  if (command === 'notes') {
    const { notesBrief, readNotes, updateNotes } = await import('./notes.mjs');
    const change = ['reject', 'accept', 'decide', 'todo', 'done'].some(key => args[key] != null);
    if (!change && args.why != null) throw new CapcutError('--why goes with --reject, --accept or --decide.', { code: 'NOTES_ARGS', exitCode: 2 });
    const notes = change ? updateNotes(projectDir, args) : readNotes(projectDir);
    if (args.brief && !args.json) return print(notesBrief(notes, path.basename(projectDir)).trimEnd());
    return print(notes, true);
  }
  const options = {
    dryRun: Boolean(args.dryRun),
    forceRunning: Boolean(args.forceRunning),
    backup: !args.noBackup,
    label: args.label
  };
  // --plan never writes. Commands that print their own plan return before reaching applySpec;
  // the rest (zoom --at, layout circle/full-face/split-screen…) used to commit a real edit.
  if (args.plan) options.dryRun = true;
  if (command === 'sync') return print(syncMirrors(projectDir, options), true);
  if (command === 'restore') {
    if (!args.snapshot) throw new CapcutError('restore requires --snapshot NAME|LABEL.', { exitCode: 2 });
    return print(restoreProjectSnapshot(projectDir, args.snapshot, options), true);
  }
  if (command === 'scenes') {
    const { describeScenes } = await import('./layouts.mjs');
    let rows = describeScenes(projectDir, await trackIndex(projectDir, args.track),
                              Boolean(args.transcript));
    if (args.name) {
      const needle = String(args.name).toLowerCase();
      rows = rows.filter(r => (r.desc || '').toLowerCase().includes(needle)
        || (r.media || '').toLowerCase().includes(needle)
        || (r.id || '').toLowerCase().includes(needle));
    }
    return print(rows, true);
  }
  if (command === 'loudness') {
    if (args.measure) {
      const { analyzeAudio } = await import('./loudness.mjs');
      return print(analyzeAudio(await loadWorking(projectDir), projectDir), true);
    }
    const op = {
      op: 'loudness',
      target: num(args, 'target', { def: -14 }),
      peak: num(args, 'peak', { def: -1 }),
      ...(args.allowBoost ? { allowBoost: true } : {}),
      ...(args.peakOnly ? { match: false } : {}),
      ...(args.segments ? { segments: segmentIds(args) } : {}),
    };
    return print(applySpec(projectDir, { version: 1, name: 'loudness', operations: [op] },
      { ...options, dryRun: Boolean(args.plan || args.dryRun) }), true);
  }
  if (command === 'grade') {
    const g = await import('./grade.mjs');
    if (args.layer != null) {
      if (args.target || args.reference || args.measure || args.faceDetail || args.source
        || args.sharpen != null || args.clarity != null || args.vignette != null) {
        throw new CapcutError('--layer uses explicit --set sliders, not source correction flags.', { exitCode: 2 });
      }
      const sliders = {};
      for (const pair of [].concat(args.set || []).flatMap(value => String(value).split(','))) {
        if (!pair.trim()) continue;
        const parts = pair.split('=');
        if (parts.length !== 2 || !parts[1].trim()) throw new CapcutError('--layer --set needs slider=value pairs.', { exitCode: 2 });
        sliders[parts[0].trim()] = Number(parts[1]);
      }
      const op = { op: 'grade.layer', name: args.layer, sliders, reset: Boolean(args.reset),
        from: args.from, to: args.to, strength: args.strength };
      return print(applySpec(projectDir, { version: 1, name: 'grade-layer', operations: [op] },
        { ...options, dryRun: Boolean(args.plan || args.dryRun || (!args.apply && !args.reset)) }), true);
    }
    if (args.reset) {
      if (args.set || args.target || args.reference || args.measure || args.faceDetail) throw new CapcutError('--reset cannot be combined with correction or measurement flags.', { exitCode: 2 });
      const op = { op: 'grade.reset', ...(args.source ? { sources: [args.source] } : { all: true }) };
      return print(applySpec(projectDir, { version: 1, name: 'grade-reset', operations: [op] },
        { ...options, dryRun: Boolean(args.plan || args.dryRun) }), true);
    }
    const doc = await loadWorking(projectDir);
    if (args.measure) {
      return print({ target: null, sources: g.measureSources(doc, projectDir, { samples: 4 }) }, true);
    }
    let target;
    if (args.target) {
      try { target = JSON.parse(args.target); }
      catch { throw new CapcutError('--target requires a JSON object of scope targets.', { exitCode: 2 }); }
      if (!target || typeof target !== 'object' || Array.isArray(target)) throw new CapcutError('--target requires a JSON object of scope targets.', { exitCode: 2 });
    }
    const plan = g.planGrade(doc, projectDir, {
      strength: num(args, 'strength', { min: 0, def: 1 }),
      samples: num(args, 'samples', { min: 1, int: true, def: 3 }),
      target, reference: args.reference,
      referenceAt: num(args, 'referenceAt', { min: 0 }),
    });
    // --set FILE:slider=v,slider=v  (repeatable) overrides whatever the solver proposed
    for (const raw of [].concat(args.set || [])) {
      const separator = String(raw).lastIndexOf(':');
      if (separator < 1) throw new CapcutError('--set expects SOURCE:slider=value.', { exitCode: 2 });
      const file = String(raw).slice(0, separator), list = String(raw).slice(separator + 1);
      const row = g.resolveGradeSource(plan, file);
      for (const pair of String(list || '').split(',').filter(Boolean)) {
        const [k, v] = pair.split('=');
        row.sliders[k.trim()] = parseNumber(v ?? '', '--set', { list: raw });
      }
    }
    const wantDetail = Boolean(args.faceDetail || args.sharpen != null || args.clarity != null || args.vignette != null);
    if (wantDetail) {
      const detail = g.faceDetailSliders({
        ...(args.sharpen != null ? { sharpen: num(args, 'sharpen') } : {}),
        ...(args.clarity != null ? { clarity: num(args, 'clarity') } : {}),
        ...(args.vignette != null ? { vignette: num(args, 'vignette') } : {}),
        strength: num(args, 'strength', { min: 0, def: 1 }),
      });
      const faces = plan.sources.filter(row => row.role === 'face');
      if (!faces.length) {
        throw new CapcutError(
          'face-detail needs a talking-head (principal) source; screen recordings are refused because sharpening haloes UI text.',
          { code: 'SCREEN_FACE_DETAIL', exitCode: 2 },
        );
      }
      for (const row of faces) {
        Object.assign(row.sliders, detail);
        row.faceDetail = detail;
      }
      plan.verifiedIn = 'CapCut 9.4.0';
      plan.warning = g.FACE_DETAIL_WARNING;
    }
    if (!args.apply) return print(plan, true);
    const sources = Object.fromEntries(plan.sources
      .filter(r => Object.keys(r.sliders).length)
      .map(r => [r.source, r.sliders]));
    if (!Object.keys(sources).length) return print({ plan, applied: { changed: 0 } }, true);
    const spec = { version: 1, name: 'grade', operations: [{ op: 'grade.apply', sources }] };
    return print({ plan, applied: applySpec(projectDir, spec, options) }, true);
  }
  if (command === 'pace') {
    const { pacePlan } = await import('./pace.mjs');
    const hasAction = args.auto || args.at != null;
    if (!hasAction) {                                     // read-only: the plan
      const doc = await loadWorking(projectDir);
      const rows = pacePlan(doc, { track: await trackIndex(projectDir, args.track),
                                   max: num(args, 'max', { min: 0, def: 100 }),
                                   minGap: num(args, 'minGap', { min: 0, def: 5.0 }) });
      return print({ plan: rows.map(({ __seg, ...r }) => r) }, true);
    }
    const set = [];
    if (args.at != null) {
      if (args.cover) {
        const [a, b] = String(args.cover).split(/[-:,]/).map(part => parseNumber(part, '--cover', { min: 0, list: args.cover }));
        if (!(b > a)) throw new CapcutError('--cover expects IN-OUT in source seconds, e.g. --cover 178.6-190.5', { exitCode: 2 });
        set.push({ at: num(args, 'at', { min: 0 }), cover: [a, b] });
      } else if (args.speed != null) {
        set.push({ at: num(args, 'at', { min: 0 }), speed: num(args, 'speed', { min: 0 }) });
      } else {
        throw new CapcutError('--at needs either --speed X or --cover IN-OUT', { exitCode: 2 });
      }
    }
    const paceTrack = await trackIndex(projectDir, args.track);
    const spec = { version: 1, name: 'pace', operations: [{ op: 'pace',
      ...(set.length ? { set } : {}), ...(args.auto ? { auto: true } : {}),
      ...(paceTrack != null ? { track: paceTrack } : {}),
      ...(args.max != null ? { max: num(args, 'max', { min: 0 }) } : {}),
      ...(args.minGap != null ? { minGap: num(args, 'minGap', { min: 0 }) } : {}) }] };
    return print(applySpec(projectDir, spec, options), true);
  }
  if (command === 'ramp') {
    if (args.segment == null && args.at == null) {
      throw new CapcutError('ramp requires --segment ID or --at T.', { exitCode: 2 });
    }
    const rampTrack = await trackIndex(projectDir, args.track);
    const spec = { version: 1, name: 'ramp', operations: [{
      op: 'ramp',
      speed: num(args, 'speed', { min: 0, def: 20 }),
      settle: num(args, 'settle', { min: 0, def: 0.5 }),
      ...(args.segment != null ? { segment: String(args.segment) } : {}),
      ...(args.at != null ? { at: num(args, 'at', { min: 0 }) } : {}),
      ...(args.resultAt != null ? { resultAt: num(args, 'resultAt', { min: 0 }) } : {}),
      ...(args.reachBack != null ? { reachBack: num(args, 'reachBack', { min: 0 }) } : {}),
      ...(args.reachForward != null ? { reachForward: num(args, 'reachForward', { min: 0 }) } : {}),
      ...(rampTrack != null ? { track: rampTrack } : {}),
    }] };
    return print(applySpec(projectDir, spec, options), true);
  }
  if (command === 'punch') {
    if (!args.on) throw new CapcutError('punch requires --on TEXT naming the on-screen element.', { exitCode: 2 });
    if (args.at != null && args.word != null) {
      throw new CapcutError('punch takes --at T or --word TEXT, not both.', { code: 'PUNCH_TIMING_CONFLICT', exitCode: 2 });
    }
    if (args.word === true || (args.word != null && !String(args.word).trim())) {
      throw new CapcutError('punch --word needs the phrase he says, e.g. --word "save button".', { exitCode: 2 });
    }
    if (args.segment == null && args.segments == null && args.at == null && args.word == null) {
      throw new CapcutError('punch requires --segment ID, --at T or --word TEXT.', { exitCode: 2 });
    }
    if (args.segment != null && args.segments != null) {
      throw new CapcutError('punch takes --segment ID or --segments ID, not both.', { code: 'MULTIPLE_SEGMENTS', exitCode: 2 });
    }
    const punchSegment = args.segments != null ? singleSegment('punch', args) : args.segment;
    const zoom = num(args, 'zoom', { min: 0, def: 1.6 });
    const punchRamp = num(args, 'ramp', { min: 0, def: 0.2 });
    let punchAt = num(args, 'at', { min: 0 });
    if (args.hold != null && args.hold !== 'auto') num(args, 'hold', { min: 0 });
    const punchTrack = await trackIndex(projectDir, args.track);
    if (args.word != null) {
      // --word is a timing source: find the phrase in the talking head's source-time words
      // and map it through the cut to a timeline `at`. --track names the screen clip's lane,
      // not the face, so the principal is found the usual way.
      const doc = await loadWorking(projectDir);
      const words = args.words ? { file: path.resolve(String(args.words)), offset: 0 } : await findWhisperCache(doc, null, projectDir);
      if (!words.file) {
        throw new CapcutError('punch --word found no word-level transcript for this project; '
          + 'pass --words FILE (<stem>.whisper-*.json) or --at T.'
          + (words.reason ? ` (${words.reason})` : ''), { code: 'PUNCH_NO_TRANSCRIPT', exitCode: 2 });
      }
      const { loadWords } = await import('./anchors.mjs');
      const { shiftWords } = await import('./video-index.mjs');
      const { wordTimelineAt } = await import('./punch.mjs');
      punchAt = wordTimelineAt(doc, shiftWords(loadWords(words.file), Number(words.offset) || 0), String(args.word));
    }
    const spec = { version: 1, name: 'punch', operations: [{
      op: 'punch',
      on: String(args.on),
      kind: args.kind || 'click',
      zoom,
      ramp: punchRamp,
      hold: args.hold == null ? 'auto' : args.hold,
      ...(punchSegment != null ? { segment: String(punchSegment) } : {}),
      ...(punchAt != null ? { at: punchAt } : {}),
      ...(punchTrack != null ? { track: punchTrack } : {}),
      ease: !args.noEase,
      ...(args.easePosition ? { easePosition: true } : {}),
    }] };
    return print(applySpec(projectDir, spec, { ...options, dryRun: Boolean(args.plan || args.dryRun) }), true);
  }
  if (command === 'match') {
    const matcher = await import('./match.mjs');
    const doc = await loadWorking(projectDir);
    let result;
    if (args.shots) {
      result = matcher.readShotsFile(path.resolve(args.shots));
    } else {
      if (!args.screen) throw new CapcutError('match requires --screen FILE (or --shots FILE).', { exitCode: 2 });
      const screen = path.resolve(args.screen);
      const face = args.face ? path.resolve(args.face) : null;
      const inputs = matcher.loadMatchInputs({ screen, face, doc, projectDir });
      let probe = {};
      try {
        const { probeMedia } = await import('./create.mjs');
        probe = probeMedia(screen);
      } catch { /* a plan can still run on injected dimensions */ }
      result = matcher.matchShots({
        ...inputs,
        doc,
        screen,
        width: probe.width,
        height: probe.height,
        mediaDuration: probe.duration,
        canvas: doc.canvas_config,
        sourceDims: probe.width ? { width: probe.width, height: probe.height } : null,
        minMargin: num(args, 'minMargin', { def: matcher.DEFAULT_MIN_MARGIN }),
      });
    }
    if (args.out) {
      const dest = path.resolve(args.out);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, stableJson(result));
      result = { ...result, wrote: dest };
    }
    if (args.apply) {
      const spec = matcher.shotsToSpec(result, {
        screen: args.screen ? path.resolve(args.screen) : undefined,
      });
      const check = matcher.writersAccept(spec.operations);
      if (!check.ok) {
        throw new CapcutError(
          `match --apply would emit ops the existing writers do not accept: ${check.rejected.map(row => row.op).join(', ')}`,
          { code: 'UNSUPPORTED_OPERATION', exitCode: 2, details: check.rejected },
        );
      }
      if (!spec.operations.length) {
        return print({ ...result, applied: false, reason: 'no place decisions' }, true);
      }
      return print({ ...result, applied: applySpec(projectDir, spec, options) }, true);
    }
    return print(result, true);
  }
  if (command === 'verify-shots') {
    const verifier = await import('./verify.mjs');
    const doc = await loadWorking(projectDir);
    const outDir = path.resolve(args.out || path.join(projectDir, '.capcutctl', 'verify-shots'));
    const loaded = verifier.loadVerifyShots({
      shotsFile: args.shots ? path.resolve(args.shots) : null,
      doc,
      projectDir,
    });
    const shots = verifier.attachSidecarEvidence(loaded, { projectDir });
    const summary = verifier.verifyShots({
      shots,
      outDir,
    });
    if (summary.contradicted > 0) process.exitCode = 1;
    return print(summary, true);
  }
  if (command === 'logo' || command === 'endcard' || command === 'zoom' || command === 'wrap') {
    const sig = await import('./signature.mjs');
    const op = { op: 'signature', ...(args.noSfx ? { noSfx: true } : {}), ease: !args.noEase };
    // The entrance comes from the profile (logo.reveal), and the house default is the measured
    // 0.13s pop with its pop cue. The orbit-glow motion recipe as a default spun a blurred halo
    // 720° on Line keys, dropped the pop and its SFX, and made `finish` count zero logos, so
    // recipes are opt-in (--motion) and experimental. --glow is the halo pop, --plain the pop.
    if (command === 'logo') {
      const reveal = args.plain ? 'pop' : args.glow ? 'glow' : args.motion || profileValue('logo.reveal', 'pop');
      if (reveal === 'glow') op.glow = true;
      else if (reveal === 'pop') op.glow = false;
      else op.motion = reveal;
    } else if (args.glow) op.glow = true;

    if (command === 'logo') {
      // The ARTWORK is the primitive. A "brand" is only a named lookup for one, so anything
      // that resolves to an image can be popped — a path, a list of paths, a folder of marks,
      // or a registered brand. Keying this on brands.json meant an agent had to register a
      // logo in a preset file before it could put it on screen, which is backwards.
      const brands = sig.brandPresets().brands;
      const list = v => String(v).split(',').map(x => x.trim()).filter(Boolean);
      const IMAGE = /\.(png|webp|gif|jpe?g)$/i;

      const expand = spec => {
        const resolved = path.resolve(spec.replace(/^~(?=$|\/)/, os.homedir()));
        if (!fs.existsSync(resolved)) {
          throw new CapcutError(`no such logo file: ${resolved}`, { code: 'NO_LOGO_ASSET', exitCode: 2 });
        }
        if (!fs.statSync(resolved).isDirectory()) return [resolved];
        const found = fs.readdirSync(resolved).filter(n => IMAGE.test(n)).sort()
          .map(n => path.join(resolved, n));
        if (!found.length) {
          throw new CapcutError(`no images in ${resolved} (looked for png/webp/gif/jpg).`,
            { code: 'NO_LOGO_ASSET', exitCode: 2 });
        }
        return found;
      };

      let marks;
      if (args.logo) {
        const files = list(args.logo).flatMap(expand);
        const names = args.name ? list(args.name) : [];
        if (names.length && names.length !== files.length) {
          throw new CapcutError(`--name has ${names.length} entries for ${files.length} logos; `
            + 'give one per logo or drop it and the filename is used.', { exitCode: 2 });
        }
        marks = files.map((file, i) => ({
          brand: names[i] || path.basename(file).replace(/\.[^.]+$/, ''), logo: file }));
      } else if (args.brand) {
        marks = list(args.brand).map(name => {
          const b = brands[name];
          if (!b) {
            throw new CapcutError(`unknown brand "${name}". Pass --logo PATH to use artwork that `
              + 'is not registered, or see `capcutctl brands`.', { exitCode: 2 });
          }
          return { brand: name, logo: b.logo };
        });
      } else if (!args.auto) {
        throw new CapcutError('logo needs --logo PATH (a file, a comma-separated list, or a '
          + 'folder), --brand NAME[,NAME…], or --auto to read the transcript.', { exitCode: 2 });
      }

      // Timing: explicit --at, else the transcript. Detection only knows about registered
      // brands, so an unregistered mark must carry its own --at.
      const ats = args.at != null ? nums(args, 'at', { min: 0 }) : null;

      if (marks && ats) {
        if (ats.length !== 1 && ats.length !== marks.length) {
          throw new CapcutError(`--at has ${ats.length} times for ${marks.length} logos; give one `
            + 'each, or a single time to bring them all in together.', { exitCode: 2 });
        }
        marks.forEach((m, i) => { m.at = ats.length === 1 ? ats[0] : ats[i]; });
      } else {
        const doc = await loadWorking(projectDir);
        const principal = await trackIndex(projectDir, args.track);
        const mapper = sig.sourceToTimeline(doc, principal);
        const words = args.words ? { file: path.resolve(args.words), offset: 0 } : await findWhisperCache(doc, principal, projectDir);
        if (!words.file) {
          throw new CapcutError('no word-level transcript for this project, so a logo cannot be '
            + 'timed automatically. Pass --at SECONDS, or --words <stem>.whisper-*.json.'
            + (words.reason ? ` (${words.reason})` : ''),
            { exitCode: 2 });
        }
        const { shiftTranscript } = await import('./video-index.mjs');
        const tr = shiftTranscript(readJson(words.file), Number(words.offset) || 0);
        if (!Array.isArray(tr.segments)) {
          throw new CapcutError('--words wants a Whisper transcript with segments[].words, not an '
            + '.aroll.json.', { exitCode: 2 });
        }
        const hits = sig.detectBrands(tr, mapper,
          { only: marks ? marks.map(m => m.brand) : null });
        const at = new Map(hits.map(h => [h.brand, h.at]));
        if (!marks) {
          marks = hits.map(h => ({ brand: h.brand, logo: h.logo, at: h.at }));
        } else {
          const unheard = marks.filter(m => !at.has(m.brand));
          if (unheard.length) {
            throw new CapcutError(`never said, or not registered as a brand: `
              + `${unheard.map(m => m.brand).join(', ')}. Pass --at SECONDS for these, or add `
              + 'aliases in presets/brands.json in the form Whisper actually writes them.',
              { exitCode: 2 });
          }
          marks.forEach(m => { m.at = at.get(m.brand); });
        }
      }

      // One artwork is one mark, whatever it is called. Two registered brands can point at the
      // same file (chatgpt/openai), and a folder can hold the same image twice.
      const byArtwork = new Map();
      for (const m of marks.sort((a, b) => a.at - b.at)) {
        if (!byArtwork.has(m.logo)) byArtwork.set(m.logo, m);
      }
      let logos = [...byArtwork.values()];

      const noArt = logos.filter(l => !l.logo || !fs.existsSync(l.logo));
      logos = logos.filter(l => l.logo && fs.existsSync(l.logo));
      if (!logos.length) {
        throw new CapcutError(noArt.length
          ? `no artwork on disk for ${noArt.map(l => l.brand).join(', ')}.`
          : 'nothing to place: no brand in the transcript was recognised. `--plan` prints the '
            + 'detection; check the aliases match what Whisper actually wrote.', { exitCode: 2 });
      }

      const scales = args.scale ? nums(args, 'scale', { min: 0 }) : null;
      const holds = args.hold ? nums(args, 'hold', { min: 0 }) : null;
      const pos = args.pos ? nums(args, 'pos') : null;
      const pick = (arr, i) => (arr == null ? null : (arr.length === 1 ? arr[0] : arr[i]));
      op.logos = logos.map((l, i) => ({ brand: l.brand, at: r3(l.at), logo: l.logo,
        ...(pick(scales, i) != null ? { scale: pick(scales, i) } : {}),
        ...(pick(holds, i) != null ? { hold: pick(holds, i) } : {}),
        ...(pos ? { pos } : {}) }));
      if (!pos) sig.spreadOverlapping(op.logos, sigRules(sig));
      if (args.plan) {
        return print({ logos: op.logos, skippedNoArtwork: noArt.map(l => l.brand),
                       reveal: op.motion || (op.glow ? 'glow' : 'pop'),
                       blur: Boolean(op.motion) }, true);
      }
      if (op.motion) {
        const { MOTION_RECIPES } = await import('./motion.mjs');
        if (!MOTION_RECIPES.includes(op.motion)) {
          throw new CapcutError(`unknown motion "${op.motion}". Use ${MOTION_RECIPES.join(', ')}.`, { code: 'MOTION_RECIPE', exitCode: 2 });
        }
        const slug = value => String(value || 'logo').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'logo';
        const operations = op.logos.map((logo, index) => ({
          op: 'motion',
          recipe: op.motion,
          name: slug(`${logo.brand}-${index}`),
          logo: logo.logo,
          at: logo.at,
          duration: logo.hold ?? 2.5,
          ...(logo.scale != null ? { scale: logo.scale } : { scale: 0.36 }),
          ...(logo.pos ? { x: logo.pos[0], y: logo.pos[1] } : {}),
        }));
        return print(applySpec(projectDir, { version: 1, name: 'logo-motion', operations }, options), true);
      }
    }

    if (command === 'endcard') {
      op.endcard = { ...(args.text ? { text: args.text } : {}),
                     ...(args.at != null ? { at: num(args, 'at', { min: 0 }) } : {}),
                     ...(args.hold ? { hold: num(args, 'hold', { min: 0 }) } : {}),
                     ...(args.scale ? { scale: num(args, 'scale', { min: 0 }) } : {}) };
    }
    if (command === 'zoom') {
      if (args.stress) {
        const stressOp = {
          op: 'zoom.stress',
          ...(args.to ? { to: num(args, 'to', { min: 0 }) } : {}),
          ...(args.hold != null ? { hold: num(args, 'hold', { min: 0 }) } : {}),
          ...(args.minLength ? { minLength: num(args, 'minLength', { min: 0 }) } : {}),
          ease: !args.noEase,
          ...(args.words ? { wordsFile: path.resolve(args.words) } : {}),
        };
        const stressTrack = await trackIndex(projectDir, args.track);
        if (stressTrack != null) stressOp.track = stressTrack;
        return print(applySpec(projectDir, { version: 1, name: 'zoom-stress', operations: [stressOp] },
          { ...options, dryRun: Boolean(args.plan || args.dryRun) }), true);
      }
      if (args.auto) {
        // Deprecated: a push on every full-face scene is clockwork, the loudest "a machine made
        // this" tell. --stress picks the words that carry weight instead.
        process.stderr.write('warning: zoom --auto is deprecated (a push on every scene reads as clockwork); use zoom --stress.\n');
        const doc = await loadWorking(projectDir);
        const scenes = sig.talkingHeadScenes(doc, await trackIndex(projectDir, args.track),
                                             args.minLength ? num(args, 'minLength', { min: 0 }) : 2.5);
        if (!scenes.length) throw new CapcutError('no full-face scenes found (every principal clip carries a mask).', { exitCode: 2 });
        // fire a little after the cut, so the push reads as a move and not as the cut itself
        args.at = scenes.map(s => (s.start + 0.4).toFixed(2)).join(',');
        if (args.plan) return print({ talkingHeadScenes: scenes, zoomAt: args.at.split(',').map(Number) }, true);
      }
      if (args.at == null) throw new CapcutError('zoom requires --at SECONDS (comma-separated), or --auto, or --stress.', { exitCode: 2 });
      const to = args.to ? num(args, 'to', { min: 0 }) : null;
      const hold = num(args, 'hold', { min: 0 });
      op.zooms = nums(args, 'at', { min: 0 }).map(at => ({ at,
        ...(to != null ? { to } : {}),
        ...(hold != null ? { hold } : {}) }));
    }

    if (command === 'wrap') {
      const doc = await loadWorking(projectDir);
      const mapper = sig.sourceToTimeline(doc, await trackIndex(projectDir, args.track));
      let hits = [];
      if (args.transcript === true) {
        throw new CapcutError('wrap takes --words FILE (a word-level transcript json), not a bare --transcript.', { exitCode: 2 });
      }
      const words = args.words ? { file: path.resolve(args.words), offset: 0 }
        : await findWhisperCache(doc, await trackIndex(projectDir, args.track), projectDir);
      if (words.file) {
        const { shiftTranscript } = await import('./video-index.mjs');
        const tr = shiftTranscript(readJson(words.file), Number(words.offset) || 0);
        if (!Array.isArray(tr.segments)) {
          throw new CapcutError(
            'wrap --words wants a Whisper transcript with segments[].words, not an .aroll.json. '
            + 'The cache is ~/Downloads/.video-index/<stem>.whisper-*.json (written by `capcutctl cut`).',
            { exitCode: 2 });
        }
        hits = sig.detectBrands(tr, mapper, { only: args.only ? String(args.only).split(',') : null });
      }
      const missing = hits.filter(h => !h.logo || !fs.existsSync(h.logo));
      hits = hits.filter(h => h.logo && fs.existsSync(h.logo));
      op.logos = hits;
      op.endcard = { ...(args.text ? { text: args.text } : {}) };
      // Face pushes are not wrap's job any more: one on every scene was clockwork. Emphasis
      // pushes come from `zoom --stress` (or `build`), which picks the stressed words.
      if (args.zoomAt) op.zooms = nums(args, 'zoomAt', { min: 0 }).map(at => ({ at }));
      else op.zooms = [];
      if (args.plan) return print({ detected: hits, skippedNoLogo: missing.map(m => m.brand),
                                    endcard: op.endcard, zooms: op.zooms || [] }, true);
      if (missing.length) process.stderr.write(`note: no logo asset for ${missing.map(m => m.brand).join(', ')} — skipped\n`);
    }
    return print(applySpec(projectDir, { version: 1, name: command, operations: [op] }, options), true);
  }
  if (command === 'gate') {
    const { gateReport, gateText, writeGateRecord, finaliseReport, noteRestoredMeta } = await import('./gate.mjs');
    const { loadProfile, applyStyle } = await import('./profile.mjs');
    const profile = applyStyle(loadProfile({ file: args.profile || null }), args.style || null);
    const { doc, restored } = await loadWorking(projectDir, { withRestored: true });
    const report = gateReport(doc, { projectDir, profile });
    if (args.xray) {
      const { foldXray } = await import('./gate.mjs');
      foldXray(report, args.xray, projectDir, { profile, draft: doc, pauses: pauseList(args.pause) });
    }
    if (args.review) {
      const { foldReview } = await import('./review-video.mjs');
      foldReview(report, path.resolve(args.review));
      finaliseReport(report);
    }
    noteRestoredMeta(report, restored);
    if (args.record) report.recorded = writeGateRecord(projectDir, report);
    if (report.verdict === 'FAIL') process.exitCode = 1;
    return args.json ? print(report, true) : print(gateText(report));
  }
  if (command === 'build') {
    if (!args.edit) throw new CapcutError('build needs --edit edit.json (see the capcut-editing skill for the format).', { code: 'PLAN_MISSING', exitCode: 2 });
    // `dependencies.build` stands in for the build pipeline in tests of this output.
    const { readEditPlan, runBuild } = dependencies.build || await import('./build.mjs');
    const plan = readEditPlan(args.edit);
    if (!args.dryRun) assertCapcutClosed({ forceRunning: Boolean(args.forceRunning) });
    const result = await runBuild(projectDir, plan, { dryRun: Boolean(args.dryRun), force: Boolean(args.force),
      forceRunning: Boolean(args.forceRunning), backup: !args.noBackup });
    if (result.gate?.verdict === 'FAIL') process.exitCode = 1;
    if (args.json) return print(result, true);
    const { gateText } = await import('./gate.mjs');
    const head = result.upToDate ? `build: up to date (${result.hash})` : `build: ${result.dryRun ? 'dry run' : 'applied'} (${result.hash})`;
    // A skipped stage is named before the dump, where it cannot scroll past unread.
    const skips = (result.skipped || []).map(s => `\nSKIPPED ${s.stage}${s.code ? ` (${s.code})` : ''}: ${s.reason}`).join('');
    const stages = result.stages ? `\n${JSON.stringify(result.stages, null, 2)}` : '';
    const next = buildNextHint(result.gate, args.project);
    return print(`${head}${skips}${stages}\n${gateText(result.gate)}${next ? `\n${next}` : ''}`);
  }
  if (command === 'mograph') {
    const sub = args._[1];
    if (!['add', 'rerender'].includes(sub)) {
      throw new CapcutError('mograph takes list | preview | render | scenes | scene-preview | scene-render | add | rerender.', { code: 'MOGRAPH_SUBCOMMAND', exitCode: 2 });
    }
    // `dependencies.mograph` / `.scenes` stand in for the browser renderers in tests.
    const mograph = dependencies.mograph || await import('./mograph.mjs');
    const place = await import('./mograph-place.mjs');
    const { loadProfile } = await import('./profile.mjs');
    const profile = loadProfile();
    const canvas = { width: profile.canvas.width, height: profile.canvas.height };
    // The transaction would refuse a running CapCut anyway: refuse before the render, not after it.
    if (!options.dryRun) assertCapcutClosed({ forceRunning: Boolean(args.forceRunning) });
    const dir = path.join(projectDir, 'mograph');
    const doc = await loadWorking(projectDir);
    let item;
    if (sub === 'rerender') {
      if (!args.id) throw new CapcutError('mograph rerender needs --id.', { code: 'MOGRAPH_PLACE', exitCode: 2 });
      const sidecar = path.join(dir, `${args.id}.json`);
      if (!fs.existsSync(sidecar)) throw new CapcutError(`no rendered graphic "${args.id}" in ${dir}.`, { code: 'MOGRAPH_MISSING', exitCode: 2 });
      const prev = readJson(sidecar);
      const params = args.params || args.paramsFile ? { ...prev.params, ...mographParams(args) } : prev.params;
      // Where the graphic sits NOW (a ripple or a hand move in CapCut), not where it was rendered.
      const live = place.liveMographStart(doc, prev.id);
      const at = live ?? prev.at;
      item = { id: prev.id, template: prev.template, scene: prev.scene || null, params, format: prev.format, at, anchor: prev.anchor,
        // the placement's own choices: a "no cue" (null) and an accepted unsafe box carry over
        sfx: args.noSfx ? null : prev.sfx, allowUnsafe: Boolean(args.allowUnsafe || prev.allowUnsafe),
        ...(live != null && prev.at != null && r3(live) !== r3(prev.at) ? { moved: { from: prev.at, to: live } } : {}) };
    } else {
      if (!args.template && !args.scene) throw new CapcutError('mograph add needs --template ID or --scene ID.', { code: 'MOGRAPH_TEMPLATE', exitCode: 2 });
      if (args.template && args.scene) throw new CapcutError('mograph add takes --template or --scene, not both.', { code: 'MOGRAPH_TEMPLATE', exitCode: 2 });
      if (args.at == null && !args.say) throw new CapcutError('mograph add needs --at SECONDS or --say WORDS.', { code: 'MOGRAPH_PLACE', exitCode: 2 });
      let at = num(args, 'at', { min: 0, def: null });
      let anchor = null;
      if (args.say) {
        const { resolveAnchors } = await import('./anchors.mjs');
        const [hit] = resolveAnchors([{ id: args.id || args.template || args.scene, say: args.say, occurrence: num(args, 'occurrence', { min: 1, int: true, def: 1 }) }],
          { doc, projectDir, wordsFile: args.words ? path.resolve(args.words) : null });
        // a template leads its word; a scene is a cut and starts on it
        at = place.anchoredStart(hit, { scene: Boolean(args.scene), profile });
        anchor = hit.anchor;
      }
      const params = mographParams(args);
      const choices = { sfx: args.noSfx ? null : undefined, allowUnsafe: Boolean(args.allowUnsafe) };
      if (args.scene) {
        item = { id: args.id || `${args.scene}-${Math.round(at * 1000)}`, template: null, scene: args.scene, params,
          format: 'prores', at: Math.round(at * 1000) / 1000, anchor, ...choices };
      } else {
        if (!params.center && !params.box && !params.layout) params.layout = place.layoutAt(doc, at);
        const motion = mograph.listTemplates().find(t => t.id === args.template)?.motion || 'rich';
        item = { id: args.id || `${args.template}-${Math.round(at * 1000)}`, template: args.template, params,
          format: args.format || (motion === 'rich' ? 'prores' : 'png-still'), at: Math.round(at * 1000) / 1000, anchor, ...choices };
      }
    }
    const moved = item.moved ? { moved: item.moved } : {};
    const writeSidecar = record => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${item.id}.json`), stableJson({
        version: 1, id: item.id, ...record, params: item.params, anchor: item.anchor || null, at: item.at,
        ...(item.sfx !== undefined ? { sfx: item.sfx } : {}), ...(item.allowUnsafe ? { allowUnsafe: true } : {}) }));
    };
    if (item.scene) {
      // A scene is the whole frame: its readable text is proven safe by the renderer, it carries
      // its own synthesised sound, and it lands at canvas scale 1 on a mograph lane.
      const scenes = dependencies.scenes || await import('./mograph-scene.mjs');
      const fingerprint = scenes.sceneFingerprint(item.scene, item.params, profile);
      const out = mograph.renderOut(dir, item.id, fingerprint);
      const rendered = args.dryRun
        ? { ...(await scenes.probeScene({ scene: item.scene, params: item.params, profile })), file: `${out}.mov` }
        : await scenes.renderScene({ scene: item.scene, params: item.params, out, format: 'prores', profile,
          allowUnsafe: item.allowUnsafe });
      if (args.dryRun && rendered.unsafe.length && !item.allowUnsafe) {
        throw new CapcutError(`${item.id}: ${scenes.sceneHitText(rendered.unsafe[0])}; shorten it or pass --allow-unsafe.`,
          { code: 'SCENE_SAFE_ZONE', exitCode: 2, details: { unsafe: rendered.unsafe } });
      }
      const box = { x: 0, y: 0, w: profile.canvas.width, h: profile.canvas.height };
      const op = { op: 'mograph.place', id: item.id, template: `scene:${item.scene}`, file: rendered.file, format: 'prores',
        at: item.at, duration: rendered.meta.duration, box, fingerprint, sfx: null, canvas, ...(args.noSfx ? { clipVolume: 0 } : {}),
        importVerified: false };
      if (args.dryRun) return print({ dryRun: true, placement: op, meta: rendered.meta, unsafe: rendered.unsafe, ...moved }, true);
      const result = applySpec(projectDir, { version: 1, name: `mograph-${sub}`, operations: [op] }, options);
      writeSidecar({ scene: item.scene, template: null, format: 'prores', file: rendered.file, box, meta: rendered.meta, fingerprint,
        duration: rendered.meta.duration, importVerified: false });
      return print({ ...result, ...moved }, true);
    }
    const fingerprint = mograph.fingerprint(item.template, item.params, profile);
    const out = mograph.renderOut(dir, item.id, fingerprint);
    // The safe zones refuse with numbers: the box, each overlap and a centre to try.
    const refuseUnsafe = box => {
      if (item.allowUnsafe) return;
      const advice = mograph.safeZoneAdvice(box, profile);
      if (!advice.hits.length) return;
      throw new CapcutError(`${item.id} sits in the platform UI: ${mograph.safeZoneText(box, advice)}; `
        + 'move it (params center/layout) or pass --allow-unsafe.', { code: 'MOGRAPH_SAFE_ZONE', exitCode: 2, details: { box, ...advice } });
    };
    const rendered = args.dryRun
      ? { ...(await mograph.probeMograph({ template: item.template, params: item.params, profile })),
        file: `${out}.${item.format === 'png-still' ? 'png' : 'mov'}` }
      : await mograph.renderMograph({ template: item.template, params: item.params, out, format: item.format, profile,
        checkBox: refuseUnsafe });
    refuseUnsafe(rendered.box);
    const op = { op: 'mograph.place', id: item.id, template: item.template, file: rendered.file, format: item.format,
      at: item.at, duration: rendered.meta.duration, box: rendered.box, fingerprint, canvas,
      sfx: place.resolvePlacementSfx(item.sfx, rendered.meta.sfx, Boolean(args.noSfx)), sfxLead: 0,
      importVerified: item.format === 'png-still' };
    if (args.dryRun) return print({ dryRun: true, placement: op, box: rendered.box, meta: rendered.meta, ...moved }, true);
    const result = applySpec(projectDir, { version: 1, name: `mograph-${sub}`, operations: [op] }, options);
    writeSidecar({ template: item.template, format: item.format, file: rendered.file, box: rendered.box, meta: rendered.meta,
      fingerprint, duration: rendered.meta.duration, importVerified: item.format === 'png-still' });
    return print({ ...result, ...moved }, true);
  }
  if (command === 'polish') {
    const { assertFirstPictureProof } = await import('./finish.mjs');
    assertFirstPictureProof(await loadWorking(projectDir));
    const polishTrack = await trackIndex(projectDir, args.track);
    const spec = { version: 1, name: 'polish',
                   operations: [{ op: 'polish', ...(args.lead != null ? { lead: num(args, 'lead', { min: 0 }) } : {}),
                                  ...(polishTrack != null ? { track: polishTrack } : {}),
                                  ...(args.noTransitions ? { noTransitions: true } : {}),
                                  ...(args.noSfx ? { noSfx: true } : {}),
                                  ...(args.motivated ? { motivated: true } : {}),
                                  ...(args.noInteractions ? { noInteractions: true } : {}) }] };
    return print(applySpec(projectDir, spec, options), true);
  }
  if (command === 'timeline') {
    const { renderTimeline } = await import('./timeline.mjs');
    const doc = await loadWorking(projectDir);
    const view = renderTimeline(doc, { width: args.width ? Number(args.width) : 64 });
    if (args.json) return print(view, true);
    return print(view.text);
  }
  if (command === 'denoise') {
    return planOrApply(projectDir, 'denoise', { op: 'denoise' }, args, options,
      async () => (await import('./denoise.mjs')).planDenoise);
  }
  if (command === 'blur-broll') {
    return planOrApply(projectDir, 'blur-broll', { op: 'blur-broll', segment: args.segment }, args, options,
      async () => (await import('./derived-media.mjs')).planBlurBroll);
  }
  if (command === 'reframe') {
    return planOrApply(projectDir, 'reframe', { op: 'reframe', segment: args.segment, auto: Boolean(args.auto) }, args, options,
      async () => (await import('./reframe.mjs')).planReframe);
  }
  if (command === 'cursor') {
    const op = { op: 'cursor', segment: args.segment, auto: Boolean(args.auto), style: args.style,
      ...(args.size != null ? { size: num(args, 'size', { min: 0 }) } : {}) };
    return planOrApply(projectDir, 'cursor', op, args, options,
      async () => (await import('./cursor.mjs')).planCursor);
  }
  if (command === 'screen-motion') {
    if (!args.regions || typeof args.regions !== 'string') throw new CapcutError('screen-motion requires --regions FILE.json.', { exitCode: 2 });
    const op = { op: 'screen.motion', segment: args.segment, regions: readJson(path.resolve(args.regions)), replace: Boolean(args.replace),
      ...Object.fromEntries(['zoomIn', 'zoomOut', 'connectGap', 'glide'].filter(k => args[k] != null).map(k => [k, Number(args[k])])) };
    return planOrApply(projectDir, 'screen-motion', op, args, options,
      async () => (await import('./screen-camera.mjs')).planScreenMotion);
  }
  if (command === 'music' && !args.duck && ['underDb', 'attackMs', 'releaseMs', 'minGapMs', 'words'].some(key => args[key] != null)) {
    throw new CapcutError('Ducking controls require music --duck.', { code: 'MUSIC_OPTIONS', exitCode: 2 });
  }
  if (command === 'music' && args.duck) {
    if (['file', 'prompt', 'regen', 'volume', 'hits', 'offset'].some(key => args[key] != null)) {
      throw new CapcutError('Use music --duck on the existing bed separately from music generation/placement flags.', { code: 'MUSIC_OPTIONS', exitCode: 2 });
    }
    const op = { op: 'music', duck: true, track: await trackIndex(projectDir, args.track),
      ...(args.words ? { wordsFile: path.resolve(args.words) } : {}) };
    for (const key of ['underDb', 'attackMs', 'releaseMs', 'minGapMs']) if (args[key] != null) op[key] = Number(args[key]);
    if (args.plan) {
      const { planDuckMusic } = await import('./duck.mjs');
      return print(planDuckMusic(await loadWorking(projectDir), op, { projectDir }), true);
    }
    return print(applySpec(projectDir, { version: 1, name: 'music-duck', operations: [op] }, options), true);
  }
  if (command === 'finish' || command === 'music') {
    const { assertFirstPictureProof, finishScorecard, finishText } = await import('./finish.mjs');
    const doc = await loadWorking(projectDir);
    const score = finishScorecard(doc, { projectDir, width: args.width ? Number(args.width) : 64 });
    const wantMusic = command === 'music' || (command === 'finish' && Boolean(args.music));
    const wantPolish = command === 'finish' && args.polish;
    if ((wantMusic || wantPolish) && !args.plan) assertFirstPictureProof(doc);
    if (args.plan || (!wantMusic && !wantPolish && command === 'finish')) {
      if (wantMusic) {
        const { prepareMusic } = await import('./music.mjs');
        score.musicPrepared = await prepareMusic(projectDir, doc, {
          dryRun: true, prompt: args.prompt, file: args.file, regen: Boolean(args.regen),
          hits: args.hits, offset: args.offset,
          ...(args.volume != null ? { volume: num(args, 'volume', { min: 0 }) } : {}),
        });
        score.musicPrompt = score.musicPrepared.prompt;
      }
      if (args.json) return print(score, true);
      return print(finishText(score));
    }
    const ops = [];
    if (wantMusic) {
      const { prepareMusic, DEFAULT_MUSIC_VOLUME } = await import('./music.mjs');
      if (!args.dryRun) assertCapcutClosed({ forceRunning: Boolean(args.forceRunning) });
      const prepared = await prepareMusic(projectDir, doc, {
        regen: Boolean(args.regen),
        volume: num(args, 'volume', { min: 0, def: DEFAULT_MUSIC_VOLUME }),
        prompt: args.prompt || undefined,
        file: args.file || undefined,
        hits: args.hits, offset: args.offset,
        dryRun: Boolean(args.dryRun),
      });
      const off = prepared.align?.offset || 0;
      score.musicPrepared = {
        ...prepared,
        generated: prepared.generated,
        wouldGenerate: prepared.wouldGenerate,
        dryRun: Boolean(args.dryRun),
        file: prepared.file,
        beats: prepared.beats,
        align: prepared.align,
      };
      score.musicPrompt = prepared.prompt;
      if (!args.dryRun) {
        ops.push({
          op: 'music',
          file: prepared.file,
          duration: prepared.duration,
          volume: prepared.volume,
          srcOffset: off < 0 ? -off : 0,
          at: off > 0 ? off : 0,
          fadeIn: 0.4,
          fadeOut: 1.2,
        });
      }
    }
    if (wantPolish) {
      const polishTrack = await trackIndex(projectDir, args.track);
      ops.push({ op: 'polish', motivated: true, ...(polishTrack != null ? { track: polishTrack } : {}) });
    }
    if (!ops.length) {
      if (args.dryRun && wantMusic) return print({ dryRun: true, score, result: null }, true);
      if (args.json) return print(score, true);
      return print(finishText(score));
    }
    const result = applySpec(projectDir, { version: 1, name: command, operations: ops }, options);
    if (args.json) return print({ score, result }, true);
    return print(JSON.stringify({ ...result, music: score.musicPrepared || score.music }, null, 2));
  }
  if (command === 'layout') {
    const name = args._[1];
    if (!name) throw new CapcutError('layout requires a name: split-screen | circle | full-face | background | broll | screen | auto | audit | list', { exitCode: 2 });
    const layoutsMod = await import('./layouts.mjs');
    const { buildLayoutSpec } = layoutsMod;
    if (name === 'audit' || (name === 'auto' && args.plan)) {
      const doc = await loadWorking(projectDir);
      return print(layoutsMod.layoutAudit(doc, await trackIndex(projectDir, args.track), projectDir), true);
    }
    if (name === 'screen') {
      if (args.at == null || !args.media) {
        throw new CapcutError('layout screen requires --at SECONDS and --media FILE.', { exitCode: 2 });
      }
      const media = path.resolve(args.media);
      const probe = await probeOrOverride(media, args);
      const duration = num(args, 'dur', { min: 0, def: Number(probe.duration) / 1e6 });
      const spec = buildScreenLayoutSpec({
        media,
        at: num(args, 'at', { min: 0 }),
        duration,
        sourceStart: num(args, 'src', { min: 0, def: 0 }),
        sourceDuration: num(args, 'srcDur', { min: 0, def: duration }),
        width: probe.width,
        height: probe.height,
        mediaDuration: probe.duration,
        track: args.track ?? 'screen',
        localize: !args.noLocalize,
      });
      if (args.plan) return print(spec, true);
      const result = applySpec(projectDir, spec, options);
      for (const line of layoutsMod.specWarnings(result)) process.stderr.write(`warning: ${line}\n`);
      return print(result, true);
    }
    const spec = buildLayoutSpec(projectDir, name, {
      segments: args.segments ? String(args.segments).split(',').map(s => s.trim()).filter(Boolean) : null,
      at: args.at ? nums(args, 'at', { min: 0 }) : null,
      track: await trackIndex(projectDir, args.track),
      row: num(args, 'row'), scale: num(args, 'scale', { min: 0 }), seam: args.noSeam ? false : undefined,
      overlay: args.noOverlay ? false : undefined,
      includeTemplate: Boolean(args.includeTemplate)
    });
    if (name === 'auto' && !(spec.operations || []).length) {
      return print({ changed: 0, note: 'every principal clip already has the layout its B-roll implies.', audit: spec.__audit }, true);
    }
    const result = applySpec(projectDir, spec, options);
    for (const line of layoutsMod.specWarnings(result)) process.stderr.write(`warning: ${line}\n`);
    return print(result, true);
  }
  if (command === 'add') {
    if (!args.media) throw new CapcutError('add requires --media FILE.', { exitCode: 2 });
    {
      const { AUDIO_FILE_EXTENSIONS } = await import('./polish.mjs');
      if (AUDIO_FILE_EXTENSIONS.includes(path.extname(String(args.media)).toLowerCase())) {
        throw new CapcutError(`add places video and stills; ${path.basename(String(args.media))} is audio. `
          + 'Use `capcutctl sfx --project NAME --file PATH --cues AT[:DUR]` (a whoosh, a click, a voice patch) '
          + 'or `capcutctl music --file PATH` for a bed.', { code: 'ADD_AUDIO', exitCode: 2 });
      }
    }
    if (args.at == null || args.dur == null) throw new CapcutError('add requires --at SECONDS and --dur SECONDS.', { exitCode: 2 });
    if (args.track == null) throw new CapcutError('add requires --track NAME (creates) or --track N (existing).', { exitCode: 2 });
    // Numbers before the probe: `--at 3s` is the agent's mistake, not a media problem.
    const at = num(args, 'at', { min: 0 });
    const duration = num(args, 'dur', { min: 0 });
    const srcFlag = num(args, 'src', { min: 0 });
    const srcDur = num(args, 'srcDur', { min: 0 });
    const volume = num(args, 'volume', { min: 0, def: 1 });
    let cover = null;
    if (args.cover) {
      const parts = String(args.cover).split(/[-:,]/);
      const [a, b] = parts.length === 2 ? parts.map(part => parseNumber(part, '--cover', { min: 0, list: args.cover })) : [];
      if (!(b > a)) throw new CapcutError('--cover expects IN-OUT in source seconds.', { exitCode: 2 });
      cover = [a, b];
    }
    for (const key of ['width', 'height', 'mediaDuration']) num(args, key, { min: 0 });
    const probe = await probeOrOverride(args.media, args);
    const op = {
      op: 'clip.add',
      media: path.resolve(args.media),
      at,
      duration,
      // default to the START of the media, not the timeline position — `add --at 30`
      // used to begin 30s into a file the user had just picked.
      src: srcFlag != null ? srcFlag : (cover ? cover[0] : 0),
      srcDur,
      cover,
      track: args.track,
      volume,
      desc: args.desc || '',
      width: probe.width,
      height: probe.height,
      mediaDuration: probe.duration,
      localize: !args.noLocalize,
      ...(args.layer != null ? { layer: String(args.layer) } : {}),
      ...originOptions(args)
    };
    const result = applySpec(projectDir, { version: 1, name: 'add', operations: [op] }, options);
    const added = (result.result || []).find(g => g.group === 'root')?.operations?.[0];
    if (added?.id) {
      // A command the agent can paste as is: `layout broll` refuses without --row, and a
      // project name with a space split into two words. The row defaults to the source's
      // vertical centre; pick the row the action is on before running it.
      const height = Number(probe.height);
      const row = Number.isFinite(height) && height > 0 ? Math.round(height / 2) : 'SOURCE_Y_PX';
      added.layout = `capcutctl layout broll --project ${shq(args.project)} --at ${added.at} --track ${shq(added.track)} --row ${row}`;
      added.layoutNote = `--row ${row} is the source's vertical centre; set it to the source row the action is on.`;
    }
    return print(result, true);
  }
  if (command === 'replace-media') {
    const file = args.file || args.media;
    if (!file) throw new CapcutError('replace-media requires --file FILE.', { exitCode: 2 });
    if (args.at == null && !args.segments) throw new CapcutError('replace-media requires --at SECONDS or --segments ID.', { exitCode: 2 });
    const at = num(args, 'at', { min: 0 });
    for (const key of ['width', 'height', 'mediaDuration', 'derivedOffset']) num(args, key);
    const ids = segmentIds(args);
    if (args.all && ids.length > 1) {
      throw new CapcutError('replace-media --all relinks every clip sharing ONE clip\'s media; name that one clip: --segments ID --all.',
        { code: 'MULTIPLE_SEGMENTS', exitCode: 2 });
    }
    let selectors;
    if (ids.length) selectors = ids.map(id => ({ id }));
    else {
      const doc = loadProject(projectDir).groups.find(g => g.name === 'root').doc;
      const us = Math.round(at * 1e6);
      const hits = [];
      for (const [ti, track] of (doc.tracks || []).entries()) {
        if (track.type !== 'video') continue;
        if (track.flag === 0) continue;
        if (/^\d+$/.test(String(args.track || '')) && ti !== Number(args.track)) continue;
        if (args.track && !/^\d+$/.test(String(args.track)) && track.name !== String(args.track)) continue;
        for (const s of track.segments || []) {
          const tr = s.target_timerange;
          if (tr && tr.start <= us && us < tr.start + tr.duration) hits.push(s);
        }
      }
      if (hits.length !== 1) {
        throw new CapcutError(`replace-media: ${hits.length} clips cover ${args.at}s. Pass --track NAME|N or --segments ID.`, { exitCode: 2 });
      }
      selectors = [{ id: hits[0].id }];
    }
    let all = false;
    if (args.all) {
      // Every clip on the material the named clip plays: swapping the room composite is one
      // command, not one per clip. Each keeps its own source window, keyframes and masks.
      const doc = loadProject(projectDir).groups.find(g => g.name === 'root').doc;
      const named = selectors[0].id;
      const segment = (doc.tracks || []).flatMap(t => t.segments || []).find(s => s.id === named);
      if (!segment) throw new CapcutError(`replace-media: no segment matched {"id":"${named}"}.`, { code: 'SELECTOR_EMPTY', exitCode: 2 });
      if (!segment.material_id) throw new CapcutError(`replace-media: segment ${named} has no material.`, { code: 'MISSING_MATERIAL_REF', exitCode: 2 });
      selectors = [{ material_id: segment.material_id }];
      all = true;
    }
    const probe = await probeOrOverride(file, args);
    // One op per clip in one transaction. With localize the first op copies the file in and
    // the rest find that copy (localizeMedia matches contents), so it is copied once.
    const operations = selectors.map(selector => ({
      op: 'replace.media',
      selector,
      ...(all ? { all: true } : {}),
      path: path.resolve(file),
      retime: Boolean(args.retime),
      // The derived file starts --derived-offset seconds into the original: shift the window.
      ...(args.derivedOffset != null ? { remapDerivedWindow: true } : {}),
      localize: !args.noLocalize,
      width: probe.width,
      height: probe.height,
      mediaDuration: probe.duration,
      ...originOptions(args)
    }));
    return print(applySpec(projectDir, { version: 1, name: 'replace-media', operations }, options), true);
  }
  if (command === 'ripple') {
    if (args.from == null || args.to == null) throw new CapcutError('ripple requires --from S --to S', { exitCode: 2 });
    return print(applySpec(projectDir, { version: 1, name: 'ripple', operations: [{
      op: 'timeline.ripple', from: num(args, 'from', { min: 0 }), to: num(args, 'to', { min: 0 }) }] },
      { ...options, dryRun: Boolean(args.dryRun) }), true);
  }
  if (command === 'sfx') {
    const hasSound = args.sound != null && args.sound !== true && String(args.sound) !== '';
    const hasFile = args.file != null && args.file !== true && String(args.file) !== '';
    if (hasSound === hasFile) {
      throw new CapcutError('sfx takes exactly one of --sound typing|click|enter|"PALETTE NAME" or --file PATH.',
        { code: 'SFX_SOURCE', exitCode: 2 });
    }
    const cues = String(args.cues || '').split(',').filter(Boolean).map(item => {
      const parts = item.split(':');
      if (parts.length > 3) throw new CapcutError(`--cues item "${item}" is AT[:DUR[:SRC]].`, { code: 'BAD_NUMBER', exitCode: 2 });
      const [at, dur, src] = parts.map(part => parseNumber(part, '--cues', { min: 0, list: args.cues }));
      return { at, ...(dur != null ? { dur } : {}), ...(src != null ? { src } : {}) };
    });
    const sfxVolume = num(args, 'volume', { min: 0 });
    const fadeIn = num(args, 'fadeIn', { min: 0 });
    const fadeOut = num(args, 'fadeOut', { min: 0 });
    const lead = num(args, 'lead', { min: 0 });
    const op = { op: 'sfx.place', cues,
      ...(hasSound ? { sound: String(args.sound) } : { file: path.resolve(String(args.file)) }),
      ...(sfxVolume != null ? { volume: sfxVolume } : {}),
      ...(fadeIn != null ? { fadeIn } : {}),
      ...(fadeOut != null ? { fadeOut } : {}),
      ...(lead != null ? { lead } : {}),
      ...(args.track != null ? { track: String(args.track) } : {}) };
    return print(applySpec(projectDir, { version: 1, name: 'sfx', operations: [op] }, { ...options, dryRun: Boolean(args.dryRun) }), true);
  }
  if (command === 'localize') {
    return print(applySpec(projectDir, { version: 1, name: 'localize', operations: [{ op: 'media.localize' }] }, options), true);
  }
  if (command === 'trim' || command === 'shift' || command === 'split' || command === 'remove' || command === 'volume' || command === 'keyframe' || command === 'fade' || command === 'animate') {
    const { resolveClip } = await import('./add.mjs');
    // Every number is checked before the draft is read, so a typo fails with BAD_NUMBER rather
    // than a selector error, and long before anything is written.
    const at = num(args, 'at', { min: 0 });
    let make;
    if (command === 'animate') {
      if (!args.intro && !args.outro) throw new CapcutError('animate requires --intro SLUG and/or --outro SLUG.', { exitCode: 2 });
      const introDuration = num(args, 'introDur', { min: 0 });
      const outroDuration = num(args, 'outroDur', { min: 0 });
      make = selector => ({
        op: 'animation.apply',
        selector,
        ...(args.intro ? { intro: String(args.intro) } : {}),
        ...(args.outro ? { outro: String(args.outro) } : {}),
        ...(introDuration != null ? { introDuration } : {}),
        ...(outroDuration != null ? { outroDuration } : {}),
        ...(args.replaceExisting ? { replace: true } : {}),
      });
    } else if (command === 'remove') {
      make = selector => ({ op: 'segment.remove', selector });
    } else if (command === 'volume') {
      if (args.level == null) throw new CapcutError('volume requires --level 0..1', { exitCode: 2 });
      const level = num(args, 'level', { min: 0 });
      make = selector => ({ op: 'segment.patch', selector, set: { volume: level } });
    } else if (command === 'trim') {
      let src = null;
      if (args.src) {
        const parts = String(args.src).split(/[-:,]/);
        if (parts.length !== 2) throw new CapcutError('--src expects IN-OUT in source seconds', { exitCode: 2 });
        const [a, b] = parts.map(part => parseNumber(part, '--src', { min: 0, list: args.src }));
        if (!(b > a)) throw new CapcutError('--src expects IN-OUT in source seconds', { exitCode: 2 });
        src = [a, b];
      } else if (args.start != null && args.dur != null) {
        const startS = num(args, 'start', { min: 0 });
        src = [startS, startS + num(args, 'dur', { min: 0 })];
      } else {
        throw new CapcutError('trim requires --src IN-OUT or --start S --dur S', { exitCode: 2 });
      }
      const retime = Boolean(args.retime);
      make = selector => ({ op: 'clip.trim', selector, src, ...(retime ? { retime: true } : {}) });
    } else if (command === 'split') {
      if (at == null) throw new CapcutError('split requires --at SECONDS (timeline) and --segments ID or --track NAME|N.', { exitCode: 2 });
      make = selector => ({ op: 'clip.split', selector, at });
    } else if (command === 'shift') {
      if (args.by == null) throw new CapcutError('shift requires --by SECONDS', { exitCode: 2 });
      const by = num(args, 'by');
      make = selector => ({ op: 'clip.shift', selector, by });
    } else if (command === 'fade') {
      const fadeIn = num(args, 'in', { min: 0, def: 0 });
      const fadeOut = num(args, 'out', { min: 0, def: 0 });
      make = selector => ({ op: 'clip.fade', selector, in: fadeIn, out: fadeOut });
    } else {
      const from = num(args, 'from', { min: 0 });
      const to = num(args, 'to', { min: 0 });
      const hold = num(args, 'hold', { min: 0 });
      const ramp = num(args, 'ramp', { min: 0 });
      make = selector => ({ op: 'keyframe.scale', selector, at, from, to, hold, ramp, track: args.track,
        focus: args.focus, viewport: args.viewport, clear: Boolean(args.clear),
        // Easing is the default (Q01); the flags only ever turn it off or force position on.
        ease: !args.noEase, easePosition: args.easePosition ? true : !args.noEase });
    }
    // remove, volume, fade and animate take a list: one op per id in ONE transaction, so it is
    // one snapshot, and one unknown id fails the whole list (SELECTOR_EMPTY) rather than half
    // of it. trim, shift, split and keyframe act on one clip and refuse a list instead of quietly
    // acting on its first id.
    const ids = ['remove', 'volume', 'fade', 'animate'].includes(command)
      ? segmentIds(args)
      : [singleSegment(command, args)].filter(Boolean);
    // --segments names the clips outright; only an --at lookup needs the draft.
    const selectors = ids.length
      ? ids.map(id => ({ id }))
      : [{ id: resolveClip(loadProject(projectDir).groups.find(g => g.name === 'root').doc,
        { at, track: args.track }).segment.id }];
    const operations = selectors.map(make);
    if (args.plan && (command === 'animate' || command === 'fade')) {
      return print(operations.length === 1 ? operations[0] : operations, true);
    }
    return print(applySpec(projectDir, { version: 1, name: command, operations }, options), true);
  }
  if (command === 'preview') {
    const out = args.out || 'preview.mp4';
    const script = path.join(HERE, '..', 'tools', 'frame_qa.py');
    const fps = args.fps == null ? 6 : Number(args.fps);
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new CapcutError('preview requires --fps greater than zero.', { code: 'BAD_FPS', exitCode: 2 });
    }
    const previewArgs = ['--project', projectDir, '--preview', path.resolve(out),
      '--fps', String(fps)];
    if (args.from != null) previewArgs.push('--from', String(args.from));
    if (args.to != null) previewArgs.push('--to', String(args.to));
    if (args.resolution != null) previewArgs.push('--resolution', String(args.resolution));
    if (args.native) previewArgs.push('--native');
    if (args.noCache) previewArgs.push('--no-cache');
    if (args.noGrade) previewArgs.push('--no-grade');
    if (args.maxMinutes != null) {
      const maxMinutes = Number(args.maxMinutes);
      if (!Number.isFinite(maxMinutes) || maxMinutes < 0) {
        throw new CapcutError('preview requires --max-minutes of zero (off) or more.', { code: 'BAD_MAX_MINUTES', exitCode: 2 });
      }
      previewArgs.push('--max-minutes', String(maxMinutes));
    }
    const python = pythonForTool('frame_qa.py', { argv: previewArgs });
    let status;
    try { status = await runPython(python.executable, script, previewArgs, contentRangeEnv(projectDir)); }
    catch (error) { throw new CapcutError(`could not run ${script}: ${error.message}`, { exitCode: 2 }); }
    if (status === 3) {
      // frame_qa printed why (the projection or the stall) and the lighter options.
      throw new CapcutError('preview stopped: it would overrun its time budget or stopped advancing; '
        + 'retry at the default --fps 6, a shorter --from/--to, or --max-minutes 0.',
      { code: 'PREVIEW_TOO_SLOW', exitCode: 3 });
    }
    process.exitCode = status;
    return;
  }
  if (command === 'diff') {
    const { resolveSnapshotDir } = await import('./core.mjs');
    const { summarizeProject, diffSummaries } = await import('./diff.mjs');
    let otherDir = args.against ? resolveProject(args.against, root) : null;
    if (args.snapshot && !otherDir) otherDir = resolveSnapshotDir(projectDir, String(args.snapshot)).snapshotDir;
    if (!otherDir) throw new CapcutError('diff requires --against NAME or --snapshot NAME', { exitCode: 2 });
    const before = summarizeProject(otherDir);
    const after = summarizeProject(projectDir);
    const report = diffSummaries(before, after);
    if (args.allow != null) {
      const { parseAllow, scopeCheck, materialUsers } = await import('./diff.mjs');
      let allow;
      try { allow = parseAllow(args.allow); }
      catch (error) { throw new CapcutError(error.message, { code: 'DIFF_ALLOW', exitCode: 2 }); }
      report.scope = scopeCheck(report, allow, materialUsers(before, after));
      if (!report.scope.ok) process.exitCode = 1;
    }
    return print(report, true);
  }
  if (command === 'captions') {
    if (args.restyle) return print(applySpec(projectDir, {version:1, name:'captions-restyle', operations:[{op:'captions-restyle'}]}, options), true);
    if (args.reposition) return print(applySpec(projectDir, {version:1, name:'captions-reposition',
      operations:[{op:'captions-reposition', ...(args.clamp ? {clamp:true} : {})}]}, options), true);
    const { runCaptions } = await import('./captions-run.mjs');
    return print(await runCaptions(projectDir,args,options),true);
  }
  if (command === 'motion') {
    if (args.asset != null && args.logo != null) throw new CapcutError('Use either --asset or --logo, not both.', { code: 'MOTION_INPUT' });
    const op = {op:'motion', recipe:args._[1] || 'orbit-glow'};
    for (const key of ['name','text','logo','at','duration','scale','x','y','color','accent']) if(args[key] != null) op[key]=args[key];
    if (args.asset != null) op.logo = args.asset;
    op.name ??= `${op.recipe}-${Number(op.at ?? 0)}`;
    return print(applySpec(projectDir,{version:1,operations:[op]},options),true);
  }
  if (command === 'apply') {
    if (!args.spec) throw new CapcutError('apply requires --spec FILE.', { exitCode: 2 });
    return print(applySpec(projectDir, readJson(path.resolve(args.spec)), options), true);
  }
  throw await unknownCommandError(command);
}
