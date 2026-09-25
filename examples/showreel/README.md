# Motion showreel

A 15-second, 1920×1080, 60 fps motion-design reel. Every frame is drawn from code; there are no keyframes, footage or samples. The score is synthesised too.

```sh
node render.mjs                      # → out/showreel.mp4 (about 5 minutes on 4 cores)
node render.mjs --stills 2.1,8.2     # QA stills → out/still-<frame>.png
node score.mjs out/score.wav         # just the soundtrack
```

It needs Playwright's Chromium (local or global `playwright`) and an `ffmpeg` with libx264 and aac on `PATH` (or set `FFMPEG=`).

## How it's built

- **`reel.js`** follows the same contract as `mograph/runtime.js`: the picture at time *T* is a pure function of *T*. There's no wall clock, no `Math.random` and no `requestAnimationFrame`, and all randomness is an integer hash. Because of that, `render.mjs` can split the frame range across browsers and the segments join seamlessly.
- **Motion blur** is real, not a filter. Each frame averages 5 sub-frames across a 180° shutter. After that come chromatic aberration (driven by the same impact list as the camera shake), a vignette and seeded film grain.
- **`score.mjs`** runs at 120 BPM in F minor and shares its timeline with the picture. It covers the kick, clap and hats; a bass and pad sidechained to the kick; one click per grid line; a thud per letter slam; the glitch; bounce thuds; the particle shimmer; bezier playhead ticks; one stab per style frame; and a bell chord for the name card.

## Timeline (one beat = 0.5 s)

| Time | Scene | What happens |
| --- | --- | --- |
| 0.0 | Ignition | A dot appears and squashes in anticipation, then snaps into a line. The line grows a grid, a shockwave passes, and an orange slab takes the frame on the downbeat. |
| 1.5 | Typography | MOTION springs up through a baseline mask, then slice-glitches with an RGB split. An E drops in with squash and stretch to make EMOTION, and outline echoes spring out behind it. The camera dives through the counter of the O. |
| 4.0 | Shape language | A bouncing ball with squash, stretch and a contact shadow morphs through a superellipse into a square. Four sibling shapes burst out of it. A Bauhaus grid ripples in and turns on the beat, then collapses into dots. |
| 6.5 | Particles | The grid's 144 dots become 2,400 particles. They form a sphere, then a trefoil knot (with a pulse on the beat), then the word CRAFT, then explode toward the camera. |
| 9.0 | Timing | A live `cubic-bezier` editor animates its handles and readout. Spacing charts compare eased and linear motion. The curve then thickens into the wipe for the next scene. |
| 11.5 | Style frames | Eight looks, one per eighth note: halftone, rhythm, isometric, liquid, phyllotaxis, kinetic poster, op art and ridgelines. |
| 13.5 | Signature | The opening dot comes back and writes the name, then lands as its full stop. |
