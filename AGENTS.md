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

The app is served over HTTP (`http://localhost:5173`). ES modules do not load from
`file://`, so the static server is required to try the UI.

## Structure

- `index.html`, `style.css` — single page, dark theme. CSS class prefixes: `fb-`
  (fretboard positions), `cd-` (chord diagram), `.diagrams`, `.chord-card`.
- `src/theory.ts` — pitch classes, parsing, tunings, chord-name identification.
- `src/fretboard.ts` — `findPositions` + `findFingerings` (guitar core algorithm).
- `src/piano.ts` — `findPianoKeys` + `findPianoVoicings` (piano core algorithm).
- `src/render.ts` — DOM builders: `el()`, `colorFor()`, `renderPositions()`,
  `renderChordDiagram()`, `renderPiano()`/`renderPianoVoicing()`, finger/barre helpers.
- `src/audio.ts` — Web Audio pluck synthesis (`playVoicing`, `playNotes`, `stopAudio`).
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
  `main.ts`; colors reuse `colorFor(pc)`. The old free-text parsing (`parseNotes`) still
  exists for the smoke tests and the custom-tuning parser (`parseStringMidi`, accepts
  `note + octave`, e.g. `Db3`). Spelling docs live in `README.md` under "Note selection".
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

## Audio

- `audio.ts` creates `AudioContext` lazily on first call — it must be triggered from a
  user gesture (browser autoplay policy), which the `▶` click satisfies.
- Each string = 2 oscillators (sawtooth at f, triangle at 2f) → per-note lowpass →
  gain with pluck envelope → master gain → compressor → destination.
- Strum offset low→high string by ~30 ms; bass string boosted. `stopAudio()` kills
  anything still ringing.

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