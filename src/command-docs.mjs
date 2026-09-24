/**
 * One row per command: what it is for, where it sits in the workflow, whether it edits a
 * project through the transaction machinery, and one example that must stay valid.
 *
 * HELP (cli.mjs) remains the source of each command's OPTIONS; this table is the source of
 * everything else the contract says about a command. `TRANSACTIONAL_COMMANDS`, the contract's
 * `summary` / `group` / `example` fields and the generated skill reference
 * (`capcutctl contract --markdown`) all derive from it. test/cli-contract.test.mjs cross-checks
 * it against HELP and the dispatcher in both directions, and checks every example's flags
 * against the contract, so a new command touches this file or the suite fails.
 */
export const GROUPS = Object.freeze([
  ['start', 'Start and inspect'],
  ['aroll', 'Talking head (A-roll)'],
  ['broll', 'Screen recordings (B-roll)'],
  ['look', 'Layouts and picture'],
  ['build', 'One-pass build'],
  ['camera', 'Camera and pace'],
  ['graphics', 'Graphics and text'],
  ['sound', 'Seams, music and mix'],
  ['check', 'Check and review'],
  ['safety', 'Snapshots and repair'],
  ['export', 'Export (explicit request only)'],
  ['dev', 'Development'],
]);

const doc = (group, summary, example, transactional = false) => Object.freeze({ group, summary, example, transactional });

