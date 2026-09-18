# The round-trip oracle

`doctor` proves a draft is structurally valid. `qa` proves what the picture looks like.
Neither answers the question a **new** CapCut field actually poses:

> When CapCut opens this project and saves it again, does our record still exist, still
> carry our values, and still do anything?

JSON that parses can still be a no-op. A field can survive our write, survive `doctor`,
and be thrown away — or kept with its values quietly put back — the first time the app
touches the draft. Shipping on "the JSON is there" is shipping theatre.

This harness is how a new field earns the right to ship. It is **dev-only**. It writes
nothing into a draft, and it does not drive the CapCut UI. You drive CapCut; it compares
the directories you captured.

## The manual loop

Use a **disposable copy** of a project, never a production draft. CapCut must be closed
whenever you capture.

```bash
# A — before we write anything
capcutctl oracle capture --project DISPOSABLE --label a-before-write

# write the thing you are testing (any capcutctl command, or a hand-built --spec)
capcutctl music --project DISPOSABLE --duck

# B — what we wrote
capcutctl oracle capture --project DISPOSABLE --label b-written

# now open DISPOSABLE in CapCut. Nudge something harmless — drag a clip a frame and put it
# back, or just click into the timeline. Save. Quit and wait for the process to exit.

# C — what came back out
capcutctl oracle capture --project DISPOSABLE --label c-round-tripped

capcutctl oracle diff \
  --before .capcutctl/oracle/b-written \
  --after  .capcutctl/oracle/c-round-tripped \
  --baseline .capcutctl/oracle/a-before-write
```

The baseline is optional. It only sharpens a `reset`: with it, the report can say the value
was put back to what was there before we wrote, rather than merely that ours did not
survive.

`capture` copies the **whole project directory** — root `draft_info.json`, `Timelines/**`,
`draft_meta_info.json`, `template-2.tmp`, and any analysis cache the app materialises on
open. It is deliberately not `capcutctl snapshot`: that copies the curated set of files the
CLI manages, and the interesting part of a round trip is exactly the files it does not.
Our own `.capcutctl/` bookkeeping is skipped, so captures do not capture each other.

## The verdicts

`oracle diff` classifies every id-bearing record — keyframe points, keyframe blocks,
segments, materials, masks — and every file.

| Verdict | Meaning | Success? |
|---|---|---|
| `preserved` | structure survived byte-for-byte | **yes** |
| `normalized` | rewritten — key order, float spelling — behaviour survived | **yes** |
| `materialized-cache` | the app added analysis files we never wrote | **yes** |
| `pruned` | record discarded | no |
| `reset` | record kept, our values did not survive | no |
| `authority-miss` | documents disagree — we wrote a mirror, not the authority | no |
| `resource-noop` | structure survived, pixels did not change | no |

`oracle diff` exits non-zero when any non-success verdict appears. **A `pruned`, `reset`,
`authority-miss` or `resource-noop` record means the field is not production-safe. Do not
ship it. Do not "fix" it by writing the field harder.**

## Reading an unknown field off a real write

Verdicts tell you whether a record survived. A **harvest** needs the record itself — the
property name, the units, the `curveType`, whether a companion material came with it. Pass
`--values` and each finding carries its own before/after JSON:

```bash
capcutctl oracle diff --before A --after B --values
```

That is how you learn what CapCut writes for a field we have never written. Capture before
you touch the app, author the thing by hand in CapCut, capture again, and read the new
records out of the diff. Clone what comes back into `presets/`; never retype it from a
screenshot, and never fill in a field the diff did not show you.

`resource-noop` is the one verdict JSON cannot see. If the record survives intact but the
frame does not change, that is a `qa` finding, and you hand it in:

```bash
capcutctl oracle diff --before B --after C --resource-noop kf-block-volume
```

`authority-miss` is inferred from disagreement: a record that survives in one document and
is dropped from another that used to hold it means one of the two was not the authority.
That is the failure `documentGroups` exists to prevent, so seeing it is a signal the write
path missed a group, not a reason to add a third mirror.

## What this does not do

- **No CapCut automation.** Nothing here clicks the app, and no unit test opens it. The
  harness compares two directories a human (or a later native-bridge session) captured.
- **No pixel opinion.** `resource-noop` is asserted, never inferred.
- **No verdict on fields we did not write.** The diff reports what moved between the two
  captures; a record CapCut rewrites on every save will show up every time, which is
  information about CapCut, not about your change.

## Q02 volume automation evidence — CapCut 9.4.0

Native UI authoring on 2026-09-19 resolved the static-gain interaction:

| UI action | Saved `KFTypeVolume` value |
|---|---|
| Set clip to −20 dB, add first key | `0.10000000149011612` |
| Set second key to −32 dB | `0.025118863210082054` |

`segment.volume` became the last edited value. Key values are **absolute linear
amplitudes**, not multipliers on that field. Source microseconds and the harvested
`Line` curve are preserved in `presets/volume-keyframes.json`.

A separate eight-second disposable project used an existing 0.08 music bed with
0.4/1.2-second fades and synthetic speech intervals 1–2, 2.2–3, and 5–6 seconds.
`music --duck --words` generated ten keys. Native UI readings were:

| Timeline time | Volume shown |
|---|---|
| 0 seconds | −21.9 dB |
| 1.5 seconds, inside speech | −33.9 dB |
| 4.033 seconds, pause | −21.9 dB |

After copying/deleting a temporary second clip to dirty the project, saving, and
quitting, `cli-written` and `native-saved` captures had identical volume blocks
(including ids, times, and values) in both root and active timeline. Original fade
records also matched exactly. Doctor reported zero errors; two B-roll checks were
skipped because the generated test pattern has no change/transcript sidecars.
This verifies the native controls and saved JSON; no export or listening claim.
