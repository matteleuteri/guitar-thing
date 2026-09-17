# AGENTS.md — Guide for AI coding tools

Instructions for working in this repo. Read this before editing so you keep behavior
consistent with what the user already approved.

## What this project is

A dependency-free browser app ("Note/Chord Finder") with two instrument modes:

1. Takes a set of notes (pitch classes) and an instrument (guitar or piano).
2. **Guitar** — highlights every fretboard position of those notes on a color-coded
   grid (frets 1..N only — open-string dots are intentionally omitted), then lists
   **one** chord — the full set of provided notes — and every voicing of it where all
   muted-string rules hold and all fretted positions sit within a configurable fret
   span (default 5).
3. **Piano** — the linear analogue: a keyboard over a MIDI range with every occurrence
   of each note marked, plus every voicing within a configurable reach in semitones
   (default 12, an octave reach with two hands = up to 10 keys).
4. Lets you play each voicing via Web Audio pluck synthesis.

## Commands

- `npm run build` — compile TS (`src/` → `dist/` via `tsc`, tsconfig at repo root).
- `npm start` — build, then run `node server.mjs` (zero-dep static server, port 5173).
- `npm test` — build + `node scripts/smoke.mjs` (imports compiled `dist/`, asserts
  theory/fingering invariants + perf). Always run before declaring a change done.
- `node server.mjs` directly to serve without rebuilding.
- `npm run debug` — build, then serve so the audio harness at
  `/debug/audio-debug.html` works.

The app is served over HTTP (`http://localhost:5173`). ES modules do not load from
`file://`, so the static server is required to try the UI.

## Deployment (GitHub Pages)

The live site is https://matteleuteri.github.io/guitar-thing/. It is **not** built
from the local `dist/` (that folder is gitignored). CI owns it:

- `.github/workflows/pages.yml` runs on every push to `main`: `npm ci` → `npm run
  build` → copies `index.html`, `style.css`, `dist/`, `debug/` into `_site/` →
  uploads as a Pages artifact → `actions/deploy-pages`. No secrets used.
- Live site updates a minute or two after a push. `gh run watch` on the latest
  run, or the Actions tab, shows progress/failures.
- Local development is fully independent: edit → `npm run build` → `node
  server.mjs` → `localhost:5173`. Committing without pushing never affects the
  live site.
- All asset paths in `index.html` (`style.css`, `./dist/main.js`, `debug/`) are
  relative, so the `/guitar-thing/` subdirectory hosting works unchanged.

## Structure

- `index.html`, `style.css` — single page, dark theme. CSS class prefixes: `fb-`
  (fretboard positions), `cd-` (chord diagram), `.diagrams`, `.chord-card`.
- `src/theory.ts` — pitch classes, parsing, tunings, chord-name identification.
- `src/fretboard.ts` — `findPositions` + `findFingerings` (guitar core algorithm).
- `src/piano.ts` — `findPianoKeys` + `findPianoVoicings` (piano core algorithm).
- `src/render.ts` — DOM builders: `el()`, `colorFor()`, `renderPositions()`,
  `renderChordDiagram()`, `renderPiano()`/`renderPianoVoicing()`, finger/barre helpers.
- `src/audio.ts` — public sound API (`playVoicing`, `playNotes`, `stopAudio`);
  lazy `AudioContext` + shared graph, worklet loading, per-note scheduling.
- `src/synth/config.ts` — single `PluckAudioConfig`/`DEFAULT_CONFIG` with every
  sound knob (string sustain/brightness, pick attack, scoop, detune/jitter/peak,
  body EQ, room tail, ring length).
- `src/synth/pluck-worklet.ts` — `registerProcessor("pluck-string")`: a
  Karplus–Strong physical string running on the audio thread. Self-contained:
  must NOT be imported by main-thread code (its `registerProcessor` would crash);
  `audio.ts` loads it with `audioWorklet.addModule(new URL("./synth/pluck-worklet.js", import.meta.url).href)`.
  Gotcha (bit us): node options arrive as the **processor constructor argument**;
  there is no `this.options` — read `options.processorOptions` in the constructor.
- `src/synth/shared.ts` — shared post-string chain: voice bus → body peaking EQ →
  dry + damped feedback-delay room → master gain → compressor.
- `src/main.ts` — UI wiring, form handling, guitar/piano orchestration (entry point).
- `scripts/smoke.mjs` — Node checks of the compiled output.
- `server.mjs` — zero-dep Node HTTP static file server (root = cwd).

Runtime dependencies: **none**. TypeScript is the only devDependency. No frameworks.

## Key models & invariants (do not break these without asking)

- Notes are pitch-class integers `0..11` (`C=0 … B=11`). See `SEMITONES`/`SHARP_NAMES`.
- Tunings are arrays of MIDI note numbers, one per string, **index 0 = lowest
  (thickest) string** (low E in standard), 6 entries.
