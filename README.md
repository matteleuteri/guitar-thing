# Note/Chord Finder

A tiny dependency-free web app that shows every fretboard position of a set of notes and
every chord voicing (with optional sound) that stays within a small fret span.

## Run

```sh
npm install
npm start        # builds + serves on http://localhost:5173
```

`npm test` builds and runs a Node smoke test of the theory/fingering logic.

> The app must be served over HTTP (`file://` blocks ES modules), so use the included
> `server.mjs` rather than opening `index.html` directly.

## Run locally

```sh
npm run build       # compile TS to dist/
node server.mjs     # serve on http://localhost:5173
```

`npm start` does both in one step. `npm test` builds and runs the smoke suite.

## Deploy (GitHub Pages)

The site is **live** at https://matteleuteri.github.io/guitar-thing/. Publishing is
automatic — nothing to run by hand:

1. Push to `main` (or merge a PR into it).
2. `.github/workflows/pages.yml` builds `dist/` from the pushed source and deploys
   it to Pages.
3. The site updates ~1 minute later; watch the run with `gh run watch` or in the
   Actions tab.

Local work never touches the live site: your local `dist/` is gitignored, and the
deployed build comes from CI, not your folder. Commit + push is the only thing that
releases new code.

## Usage

1. **Pick notes** — click pitch classes on the note grid to add or remove them. `C · E · G`
   is preselected; each button fills with the same color the dots use on the board.
2. Pick an instrument:
   - **Guitar** — choose a tuning (Standard, Drop D, Open G/D, DADGAD, half/whole-step
     down, or Custom) and a fret count. **Fretboard positions** shows every spot on the
     neck where those notes live, color-coded (hue is fixed per pitch class;
     open-string spots are omitted). **Chord fingerings** lists one chord built from
     *all* the notes you entered, with every voicing where muted strings are allowed,
     at least 2 strings ring, and all frets lie within ~5 frets of each other.
   - **Piano** — set a MIDI key range. The keyboard marks every occurrence of each note;
     **voicings** are every set of pressed keys (up to 10, two hands) covering all your
     notes and lying within ~12 semitones of each other (an octave reach).
   - Both modes use the **max span/reach** and **cap** fields, and let you play each
     voicing with **▶** (Web Audio synth — needs a click due to autoplay policy).
3. Adjust **Max span (frets)** / **Max reach (semitones)** to loosen or tighten the
   chord window.

Each card shows the chord name (with "also …" aliases for ambiguous spellings like
`ACEG` = `C6` / `Am7`). Guitar diagrams show open/mute markers, dots with note letters,
suggested finger numbers, barre notes, and the sounding notes. Piano voicings render as
mini keyboards with the pressed keys filled in.

## Note selection

Notes are picked from the grid of 12 pitch classes (shown with sharps). Click to
toggle; C·E·G is preselected. Duplicates aren't possible, order doesn't matter.

| Sharp | Flat | Sharp | Flat |
|-------|------|-------|------|
| C     | —    | F#    | Gb   |
| C#    | Db   | G     | —    |
| D     | —    | G#    | Ab   |
| D#    | Eb   | A     | —    |
| E     | —    | A#    | Bb   |
| F     | —    | B     | —    |

**Custom tuning field** (one per string, low → high): note + optional octave.

- `E2 A2 D3 G3 B3 E4` = standard tuning.
- Flats fine too: `Db3`, `Eb2`, `Bb1`.
- Omit an octave to use the default for that string slot (`2 2 3 3 3 4`).

## Tech

Vanilla TypeScript → ES modules, no frameworks, zero runtime dependencies.

**Sound.** Every note is a physically-modeled plucked string: a Karplus–Strong
delay-line resonator (`src/synth/pluck-worklet.ts`) with a pick-attack transient,
body-resonance EQ, a small room tail, and per-note humanization (detune, timing
jitter, an attack scoop on the low strings, and a slight stereo spread with bass
left / treble right). Guitar chords strum treble → bass one string at a time
(~120 ms apart, ±jitter so it doesn't tick like a sequencer) and piano voicings
roll ~8 ms so voices don't fuse. All of it — including the strum roll,
per-string timbre variation, and pan — is tunable from one config constant:
`DEFAULT_CONFIG` in `src/synth/config.ts`. The piano uses the same
plucked-string voice; solo keys strike clean (no scoop).

**Debugging the sound.** `npm run debug` then open
`/debug/audio-debug.html`: it auto-strums a few chords and shows the RMS
envelope, the exact count/timing of scheduled voices (ground truth for "is it
one string or not"), and the strongest spectral peaks of the ring.

See `AGENTS.md` for architecture and invariants.