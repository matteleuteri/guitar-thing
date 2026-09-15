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
Web Audio synthesis in `src/audio.ts` (oscillators + lowpass + pluck envelope).

See `AGENTS.md` for architecture and invariants.