export const COMMAND_DOCS = Object.freeze({
  preflight: doc('start', 'Will this machine work: deps, artwork, SFX palette, drafts folder.', 'capcutctl preflight'),
  projects: doc('start', 'List CapCut drafts.', 'capcutctl projects --json'),
  new: doc('start', 'Create a project (clone of Preset 3, --blank, or --from a draft).', 'capcutctl new --project NAME --blank --dry-run', true),
  inspect: doc('start', 'Tracks, canvas and active timeline as JSON.', 'capcutctl inspect --project NAME'),
  scenes: doc('start', 'Every clip: time, track, desc, media, source; --transcript adds what is said.', 'capcutctl scenes --project NAME --transcript'),
  timeline: doc('start', 'ASCII stacked timeline.', 'capcutctl timeline --project NAME'),
  profile: doc('start', 'The effective style profile (tokens, camera, sound, density, grammar).', 'capcutctl profile'),
  status: doc('start', 'Is CapCut running; optionally wait for it to close.', 'capcutctl status --json'),
  close: doc('start', 'Quit CapCut and wait: writes are refused while it runs.', 'capcutctl close'),
  version: doc('start', 'Installed CLI version.', 'capcutctl version'),
  help: doc('start', 'The full help text.', 'capcutctl help'),
  contract: doc('start', 'The machine-readable command surface; --markdown renders the skill reference.', 'capcutctl contract --markdown'),

  cut: doc('aroll', 'Analyse a face take (transcript, energy, beats), then build the reviewed keep/order.', 'capcutctl cut VIDEO --keep 0,2-9 --order 0,2,3,4,5,6,7,8,9 --dry-run'),

  find: doc('broll', 'When is it on screen (--shows), said (--says) or did anything happen (--moments).', 'capcutctl find "publish" --media screen.mp4 --shows --strip'),
  match: doc('broll', 'Sentence → screen-moment shot list; weak matches stay on the face; --apply writes.', 'capcutctl match --project NAME --screen screen.mp4 --out shots.json', true),
  'verify-shots': doc('broll', 'Blind before/action/after check of placed shots; CONTRADICTED blocks.', 'capcutctl verify-shots --project NAME --shots shots.json'),
  add: doc('broll', 'Place full-frame source media on an overlay track.', 'capcutctl add --project NAME --media screen.mp4 --at 5 --dur 3 --track broll --dry-run', true),
  'replace-media': doc('broll', 'Relink a clip to another file, keeping its keyframes.', 'capcutctl replace-media --project NAME --file new.mp4 --at 5 --track broll --dry-run', true),
  localize: doc('broll', 'Copy outside media into the draft (fixes "Link media").', 'capcutctl localize --project NAME', true),
  trim: doc('broll', 'Change a clip\'s source window.', 'capcutctl trim --project NAME --at 5 --track broll --src 90-94 --dry-run', true),
  shift: doc('broll', 'Move a clip in time.', 'capcutctl shift --project NAME --at 5 --track broll --by 0.2 --dry-run', true),
  remove: doc('broll', 'Remove a clip.', 'capcutctl remove --project NAME --at 5 --track broll --dry-run', true),
  volume: doc('broll', 'Set a clip\'s volume.', 'capcutctl volume --project NAME --at 5 --track broll --level 0 --dry-run', true),
  fade: doc('broll', 'Native audio fade in/out on a clip.', 'capcutctl fade --project NAME --at 5 --track broll --in 0.08 --out 0.12 --dry-run', true),

  layout: doc('look', 'Locked layouts: auto, split-screen, circle, full-face, background, broll, screen; audit.', 'capcutctl layout auto --project NAME --plan', true),
  grade: doc('look', 'Measure colour; explicit corrections; shared adjust layer; face detail.', 'capcutctl grade --project NAME --measure', true),
  reframe: doc('look', 'Keep a moving face framed with native camera keys (Vision).', 'capcutctl reframe --project NAME --auto --plan', true),
  'blur-broll': doc('look', 'Opt-in motion blur for B-roll already ramped past 8x.', 'capcutctl blur-broll --project NAME --segment ID --plan', true),

  build: doc('build', 'After A-roll sign-off: one edit plan → shots, layout, camera, graphics, sound, gate.', 'capcutctl build --project NAME --edit edit.json --dry-run', true),

  zoom: doc('camera', 'Face pushes on stressed words (--stress), or at explicit times.', 'capcutctl zoom --project NAME --stress --plan', true),
  punch: doc('camera', 'Eased push onto a named on-screen element (OCR locates it).', 'capcutctl punch --project NAME --on Publish --segment ID --dry-run', true),
  keyframe: doc('camera', 'Eased camera move: --to scale or --focus a source rectangle.', 'capcutctl keyframe --project NAME --segments ID --at 12 --to 1.3 --hold 1.2 --plan', true),
  pace: doc('camera', 'Speed as arithmetic: compress waiting B-roll, never the face.', 'capcutctl pace --project NAME', true),
  ramp: doc('camera', 'Split a B-roll clip at its result: ramp the wait, land the result at 1x.', 'capcutctl ramp --project NAME --segment ID --speed 20 --dry-run', true),
  cursor: doc('camera', 'Native halo that follows recorded pointer telemetry.', 'capcutctl cursor --project NAME --auto --plan', true),

  mograph: doc('graphics', 'Rendered HTML/JS motion graphics: list, preview, render, add on a word, rerender.', 'capcutctl mograph add --project NAME --template keyword-super --params \'{"text":"أسرع"}\' --say "أسرع" --dry-run', true),
  logo: doc('graphics', 'Brand mark pop with its cue, timed off the transcript or --at.', 'capcutctl logo --project NAME --auto --plan', true),
  brands: doc('graphics', 'Known brands, spoken aliases, and which have artwork.', 'capcutctl brands'),
  endcard: doc('graphics', 'The CTA card on the talking head near the end.', 'capcutctl endcard --project NAME --text Follow --dry-run', true),
  wrap: doc('graphics', 'Logos from what is said + the endcard in one pass.', 'capcutctl wrap --project NAME --plan', true),
  motion: doc('graphics', 'EXPERIMENTAL native text/logo recipes; prefer mograph.', 'capcutctl motion list', true),
  animate: doc('graphics', 'Native CapCut intro/outro animation on a clip.', 'capcutctl animate --project NAME --segments ID --intro fade-in --dry-run', true),

  polish: doc('sound', 'Transitions + paired SFX on picture changes (--motivated).', 'capcutctl polish --project NAME --motivated --dry-run', true),
  music: doc('sound', 'Music bed from a file or brief, aligned to hits; --duck under speech.', 'capcutctl music --project NAME --file bed.mp3 --hits 2.4,8.1 --plan --json', true),
  loudness: doc('sound', 'Measure the edited mix; match speech/SFX to target LUFS with peak headroom.', 'capcutctl loudness --project NAME --measure', true),
  denoise: doc('sound', 'Measure-first voice cleanup; video and timing untouched.', 'capcutctl denoise --project NAME --plan', true),
  finish: doc('sound', 'Scorecard + ASCII (read-only), or --music / --polish writes.', 'capcutctl finish --project NAME', true),

  gate: doc('check', 'Blocking ready-to-post check from the profile\'s motion grammar.', 'capcutctl gate --project NAME'),
  doctor: doc('check', 'Structural integrity; must be error-free before hand-off.', 'capcutctl doctor --project NAME'),
  qa: doc('check', 'Composite real frames (incl. keyframes, grades, mograph clips); --expect gates text.', 'capcutctl qa --project NAME --times 3,9,15 --sheet'),
  preview: doc('check', 'Lightweight proxy with audio.', 'capcutctl preview --project NAME --out preview.mp4'),
  review: doc('check', 'Proxy + EDL + contact sheet into outputs/.', 'capcutctl review --project NAME'),
  diff: doc('check', 'What changed since a snapshot or another project; --allow proves a scoped edit stayed in scope.', 'capcutctl diff --project NAME --snapshot NAME --allow SEGMENT-ID,track:broll'),

  snapshot: doc('safety', 'Snapshot the project.', 'capcutctl snapshot --project NAME --label before-build'),
  history: doc('safety', 'List snapshots.', 'capcutctl history --project NAME'),
  notes: doc('safety', 'Creative log: rejected looks and why, accepted look, decisions, outstanding; survives restore.', 'capcutctl notes --project NAME --reject "orange captions" --why "fights the indigo frame"'),
  restore: doc('safety', 'Restore a snapshot.', 'capcutctl restore --project NAME --snapshot NAME --dry-run', true),
  sync: doc('safety', 'Repair mirror drift and duplicate material ids.', 'capcutctl sync --project NAME --dry-run', true),
  apply: doc('safety', 'Apply a v1 spec of operations transactionally.', 'capcutctl apply --project NAME --spec spec.json --dry-run', true),
  'init-spec': doc('safety', 'A blank v1 spec to fill in.', 'capcutctl init-spec --output spec.json'),
  rm: doc('safety', 'Move a project to the recycle bin (recoverable).', 'capcutctl rm --project NAME --dry-run', true),

  export: doc('export', 'Native CapCut export through the macOS bridge; explicit request only.', 'capcutctl export --project NAME --out final.mp4 --grid grid.png'),
  'check-export': doc('check', 'QA the rendered file: black, flash frames, freezes, dead air, loudness, true peak, canvas and length.', 'capcutctl check-export --media final.mp4 --project NAME'),
  reference: doc('check', 'Measure a reference reel\'s pacing in the gate\'s terms; --profile-out writes the density override.', 'capcutctl reference --media reel.mp4 --project NAME --sheet shots.png'),
  'export-grid': doc('export', 'Labelled frame grid from an existing video.', 'capcutctl export-grid --media final.mp4 --out grid.png --times 0,8,15'),

  harvest: doc('dev', 'Catalogue transitions/SFX/masks/keyframes from real drafts.', 'capcutctl harvest --plan'),
  oracle: doc('dev', 'Dev-only round-trip capture/diff of a disposable project.', 'capcutctl oracle diff --before A --after B'),
});