- A note at `(string s, fret f)` has MIDI `tuning[s] + f`, pitch class `(tuning[s]+f) % 12`.
  `fret 0` = open string.
- `findPositions` returns every matching `{string, fret, pc}`. The renderer drops
  `fret 0` entries (user request: open notes should not show in the positions grid).
- `findFingerings(chordPcs, tuning, maxFrets, span, cap)`:
  - `chordPcs` is the **full input note set** — every provided note must sound at
    least once. There is exactly one chord per query (user request: "all the notes
    provided instead of only a subset"). Minimum 2 notes (user request).
  - Muted strings allowed (`fret: null`); each sounding string must sound a chord note.
  - At least 2 strings sound.
  - All sounded frets fit in a window of `span` frets (open strings = fret 0).
  - Enumerates per-"anchor" (minimum fret) windows `0..maxFrets-span`; a shape is only
    produced at the anchor equal to its minimum fret (guarantees unique shapes).
  - `cap` truncates; `truncated` flag is returned. Order of fingerings is not
    musically ranked — don't add heavy heuristics without asking.
- `findPianoVoicings(pcs, low, high, reach, cap)` — same "one chord from the full
  note set" contract for piano:
  - A voicing is a set of pressed keys (MIDI numbers) covering every note, with at
    least 2 and at most `MAX_KEYS` (10 = two hands) keys.
  - All keys lie within `reach` semitones. Anchored at their lowest key, so each
    keyset is unique. Reaches > 11 semitones can double a pitch class across
    octaves, so coverage is tracked by distinct pitch classes (suffix-union pruning,
    `NODE_BUDGET` guard). `truncated` flag behaves like the guitar path.
- `renderPiano`/`renderPianoVoicing` draw an 88-key-style keyboard (white keys in a
  flex row, black keys absolutely positioned by white-key-count offset).
- Notes are selected from a **12-slot grid** (`#note-grid`; default C·E·G), toggled in
  `main.ts`; colors reuse `colorFor(pc)`. Buttons show both spellings via `noteLabels(pc)`
  (`SHARP_NAMES`/`FLAT_NAMES` in `theory.ts`, e.g. "C#/Db"), used only on the grid —
  dots/cards/legend stick to sharps. The old free-text parsing (`parseNotes`) still
  exists for the smoke tests and the custom-tuning parser (`parseStringMidi`, accepts
  `note + octave`, e.g. `Db3`). Spelling docs live in `README.md` under "Note selection".
- Instrument-aware language: section headings, the span label, and card wording switch
  ("Fretboard positions"→"Keyboard positions", "Chord fingerings"→"Chord voicings",
  span: "frets" vs "keys"). Per-instrument span values are remembered (guitar default 5,
  piano default 12) and restored on switch (`spans`/`SPAN_DEFAULTS`/`saveSpan` in
  `main.ts`, tracked via `currentInstrument` — reading `select.value` in the `change`
  handler gives the NEW value, so save the previous one first).
- `chordName(pcs)` identifies via interval-pattern dictionary keyed from a candidate
  root; prefers the lowest pitch class as root; returns `{primary, alternatives}`.

## Rendering details

- `colorFor(pc)` = `hsl(pc*30 % 360 ...)` — hue is fixed per pitch class so the
  fretboard, legend, and chord dots always agree.
- Positions grid is a **single CSS grid** (`.fb`): columns = string label, nut,
  `repeat(var(--col-count), 1fr)` for frets **1..maxFrets**. Rows are
  `display: contents` (`fb-row`, `fb-fretrow`); the nut is one tall grid cell
  (`grid-column: 2; grid-row: 1 / 7`) between labels and frets. The fret-number row
  is the last grid row and starts at `1`.
- Chord diagram (`chord-diagram`): head row of `×`/`○` markers, body rows for each
  fretted position, finger-number footer, barre annotations, sounding-note string.
  A `▶` play button (`.cd-play`, absolutely positioned top-right; extra right padding
  keeps it clear of the diagram) calls `playVoicing(frets, tuning)`.
- Piano keyboards are sized by one CSS variable `--key-w` (set by the piano-only
  **"Key size (rem)"** input via `applyKeySize` in `main.ts`, default 3). White-key
  width cap, keyboard/board height, and label fonts all derive from it in `style.css`
  with `calc(...)`, keeping the piano ratio; keyboards are capped-width + centered
  (`margin: 0 auto`) so keys don't stretch wide. Black keys render as children of the
  white-key row so their `left: (leftCount / whiteCount * 100)%` stays exact.
- Click-to-play: every keyboard key (`playNotes([midi])`) and every fretboard
  position dot (`playNotes([tuning[s] + f])`) plays its own note on click; voicing
  mini-keyboards are key-playable too, alongside their ▶ whole-voicing button.

## Audio

- `audio.ts` is asynchronous internally: `playVoicing`/`playNotes` are called
  from click handlers but each schedules onto a promise chain so the first click
  can await the `AudioWorklet` module load (first sound may lag one click).
- Every note is a `pluck-string` worklet node (Karplus–Strong: excitation noise
  into a damped self-resonating delay line tuned to `1/freq`). The processor
  self-stops after `ringFrames`; `audio.ts` frees each node via a timer.
- Voices share one graph (`shared.ts`): voice bus → body peaking EQ (low +
  presence) → dry path *and* room tail (feedback delay, dampened lowpass) →
  master gain → compressor → destination.
- Voice separation is deliberate and **systematic**, not random. Each guitar
  string has a fixed identity in `voices[]` (index 0 = lowest/thickest) — not
  just brightness, but a full per-string profile: pickup-style EQ (`eq`:
  dark lowpass + warm body peak on wound strings, rising presence peaks on the
  plains), an attack envelope (`attackMs`: bass strings thump in slow, treble
  snaps fast), plus `pick` scrape, `scoopCents`, sustain and damping. On top,
  `roles.*` accents the root pitch class (root = lowest sounding pc, derived
  inside `playVoicing` — no wiring needed): roots are louder, slightly darker,
  lighter-picked, and ring a touch longer (`rootSustainAdd`/`colorSustainAdd`
  are near-1 additions, not multipliers); color tones get a brightness/pick
  lift so intervals articulate. Only a thin random sliver (`variation.*`,
  deliberately small now) humanizes on top.
- A guitar voicing strums **top string first** (treble → bass, like a
  downstroke) using `strum.pattern` (index = hit position, treble-first):
  the k-th hit starts `guitarMs * sum(pattern[0..k-1])` in, so the treble
  bursts out and a final wide gap "blooms" into the bass string
  (`pattern` default `[0.9, 0.8, 0.8, 0.9, 1.1, 1.4]`), plus random ±
  `strum.jitterMs`; piano keys roll every `strum.pianoMs` (8 ms). Stereo
  sweeps bass-left → treble-right (`panning.spread`). Without all this a chord
  fuses into a single pluck — identical transients collapse into one sound.
- String "ring" is controlled by two knobs: `string.sustain` (per-sample loop
  gain — a guitar-like long ring needs ~0.9998+, NOT ~0.99 which collapses in
  ~100 ms) and `string.damping` (loop lowpass, 0 = bright/long harmonics,
  1 = dull/short). Raising sustain + brightening damping is what stopped chords
  from reading as one percussive blip.
- Humanization (`startVoice`): random detune (`detuneCents`), start jitter
  (`jitterMs`), and a per-string peak that boosts the bass string. Attack scoops
  come from each string's `voices[s].scoopCents` (the thick two get one); piano
  notes (`playNotes`) strike clean through a plain random profile.
- `stopAudio()` posts a `stop` message to every live worklet node and
  disconnects it (simpler than the old oscillator teardown).
- All knobs live in `src/synth/config.ts` (`DEFAULT_CONFIG`); the documented
  shape of the pipeline is written in that file's header. Strum speed is also
  user-configurable from the UI: the "Strum speed (ms)" input in the guitar
  block writes `DEFAULT_CONFIG.strum.guitarMs` live (0 = all strings at once),
  so audio settings need no code change to A/B.
- Note: Web Audio can't run under Node, so the smoke suite exercises no audio —
  sound changes are verified by ear in the browser.

## Conventions & gotchas

- TS: strict + `noUnusedLocals`. tsconfig uses `moduleResolution: "Bundler"` which is
  why import specifiers end in `.js` (they resolve to the `.ts` files; they must stay
  `.js` for the compiled ESM output + browser).
- Follow existing style: plain functions in small domain modules, DOM built with the
  `el(tag, class, text)` helper. Keep code comment-light (jsdoc-style doc block on the
  main exported function is the norm).
- `dist/` and `node_modules/` are gitignored. Build before running smoke/server.
- `npm test` is the verification gate — it exercises parse, naming, positions,
  standard + worst-case perf, plus 2-note dyad invariants. A separate throwaway
  property test (inline `node -e`) verified ~10k fingerings have zero violations
  (valid notes, full coverage, span ≤ limit).
- If behavior needs changing, it's usually in `fretboard.ts` (search) or `main.ts`
  (what's listed / card layout).

## Progress notes / debugging history

Timeline of the audio work (the "still sounds like one string" saga):

1. **First pass** — six `pluck-string` worklet nodes fired per voicing, but every
   string shared one identical pluck tone and everything rang in near-perfect sync.
   Result: it read as a single fused "plop".
2. **Stereo + rolls** — added per-string panning (`panning.spread`), strum roll
   (`strum.guitarMs`) and random ±timbre variation (`variation.*`). Better, but
   still pressed into one note.
3. **Root cause A: sustain & damping** — measured a single string's decay in
   headless Chrome: `string.sustain: 0.996` (per-sample loop gain) collapses a
   note in ~100 ms, and the fixed 0.5-averaging damping killed harmonics almost
   instantly. Fixed by making loop damping a configurable one-pole filter
   (`string.damping`, 0 = bright/long harmonics) and raising sustain to
   `0.99985`. A chord now rings properly; harmonics last.
4. **Root cause B: compressor squeeze** — the harsh output compressor was
   slamming the whole six-string attack at once. Relaxed to ratio 2.5 / -16 dB.
5. **Downstroke** — reversed the roll so the voicing strums **treble → bass**
   (top string first, like a real hand), spaced `strum.guitarMs` apart (120 ms)
   with hand-like ±`strum.jitterMs`. Added `variation.velocitySpread` so each
   string hits at slightly different force.
6. **Debug harness (keep!)**: `npm run debug` → open
   `/debug/audio-debug.html`. Auto-strums a few open chords and shows (a) the
   post-strum RMS envelope, (b) the exact scheduled voice log from
   `getAudioDebugEvents()` (proving *how many* voices launched and when — this
   is the ground truth for "is it one string or not"), and (c) the strongest
spectral peaks of the ring. `src/audio.ts` exposes `debugTap()` (pre-comp
    master tap) and `getAudioDebugEvents()`; both are tiny, no-op-until-called,
    and are intentionally permanent. The voice log now shows each note's
    `role` + `brightness/damping/sustain/pick` so systematic per-string identity
    is provable at a glance.
7. **Per-string identity + roles (the "smarter per-note sound")** — replaced the
   flat random timbre with `voices[]` (6 fixed string characters: wound/dark
   lows → plain/bright highs) and `roles.*` (root pitch class
   louder/darker/longer, color tones brighter/more articulate), plus a
   hand-shaped `strum.pattern` (`[0.9, 0.8, 0.8, 0.9, 1.1, 1.4]`: treble bursts
   out, wide final gap blooms into the bass). Random `variation.*` shrunk to a
   thin sliver so the systematic structure dominates. Direction agreed with the
   user first (String + role + strum, pronounced separation).
8. **Per-string pickup voicings + attack envelopes** — user still heard "one
   sound", so each `voices[s]` grew a real tonal identity beyond brightness:
   an `eq` (dark lowpass + warm body peak for wound strings, rising presence
   peaks 700→1800→3600 Hz for the plains — like guitar pickups) and an
   `attackMs` envelope (bass 11 ms thump → treble 2 ms snap). Verified for
   open C: brightness 0.38→1.00, damping 0.80→0.19, att 11→2 ms, eq
   LP1000/PK180 → PK3600. The strum speed also became a top-level UI input
   ("Strum speed (ms)", 0 = all at once) writing `cfg.strum.guitarMs` live.

Verified multi-string behaviour: headless run of the harness schedules 6 voices
at ~120 ms steps, treble-first, pan sweeping left→right, and the sustain
spectrum shows the full chord (C: E2/C3/G3/E3/C4/E4 all present) at healthy
level after ~1.4 s. Since the systematic `voices`/`roles` rewrite the per-string
parameters are fully deterministic (see entry 7); any remaining "still sounds
fused" complaint is a *perceptual* timing/timbre question — turn `strum.*`,
`voices[]`, `roles.*`, `panning.spread`, `string.sustain`, `string.damping` in
`DEFAULT_CONFIG`, then re-check with the harness.

## Dev branches & the frozen public site

The user wants the live Pages site **frozen as-is** while audio work continues.
Policy:

- `.github/workflows/pages.yml` only deploys on push to `main`. Anything committed
  to any other branch never touches the live site.
- All in-progress audio/experimental work happens on the `dev-audio` branch;
  `main` only receives changes the user approves for release.
- Local dev loop (unchanged): `npm run build && node server.mjs` →
  `localhost:5173`; `npm test` as the gate. Audio experiments are tuned via
  `DEFAULT_CONFIG`, verified with the `/debug/audio-debug.html` harness.

## Backlog / ideas (discuss with the user before building)

- ~~**Smarter per-note sound inside a chord.**~~ **Done** — see progress entry 7:
  `voices[]` per-string character + `roles.*` (root vs color) + hand-shaped
  `strum.pattern`, agreed as "String + role + strum, pronounced separation"
  (commit landed on `dev-audio`; never pushed to the live `main`).
- **Chord-quality-specific behaviour** — the next level beyond roles: make the
  *quality* itself shape voicing (maj7 sparkly, minor dark, sus ambiguous,
  dim tense...). Not started — would be `roles` growing a quality axis. Build
  only after the user signs off on the current sound by ear.