export const TRANSACTIONAL_FROM_DOCS = Object.freeze(Object.entries(COMMAND_DOCS)
  .filter(([, entry]) => entry.transactional).map(([name]) => name).sort());

/** The generated CLI reference the skills repository ships as capcut-cli/reference.md. */
export function renderReference(contract) {
  const lines = [
    '# capcutctl command reference',
    '',
    `<!-- GENERATED by \`capcutctl contract --markdown\` from CLI ${contract.cliVersion}, contract v${contract.contractVersion}. Do not edit by hand. -->`,
    '',
    'Transactional commands (marked **T**) snapshot, validate both documents and all mirrors, roll back on failure,',
    'refuse while CapCut is open, and take `--dry-run` (resolve, validate, report, write nothing).',
    '',
  ];
  for (const [group, title] of GROUPS) {
    const rows = Object.entries(contract.commands).filter(([, c]) => c.group === group);
    if (!rows.length) continue;
    lines.push(`## ${title}`, '', '| Command | What it is for | Example |', '|---|---|---|');
    for (const [name, c] of rows) {
      const subs = c.subcommands ? ` ${c.subcommands.join('\\|')}` : '';
      lines.push(`| \`${name}\`${subs}${c.transactional ? ' **T**' : ''} | ${c.summary} | \`${c.example.replace(/\|/g, '\\|')}\` |`);
    }
    lines.push('');
  }
  lines.push('## Options', '', 'Every option each command accepts, from `capcutctl contract`.', '');
  for (const [name, c] of Object.entries(contract.commands)) {
    if (!c.options.length) continue;
    lines.push(`- \`${name}\`: ${c.options.map(o => `\`${o}\``).join(' ')}`);
  }
  lines.push('');
  return lines.join('\n');
}
