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

## Current status (break point — read first)

All approved audio work is merged into `main` (and pushed to `origin/main`):
the physical string core (commuted triangle pluck at per-string `pickPos` →
fractional-delay allpass → two-stage damping/`decay`), per-string scrape shape
(`pickBright`/`pickDecayMs`) that separates onsets from the first sample, and
the song/progression mode. `dev-audio` and `song-mode` are merged ancestors
kept for history. **The user approved this sound:** Leads A + C-1 are done and
sounded good. **Parked after user listening:** piano register identity (still
reads as "one sound"), and the *synthesized* convolutional body IR, which
beat/wobbled badly by ear twice and was reverted (a body is only worth
retrying as a *recorded* IR).
**Backlog (discuss before building):** the pitched pre-ring "slap" (the rest
of Lead C), Lead D (spatialization), and the muted-string "thunk".

**Big pivot — smplr sampled guitar (progress 21).** Ear-check of the six
recorded-string setups (progress 20) landed as "just not sounding good" — the
*source* was the six bedroom laptop-mic recordings, not the API. Per the user's
explicit choice the app now plays guitar voicings from a real, consistent GM
steel-guitar kit via **smplr** (purpose-built Web Audio sampler, `smplr@1.0.0`,
the app's first runtime dependency). The kit (`assets/guitar-steel-ogg.js`,
MusyngKite `acoustic_guitar_steel`, ~2.6 MB, MIDI.js `MIDI.Soundfont` format) is
self-hosted and shipped by the existing Pages `assets/` workflow; so is the
vendored smplr build (`assets/smplr.mjs`, `/dist/index.mjs` copied as-is and
imported **module-relative** — the app ships unbundled ESM, so a bare `"smplr"`
specifier would 404 and `node_modules/` isn't deployed; the relative import
works from the root app, the `/debug` harness and the `/guitar-thing/` Pages
subdir). Design: the kit text is fetched **once** (a once-caching wrapper around
smplr's storage — Soundfont would otherwise fetch it once per instance), and
**six `Soundfont` instances, one per string**, sharing a `SampleLoader`, each
writing into its own `[gate → StereoPanner]` chain onto `graph.master`
(bypassing body EQ/IR/room like the samples, since a real guitar already
carries body and room). DecodeAudioData still runs per instance on first load
(smplr decodes before reaching the shared loader; ready only gates routing once
every decode completed, and a failed decode — e.g. Safari lacks ogg/vorbis —
reverts the engine to samples/synth). The music is unchanged: root/color
`roles` reach the sampler as **velocity**, gates hold silent from t=0 (the
one‑sound guard still ours), the treble-first strum spreads, and each string
sits a fixed stereo seat (low E left → high E right). Engine select
`config.engine.mode` (`"smplr" | "samples" | "synth"`, default `"smplr"`) plus
`setEngineMode()` (exported; the harness radio uses it); the K–S synth and the
recorded-string bank remain selectable for A/B and double as fallbacks while
the kit loads or for notes no sample covers. The kit is **pre-loaded on page
load** (`preloadGuitarEngine()` — builds the graph + starts the 2.6 MB
fetch/decode on `DOMContentLoaded`, no gesture needed; the context is simply
created suspended), and a play that lands mid-decode **waits for it, bounded**
(`awaitKitIfLoading(8000)` in `playVoicing`) so the very first click of a
session routes to the kit instead of the samples/synth fallback — the race
that made a fresh page's first strum sound like the old engine. A stuck/failed
kit times out into the fallback after ~8s. `getSmplrStatus()` reports
`{ mode, ready, loading, progress }`; "loading" means the engine is built but
decoding (smplr's progress only ticks AFTER each instance's decode, so it
reads 0/0 through the whole decode phase — the harness status text says
"kit decoding…" during it). The kit path is exercised by
`scripts/audio-sched.mjs` via
`globalThis.__SMPLR_FAKE__` (a stub smplr that records `start()` calls — the
real package would fetch/decode a 2.6 MB kit under Node), asserted: six kit
voices, notes = fretted midis, root/color velocities, fixed distinct pans,
silent-from-zero gates, strum spread. **Needs an ear-check** at
`/debug/audio-debug.html` ("Guitar engine" row) — smplr vs recorded-samples vs
synth; the debug events now carry `kind: "kit"` + `velocity`.
The recorded-string bank (progress 20) is now the *second* engine, not the
target: the stored body IR should be **cleared**; the attack-bloom/sustain
numbers are superseded in priority by the kit.

## Commands

- `npm run build` — compile TS (`src/` → `dist/` via `tsc`, tsconfig at repo root).
- `npm start` — build, then run `node server.mjs` (zero-dep static server, port 5173).
- `npm test` — build + `node scripts/smoke.mjs` (imports compiled `dist/`, asserts
  theory/fingering invariants + perf) + `node scripts/audio-sched.mjs` (stubs Web
  Audio to assert the voice-graph strum/gating invariants). Always run before
  declaring a change done.
- `node server.mjs` directly to serve without rebuilding.
- `npm run debug` — build, then serve so the audio harness at
  `/debug/audio-debug.html` works.

The app is served over HTTP (`http://localhost:5173`). ES modules do not load from
`file://`, so the static server is required to try the UI.

## Deployment (GitHub Pages)

The live site is https://matteleuteri.github.io/guitar-thing/. It is **not** built
from the local `dist/` (that folder is gitignored). CI owns it:

- `.github/workflows/pages.yml` runs on every push to `main`: `npm ci` → `npm run
  build` → copies `index.html`, `style.css`, `dist/`, `debug/`, `assets/` into
  `_site/` → uploads as a Pages artifact → `actions/deploy-pages`. No secrets
  used.
- Live site updates a minute or two after a push. `gh run watch` on the latest
  run, or the Actions tab, shows progress/failures.
- Local development is fully independent: edit → `npm run build` → `node
  server.mjs` → `localhost:5173`. Committing without pushing never affects the
  live site.
- All asset paths in `index.html` (`style.css`, `./dist/main.js`, `debug/`) are
  relative, so the `/guitar-thing/` subdirectory hosting works unchanged. A
  committed `assets/body-ir.wav` (the recorded body IR, progress 19) is served
  the same way and picked up by `audio.ts` via a page-relative fetch — see the
  IR section in Audio below.

## Structure

- `index.html`, `style.css` — single page, dark theme. CSS class prefixes: `fb-`
  (fretboard positions), `cd-` (chord diagram), `.diagrams`, `.chord-card`.
- `src/theory.ts` — pitch classes, parsing, tunings, chord-name identification.
- `src/fretboard.ts` — `findPositions` + `findFingerings` (guitar core algorithm).
- `src/piano.ts` — `findPianoKeys` + `findPianoVoicings` (piano core algorithm).
- `src/song.ts` — `parseProgression` + `planGuitarSong`/`planPianoSong`: song/progression
  mode. Parses a chord-sheet line, then picks ONE voicing per chord (from the existing
  engines) so the whole arrangement moves as little as possible — a Viterbi/DP
  shortest path over per-chord candidates. `parseChord` lives in `theory.ts` (inverts
  `CHORD_PATTERNS`: root + `#`/`b`, quality suffix incl. `M`/`Maj` aliases, optional
  `/bass` → `ParsedChord{name, root, bass, pitchClasses}`). Per-chord costs: guitar = per-string
  `|Δfret|` + mute-change penalty + small hand-position jump, piano = sorted-key
  `Σ|ΔMIDI|` + extra-key penalty; slash-chord bass is a soft preference (lowest note
  should match). Chords whose frets/keys are identical to the previous chord are
  reported as "held" and highlighted (`.cd-held`/`.kb-held`). Candidate budget is
  capped (`SONG_CAP` 400, `cap` min applies) which may make the DP myopic past the
  low-fret window — note this before "global" claims.
- `src/render.ts` — DOM builders: `el()`, `colorFor()`, `renderPositions()`,
  `renderChordDiagram()`, `renderPiano()`/`renderPianoVoicing()`, finger/barre helpers.
- `src/audio.ts` — public sound API (`playVoicing`, `playNotes`, `stopAudio`);
  lazy `AudioContext` + shared graph, worklet loading, per-note scheduling.
- `src/synth/config.ts` — single `PluckAudioConfig`/`DEFAULT_CONFIG` with every
  sound knob (string sustain/brightness, pick attack, scoop, detune/jitter/peak,
  body EQ, room tail, ring length, + `life`/`thump` — see progress 15).
- `src/synth/pluck-worklet.ts` — `registerProcessor("pluck-string")`: a
  Karplus–Strong physical string running on the audio thread. Self-contained:
  must NOT be imported by main-thread code (its `registerProcessor` would crash);
  `audio.ts` loads it with `audioWorklet.addModule(new URL("./synth/pluck-worklet.js", import.meta.url).href)`.
  Gotcha (bit us): node options arrive as the **processor constructor argument**;
  there is no `this.options` — read `options.processorOptions` in the constructor.
- `src/synth/smplr.ts` — the sampled-guitar engine (progress 21): one GM
  steel-guitar kit fetched ONCE (a once-caching wrapper around smplr's storage)
  into a shared smplr `SampleLoader`, then SIX `Soundfont` instances (one per
  string) each writing into its own `[gate → StereoPanner]` chain onto
  `graph.master`. Reads smplr through `globalThis.__SMPLR_FAKE__` so the
  scheduling test can stub it.
- `src/synth/shared.ts` — shared post-string chain: voice bus → body peaking EQ →
  recorded-body-IR convolver (bypass when none loaded) → dry + damped
  feedback-delay room → master gain → compressor.
- `src/synth/ir.ts` — recorded body-IR helpers (mono mix, linear resample,
  onset-trim, length cap, peak normalize, WAV encode/decode, base64). Pure; the
  audio pipeline uses them via `audio.ts` (progress 19).
- `src/synth/samples.ts` — the real-guitar sample bank (progress 20): six
  recorded open strings, stored 24 kHz mono, consumed by `audio.ts`'s
  `scheduleSampleVoice`. Captures trimmed → capped to a pitch-tapered tail →
  fade → normalized; the onset is located by **cumulative energy** (first 5%
  of clip energy) because laptop AGC swells the lead-in and a stop-click at
  the clip's end spikes the last few percent — both would fool a dB-floor or
  steepest-rise trim; a tail-half 10 ms bin far above its neighbours is
  scrubbed outright (`scrubTailClicks`). Level is normalized to the sample
  peak of the *first 95%* so an end-of-clip click never shrinks the whole
  note (clamped to ±1). Mapping is **nearest recorded string in pitch**
  (`nearestSample`), so the whole fretboard plays from six samples; persists
  to localStorage (`guitar-thing.string-samples`) and falls back to shipped
  `assets/string-N.wav`. Stored banks are RE-processed on load, so a code
  change to the import repairs existing captures without re-recording.
- `src/main.ts` — UI wiring, form handling, guitar/piano orchestration (entry point).
- `scripts/smoke.mjs` — Node checks of the compiled theory/fingering output.
- `scripts/audio-sched.mjs` — Node checks of the compiled audio *scheduling* graph
  (stubbed Web Audio): every voice must be silent from t=0 until its strum slot,
  the strum must spread over time, and each voice must have a distinct
  brightness/attack/role. This is the regression test for the "one sound" bug below.
- `server.mjs` — zero-dep Node HTTP static file server (root = cwd).

Runtime dependencies: **`smplr`** (the sampled-guitar engine, progress 21) —
the app's first runtime dependency; the self-hosted kit is a plain asset.
TypeScript is the only devDependency. No frameworks.

## Key models & invariants (do not break these without asking)

- Notes are pitch-class integers `0..11` (`C=0 … B=11`). See `SEMITONES`/`SHARP_NAMES`.
- Tunings are arrays of MIDI note numbers, one per string, **index 0 = lowest
  (thickest) string** (low E in standard), 6 entries.
- A note at `(stringIndex, fret)` has MIDI `tuning[stringIndex] + fret`, pitch class
  `(tuning[stringIndex]+fret) % 12`.
  `fret 0` = open string.
- `findPositions` returns every matching `{stringIndex, fret, pitchClass}`. The renderer drops
  `fret 0` entries (user request: open notes should not show in the positions grid).
- `findFingerings(chordPitchClasses, tuning, maxFrets, span, cap)`:
  - `chordPitchClasses` is the **full input note set** — every provided note must sound at
    least once. There is exactly one chord per query (user request: "all the notes
    provided instead of only a subset"). Minimum 2 notes (user request).
  - Muted strings allowed (`fret: null`); each sounding string must sound a chord note.
  - At least 2 strings sound.
  - All sounded frets fit in a window of `span` frets (open strings = fret 0).
  - Enumerates per-"anchor" (minimum fret) windows `0..maxFrets-span`; a shape is only
    produced at the anchor equal to its minimum fret (guarantees unique shapes).
  - `cap` truncates; `truncated` flag is returned. Order of fingerings is not
    musically ranked — don't add heavy heuristics without asking.
- `findPianoVoicings(pitchClasses, lowKey, highKey, reach, cap)` — same "one chord from
  the full note set" contract for piano:
  - A voicing is a set of pressed keys (MIDI numbers) covering every note, with at
    least 2 and at most `MAX_KEYS` (10 = two hands) keys.
  - All keys lie within `reach` semitones. Anchored at their lowest key, so each
    keyset is unique. Reaches > 11 semitones can double a pitch class across
    octaves, so coverage is tracked by distinct pitch classes (suffix-union pruning,
    `NODE_BUDGET` guard). `truncated` flag behaves like the guitar path.
- `renderPiano`/`renderPianoVoicing` draw an 88-key-style keyboard (white keys in a
  flex row, black keys absolutely positioned by white-key-count offset).
- Notes are selected from a **12-slot grid** (`#note-grid`; default C·E·G), toggled in
  `main.ts`; colors reuse `colorFor(pitchClass)`. Buttons show both spellings via `noteLabels(pitchClass)`
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
- `chordName(pitchClasses)` identifies via interval-pattern dictionary keyed from a candidate
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
- Click-to-play: every keyboard key (`playNotes([midi], true)`) and every
  fretboard position dot (`playNotes([tuning[s] + f])`) plays its own note on
  click; voicing mini-keyboards are key-playable too, alongside their ▶
  whole-voicing button.

## Audio

- `audio.ts` is asynchronous internally: `playVoicing`/`playNotes` are called
  from click handlers but each schedules onto a promise chain so the first click
  can await the `AudioWorklet` module load (first sound may lag one click).
- Every note is a `pluck-string` worklet node (Karplus–Strong: the loop's
  buffer is seeded with a *physical* pluck — one period of the string's
  triangular displacement with its kink at `pickPos`, harmonics
  `sin(n·π·pickPos)/n²` — then self-resonates through a fractional-delay
  allpass and a damped delay line tuned to `1/freq`). The processor
  self-stops after `ringFrames`; `audio.ts` frees each node via a timer.
- Voices share one graph (`shared.ts`): voice bus → body peaking EQ (low +
  presence) → recorded-body-IR convolver (progress 19; bypassed when no IR is
  loaded so the approved sound is unchanged) → dry path *and* room tail
  (feedback delay, dampened lowpass) → master gain → compressor → destination.
- **Body IR API** (`audio.ts`): the recorded body lives as PCM + its own sample
  rate (`irSource`) and is rebuilt as a `ConvolverNode` buffer at whatever
  context is playing (live or offline — `renderOfflineVoicing` includes it).
  Loading: on first `ensure()` it restores localStorage key
  `guitar-thing.body-ir` (a base64 WAV), then falls back to a page-relative
  `assets/body-ir.wav` so a committed asset serves everyone. The harness drives
  it live: `setBodyIRFromPcm(pcm, sr)` (the crop window), `setBodyIRBuffer(blob)`
  (an audio file), `clearBodyIR()`, `setBodyIRLevel(0..1)` and
  `getBodyIRStatus()`; `getBodyIRWav()` yields the normalized WAV for
  committing. Import processing (`src/synth/ir.ts`): mono mix → trim to onset
  (−45 dB floor) → cap to `config.ir.maxMs` (1200) → lowpass (`ir.smoothHz`,
  laptop-mic knocks clip/pin full-scale and the saturated edges read as
  "static" when convolved) → attack fade (`ir.attackMs`) → peak normalize to
  0.999. The convolver runs `normalize: false`; with no IR, wet gain stays 0
  (pure bypass).
- **Sample playback (progress 20) — the priority sound.** Guitar voicings play
  from six *recorded* open-string samples instead of (or mixed with) the K–S
  synth. Recording: the debug harness (`audio-debug.html`, "Sample playback"
  section) records each open string once; `setSample(i, midi, pcm, sr)`
  trims/caps/normalizes it (24 kHz mono, tail-capped by pitch so the lows ring
  ~9 s and the highs ~4–5 s, tail-faded, `samples.ts`) and stores it in
  localStorage (`guitar-thing.string-samples`, falls back to shipped
  `assets/string-N.wav`, N = string index). Playback: `scheduleSampleVoice`
  (in `audio.ts`, chosen per-note in `scheduleGuitarVoicing` when
  `nearestSample(midi)` finds a match within `config.samples.maxShift` (12),
  else the worklet synth takes over) transposes the nearest recorded string by
  `playbackRate = 2^(shift/12)`. Sample voices keep the exact same music as the
  synth: gain gate **silent from time 0** ✝, treble-first strum slots, root/
  color `roles`, bass-left→treble-right pan — but connect straight to
  `graph.master`, deliberately **bypassing** the body EQ / body IR / room (the
  recording already contains the real guitar, body and room). Piano keys and
  single fretboard dots are untouched (samples are a guitar thing).
  Loudness `config.samples.gain`, gate ramp `config.samples.attackMs`;
  harness can toggle off (`setSamplesEnabled`). Debug events carry
  `kind: "sample"` + `midi`/`shift`. `scripts/audio-sched.mjs` asserts six
  sample voices, gates silent from t=0, spread over time, and every shift maps
  a recorded open string to the target note. With the smplr pivot (progress
  21) this is the *second* engine — used in `"samples"` mode and whenever the
  kit isn't yet loaded.
- **The smplr kit (progress 21) — the priority sound.** Guitar voicings play
  from a real GM steel-guitar kit via smplr: `scheduleKitVoice` (in `audio.ts`,
  routed per-note in `scheduleGuitarVoicing` when `config.engine.mode ===
  "smplr"` and the kit engine is ready) calls the engine's `play(midi,
  stringIndex, time, { peak, role, velocity })`. Six `Soundfont` instances (one
  per string) each own a persistent `[gate → StereoPanner]` chain onto
  `graph.master` — homemade gates that hold the one-sound rule (silent from
  t=0, ramp at the strum slot), per-string fixed pans (low E left → high E
  right), and root/color `roles` mapped to sampler velocities. The kit is
  self-hosted (`assets/guitar-steel-ogg.js`, MusyngKite `acoustic_guitar_steel`,
  ~2.6 MB, `MIDI.Soundfont` format), fetched ONCE via a once-caching storage
  wrapper, and decoded per instance into a shared `SampleLoader`; the first
  play after picking smplr primes the engine (that play falls back to
  samples/synth). `setEngineMode()` switches live; the harness radio drives it
  and `getSmplrStatus()` shows load progress. Debug events carry
  `kind: "kit"` + `midi`/`velocity`. `scripts/audio-sched.mjs` exercises the
  whole graph against a stub (`globalThis.__SMPLR_FAKE__`) that records
  `start()` calls.
- Voice separation is deliberate and **systematic**, not random. Each guitar
  string has a fixed identity in `voices[]` (index 0 = lowest/thickest) — not
  just brightness, but a full per-string profile: a commuted-pluck `pickPos`
  (0.75→0.3, near-nut fat → near-bridge bright) that seeds the string's
  harmonics by construction, pickup-style EQ (`eq`: dark lowpass + warm body
  peak on wound strings, rising presence peaks on the plains), a two-stage
  tail (`damping` sustained brightness + `decay` 0.50→0.18 that burns wound
  highs off fast), an attack envelope (`attackMs`: bass thumps in slow, treble
  snaps fast), and a scrape transient with its own color and length
  (`pick` level, `pickBright` highpass ~350 Hz..9 kHz, `pickDecayMs`
  4.5→1.5 ms lows→highs) so onsets separate from sample one. On top,
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
- String "ring" is controlled by the loop loss: `sustain` (per-sample loop gain)
  and `string.damping` / `voices[].decay` (two one-pole lowpasses, 0 = bright/long
  harmonics, 1 = dull/short). A `sustain` near 0.9999 holds the level *flat* and
  relies on the ring cutoff to end the note (the "machine wall" tell — see
  progress 17): the measured default is a real decay curve at 0.994..0.997, and
  `ring.baseMs` just needs to outlast it. Raising sustain + brightening damping is
  what stopped chords from reading as one percussive blip.
- Humanization (`startVoice`): random detune (`detuneCents`), start jitter
  (`jitterMs`), and a velocity spread. Attack scoops come from each guitar
  string's `voices[s].scoopCents` (the thick two get one) or the piano
  register's `scoopCents`.
- Piano notes ring apart like the guitar strings do (`playNotes(midis, true)`):
  instead of one flat random profile, each key resolves its own identity by
  *register* from `cfg.piano` (`registerParams` in `audio.ts` interpolates
  `cfg.piano.low` ↔ `cfg.piano.high` — dark/felted/long bass keys →
  bright/snappy/short treble keys, brightness + damping + sustain + attackMs +
  scoop + pick + its own EQ). On top, the same `roles.*` root/color accents as
  guitar (`rootPc` = lowest key's pitch class) and a `panning.spread` sweep
  bass-left → treble-right. The optional second arg keeps single fretboard dots
  (register false) on the old plain profile untouched.
- `stopAudio()` posts a `stop` message to every live worklet node and
  disconnects it (simpler than the old oscillator teardown).
- All knobs live in `src/synth/config.ts` (`DEFAULT_CONFIG`); the documented
  shape of the pipeline is written in that file's header. Strum speed is also
  user-configurable from the UI: the "Strum speed (ms)" input in the guitar
  block writes `DEFAULT_CONFIG.strum.guitarMs` live (0 = all strings at once),
  so audio settings need no code change to A/B.
- **GOTCHA (the real "one sound" bug)**: an `AudioWorkletNode` starts sounding the
  instant it is connected, and a `GainNode`'s `AudioParam` defaults to **1.0**.
  `startVoice` must therefore hold its volume gate silent *from time 0*
  (`g.gain.setValueAtTime(0.0001, 0)`) before the exponential ramp at the voice's
  strum slot — otherwise every voice leaks immediately and the strum collapses.
  `scripts/audio-sched.mjs` guards this.
- Note: Web Audio can't run under Node, so the smoke suite exercises no *audio* —
  but `scripts/audio-sched.mjs` stubs the Web Audio API to test the host-side
  voice graph, and sound changes are verified by ear in the browser. For deep
  debugging you can render the real graph offline: install `node-web-audio-api`
  in a temp dir, alias `globalThis.AudioContext` to an `OfflineAudioContext`
  subclass, import `dist/audio.js`, call `playVoicing`, then `startRendering()`
  and analyse/write a WAV. (This is how the leak above was found.)

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
9. **THE actual root cause of "one sound": the leaked volume gate.** An offline
   render (see the note in the Audio section) showed the rendered open C was at
   full level from sample 0 with *zero* onsets, even though the voice log
   scheduled 6 voices 0–613 ms apart. `startVoice` only called
   `g.gain.setValueAtTime(0.0001, start)`; a `GainNode`'s AudioParam defaults to
   **1.0**, and a worklet sounds the moment it's connected, so every voice
   leaked at full volume immediately and the strum collapsed — the timing was
   never wrong, it just wasn't audible. Fix: hold silence from time 0
   (`setValueAtTime(0.0001, 0)`) before the ramp at each slot. Envelope now
   starts at 0 and builds in steps (0→0.017→0.059→0.076→0.096). Guarded forever
   by `scripts/audio-sched.mjs` (verified it fails without the fix).

Verified: the offline-rendered open C now starts silent and rises in steps over
~650 ms (onsets detected at 60/140/260 ms, more as it builds), with each string
carrying its own EQ/attack/brightness. The lesson is that the voice log alone
can lie — a real render/measurement is the ground truth for anything about sound.

11. **Physical pluck (commuted excitation) — Lead A slice 1. Landed.** Replaced
    the identical white-noise burst every string used to seed the K–S loop with
    a *physical pluck*: the loop buffer is initialized to one period of the
    string's initial triangular displacement, kink at `pickPos` (fraction of
    string length from the bridge). The resonant harmonics come out as
    `sin(n·π·pickPos)/n²` — near-bridge picks are bright, near-nut are fat, and
    each string being plucked at its own spot (now `voices[s].pickPos`,
    0.75→0.3 low→high) makes the six voices timbrally distinct *by
    construction*, not via post-EQ. In-loop noise is gone; the only noise left
    is the existing pick scrape, which is what a real pick adds on top of the
    pitched onset. **Deferred:** the fractional-delay/allpass damping loop half
    of Lead A — the excitation was the bigger audible win; measure the new tail
    before touching the loop filter.
12. **Two-stage damping + allpass delay — Lead A slice 2. Landed.** The loop
    got its physical curve: the fractional part of the period is now a
    first-order allpass (pitch-exact at DC, and it sharpens high partials a
    touch — real string stiffness), and the loss is two cascaded one-poles
    (`damping` sets sustained brightness, new `decay` steepens the tail so
    wound lows burn their highs off fast while plain highs keep a sparkly
    ring). `voices[s].decay` 0.50→0.18 low→high. `audio-sched.mjs` now asserts
    each voice has a *distinct* tail decay and that the high strings' tails
    stay brighter than the lows'. Remaining Lead A: none — on to Lead B
    (ringing body/IR).
13. **Synthesized body IR — Lead B. Tried twice, reverted.** Fed every voice
    through a `ConvolverNode` whose buffer was a procedurally synthesized
    guitar-body impulse (`src/synth/body.ts`, modal damped sinusoids +
    attack tick, deterministic seeded phases). Verdict by ear both times:
    **super wobbly / beating** — clean in-the-box few-mode sines oscillate
    against each other ('going back and forth high and low too fast'), and a
    dense 20-mode irregular + seeded-phase + noise-tick redesign with
    `irLevel 0.5` was *worse*. Lesson: a handful of synthesized resonators
    can't fake a body's broadband mic-blend; the 'box' needs something with
    real spectral density (recorded IR, or body modes fed densely per-note
    rather than one shared convolution). Reverted to the pre-IR static body EQ
    (the sound the user approved). Revisit only as a *recorded* IR (ship a
    `.wav` asset), never synthetic sines. The static body EQ remains the
    correct current body.

9. **Piano register identity (landed on `dev-audio`, on pause; merged to `main`)** — gave piano
   keys the guitar treatment: `cfg.piano` low/high register profiles (dark
   felted bass → bright snappy treble) interpolated by MIDI in `registerParams`,
   root/color roles + bass-left→treble-right pan in `playNotes(midis, true)`.
   Committed (`41cf7e9`); user verdict after listening: **still reads as "one
   sound"**, and suspicions opened the bigger question below.

10. **The real complaint (pivot): it doesn't capture the instruments.**
    User: "it still only sounds like one sound… I don't think we are really
    capturing the sounds of the instruments." That reframes the goal away from
    "make voices visually separable in a debug log" toward "each pitch builds a
    plausible *guitar*, and a chord sounds like a real guitar being strummed."
    Since then: Lead A (physical string) and Lead C slice 1 are built and
    approved by ear; Lead B (synthesized body IR) failed by ear twice and was
    reverted. The remaining candidates follow below — discuss before building.

## Branches & the live site

The public Pages site deploys from `main` (see "Deployment" above). History:
audio/experimental work was once quarantined on `dev-audio` while `main` was
frozen, but all approved work (per-string identity, physical string core,
scrape separation, song mode) has since been merged into `main` and pushed.
Both `dev-audio` and `song-mode` remain as offline history only.

- `.github/workflows/pages.yml` only deploys on push to `main`. Anything
  committed to any other branch never touches the live site.
- Local dev loop (unchanged): `npm run build && node server.mjs` →
  `localhost:5173`; `npm test` as the gate. Audio experiments are tuned via
  `DEFAULT_CONFIG`, verified with the `/debug/audio-debug.html` harness.

## Backlog / ideas (discuss with the user before building)

- ~~**Smarter per-note sound inside a chord.**~~ **Done** — see progress entry 7:
  `voices[]` per-string character + `roles.*` (root vs color) + hand-shaped
  `strum.pattern`, agreed as "String + role + strum, pronounced separation"
  (now merged into `main`).
- **Chord-quality-specific behaviour** — the next level beyond roles: make the
  *quality* itself shape voicing (maj7 sparkly, minor dark, sus ambiguous,
  dim tense...). Not started — would be `roles` growing a quality axis. Build
  only after the user signs off on the current sound by ear.
- **Muted-string sound.** Right now a muted string (`fret: null` in a fingering)
  is silently skipped by `playVoicing`. On a real guitar a muted/palm-rested
  string still makes a percussive "thunk"/muted-string sound, and that texture
  is part of a chord's character. Idea: give muted strings a short, noise-heavy,
  pitchless (or heavily damped) percussive voice so fingerings sound more
  authentic — plausible as a new `mute` section in `DEFAULT_CONFIG` (level,
  length, brightness) with a per-note worklet param for "muted" mode. Discuss
  before building (how prominent it should be, and whether it's on by default).

### Guitar realism leads (from progress 10 — "capturing the instruments")

Discussed with the user (commit `41cf7e9`): whole team vs "one sound". The piano
register work is parked; guitar realism is the active thread. Candidate leads:

- **Physical string core (commuted synthesis).** **Done** — see progress 11–12.
  The loop is seeded with a position-dependent triangular pluck (`pickPos`,
  harmonics `sin(n·π·pickPos)/n²`), and the fractional-delay allpass + two-stage
  damping loop (`damping`/`decay`) gives partials a physical decay curve.
- **Body as ringing resonators.** **Done as a *recorded* IR — see progress 19.**
  The old shared body EQ is static — it shapes but never *rings*. A real
  guitar's top couples to the strings and resonates at fixed modes (monopole
  ~90–110 Hz, first ~200 Hz, treble peaks), which is most of "it sounds like a
  box." The playback side is now a `ConvolverNode` fed by a real recorded IR:
  **(a)** synthesized sines were tried twice and beat/wobbled badly by ear —
  reverted (progress 13); **(b)** a *recorded* impulse (capture via the debug
  harness, `config.ir.level` for the wet mix, shipped as `assets/body-ir.wav`)
  is worth it and is now the active body. Never synthesize the IR.
14. **Attacks separated from sample one — Lead C slice 1. Landed.** Before this,
    every string's pick scrape was the *same* first-differenced white noise,
    scaled by level only — the onsets all shared one texture. Now each string's
    scrape carries its own shape: a one-pole highpass whose cutoff is set by
    `voices[s].pickBright` (~350 Hz..9 kHz; wound lows scrape dark/plosive,
    plain highs thin/bright) and its own length `pickDecayMs` (4.5 ms lows →
    1.5 ms highs). The transient is noise highpassed as `x − lp`, decaying over
    `k²`. Onset separation is now *constructive*, not just post-loop EQ, and it
    tracks `pickPos` (near-nut = dark scrape, near-bridge = bright). Debug
    events carry `pickBright`/`pickDecayMs`; `audio-sched.mjs` asserts the six
    voices are distinct in both and that highs are brighter *and* shorter.
    **Remaining Lead C:** a pitched pre-ring "slap" (bandlimited transient
    before the triangle) and attack bloom (bright onset settling to the loop's
    brightness).
15. **String life: breathing loop + body thump — Slice 1 of "get away from
    computer-like". Landed, NEEDS EAR CHECK.** Two de-staticizers for the K–S
    loop in `pluck-worklet.ts`, knobs in `config.ts` (`life.*`, `thump.*`,
    `voices[s].thump`): (a) a slow amplitude + micro-pitch wobble — each note
    gets a random phase and a ±`life.hzSpread` rate so chord voices never bob in
    unison, strongest right after the pluck ("bloom", `life.bloomMs`) and
    settling to a steady lope; (b) a brief low-frequency "box hit" (`thump.hz`
    ~106 Hz, `thump.decayMs` ~90 ms) added to the string *output only* — never
    fed back into the loop, so it can't ring as a pitch. `audio-sched.mjs`
    asserts the wobble/thump are distinct per string and that wound lows shake
    the box harder. Motive: the biggest "computer-like" tell was the steady,
    machine-perfect sustained tone. Todonext: attack bloom (Lead C) then a
    ringing body, still not a machine tone.
16. **Measurement harness — Lead E slice 1. Landed.** The debug page
    (`/debug/audio-debug.html`) gained a real-guitar comparison: record a
    clean strum through the laptop mic (`getUserMedia`, all DSP processing off)
    or load a `.wav`/`.mp3`, then *Compare vs synth* renders the exact live
    voicing offline (`renderOfflineVoicing` — an `OfflineAudioContext` driving
    the same `scheduleGuitarVoicing`, no new scheduling code) and overlays both
    RMS envelopes as dB-below-peak curves, normalized to onset, with canned
    metrics: ms attack→peak, −20 dB and −40 dB decay times. That converts "the
    voices sound short/hollow" into "synth -20dB at 850ms vs recording 620ms,
    synth tail too long" — the numbers to tune `voices[].sustain/decay`,
    `life`, `thump` and `body` against. Recent additions: a per-open-string
    preset menu (E2/A2/D3/G3/B3/E4 single-string comparisons first, chords
    later), **Play reference** / **Play synth** buttons to A/B by ear, **crop
    sliders** (Start/End over a full-clip strip that shade the analysis window)
    so lead-in/tail noise can be cut out before measuring, and **Save stats** —
    a POST handler in `server.mjs` appends one JSON comparison record per click
    to the gitignored `debug/comparisons.json` (JSON-lines; the page reloads it
    as a compact history list of real-vs-synth attack/−20/−40 numbers). To
    support it `startVoice` became
    `scheduleVoice(context, graph, …)`, both the live graph and the renderer
    go through one `scheduleGuitarVoicing`, and `buildSharedGraph` widened to
    `BaseAudioContext`. Real-noise caveat: laptop mics roll off below ~100 Hz,
    so compare *shapes*, not the sub-bass.
  - **Harness refinements (drive the tuning, don't guess):** the **crop window
    IS the reference** — Start/End sliders over the full-clip strip shade the
    analysis window *and* rebuild what "Play reference" plays (so cutting lead-in
    silence before the strum is audible, not just plotted); stats, envelopes and
    saves all come from the crop. Recording holds up to **30 s** with a live
    seconds ticker so long sustain tails can be captured (earlier 8 s auto-stop
    was too short); the offline synth render runs up to 8 s (the synth is silent
    well before that anyway). **Save stats** grows the JSON record to carry
    everything needed to refine the sound later: a `configSnapshot()` of
    `DEFAULT_CONFIG` at render time (audio.ts now exports it — knob→sound blame
    is exact), crop/duration, attack/−20/−40, dB below peak at 1/2/5 s, absolute
    peak, and the full 10 ms dB-below-peak envelopes of both ref and synth.
  - **Campaign framing:** these comparison files are the raw material for the
    "capture the instruments" tuning — a saved disagreement ("synth -20 at 850 ms
    vs real 620 ms") is what tells you *which* knob to turn next. Envelope data
    also lets a future step re-plot old saves without re-recording.
17. **Measurement-driven sustain & ring — Lead E slice 2. Landed from the first
    saved E2 comparison.** The saved low-E record exposed a "computer-like"
    tell the ear had missed: the synth held ~flat (-2..-4 dB) for ~3.3 s then
    dropped off a cliff (~-150 dB by 5 s). The cliff was the **ring cutoff**:
    `ring.baseMs: 3400` set the worklet to self-stop the low E at exactly
    3.3 s, mid-tone. The flat part was the sustain knob: `voices[].sustain ≈
    0.9999` applies ~nothing per loop pass (the real decay came almost entirely
    from the clamping ring), so no string actually *decayed* — it just ran out
    of time. Fix, tuned in a Node sim of the exact worklet loop (per-string
    fundamental pass-loss × two one-pole damping stages), then verified: every
    string now decays past −50 dB before any cutoff:
    - `voices[].sustain` 0.99993/0.99989/0.99986/0.99983/0.99981/0.99979 →
      0.99433/0.99493/0.99592/0.99605/0.99667/0.99713 (bass lowest, treble
      highest — the *decay times* still lengthen low→high). E2: −20 dB @ 4.37 s
      (the recording measured 4.37 s), −40 @ 9.4 s; E4: −20 @ 2.3 s, −40 @ 4.7 s.
    - `ring.baseMs` 3400 → 12800 so the lows (slowest decay) are never chopped;
      highs die by real decay long before it. `string.sustain` (the plain,
      non-chord fallback) left at 0.99985 for now — not measured.
    Reminder from the harness lesson: this is ONE recorded string; a second
    E2 and an E4 measurement should confirm the numbers before tuning farther.
18. **Attack bloom — Lead C slice 2. Landed, NEEDS EAR CHECK.** The first saved
    bank (7 records: e2×2, a2, d3, g3, b3, e4) let us plot ref vs synth dB-below
    peak envelopes per open string. The tell: real strings shed their bright
    transient energy *fast* (trusted takes: highs sat −14..−28 dB at 1 s) while
    the synth sat on a flat plateau (−7..−11 across strings) — the same
    "computer flatness" the ring fix touched, but on the *onset* side. A Node
    sim of the worklet loop proved a pure damping/brightness glide barely
    moves level (the output taps the raw allpass, so the fundamental holds at
    `sustain` — brightness burns, level doesn't), so the bloom is two effects
    sharing one `e^(−t/τ)` envelope, τ = `bloom.ms` 420 ms:
    - **Brightness bloom** — the loop starts at `bloom.startDamp` (0.07: bright
      onset) and glides up to the string's sustained `damping`. Bloody well
      changes timbre; by itself almost no level change.
    - **Level settle** — `voices[s].bloom` adds early level that settles away:
      0.03/0.06/0.10/0.16/0.22/0.30 (E2→E4, highs deep, lows barely — the
      measured curve). Sim vs measured refs: E2 −4.2 vs −5.7, D3 −5.9 vs −5.0,
      G3 −8.2 vs −15.8, B3 −8.6 vs −14.1, E4 −11.1 vs −28.1 — lows match, highs
      close half+ the gap without nuking the level (the remaining E4 gap is
      likely mic-attack artifact; re-measure from a clean take). Gate: with
      `bloom` 0 (plain fallback dots, piano keys) the note stays exactly as
      before. `audio-sched.mjs` asserts distinct + monotonic bloom; debug
      events/log carry `bl`.
    Facts worth keeping: the bloom is *level*, not just brightness; the pooled
    take variance (E2B is fine to discard, A2 "−20 @ 720 ms" is an outlier) is
    why the strategy is "2 clean takes per string, same force, let it ring",
    not "trust the loudest take".
19. **Recorded body IR — Lead B, the real "box". Landed, NEEDS A RECORDING +
    EAR CHECK.** The static body EQ shapes but never *rings*, and the two
    synthetic IR attempts (progress 13) beat/wobbled badly by ear — the body
    only gets real by being *recorded*. The playback side is in: every string
    now runs through a `ConvolverNode` fed by a real impulse (`shared.ts`,
    `normalize: false`), stored as PCM + own sample rate so it's rebuilt on
    whatever context is playing. Capture is fully in the debug harness: the
    **Capture body IR** button records ~4 s, auto-finds the knock, trims around
    it and applies it in one click (or the fine path: record a knock on the top
    / muted-string pluck, crop to the knock, **Set crop as body IR**) → trimmed
    (−45 dB floor) → capped (`ir.maxMs` 1200) → peak-normalized (0.999) →
    applied live to the shared graph *and* persisted to localStorage
    (`guitar-thing.body-ir`, base64 WAV). `prewarm()` (exported) unlocks the
    audio context inside the capture gesture so the auto-strum is audible
    immediately. On app startup the IR is restored from localStorage, else a
    committed `assets/body-ir.wav` (page-relative fetch; the Pages workflow now
    ships `assets/`). Mix knob `config.ir.level` (default 0.5, live-writable
    via the harness "IR mix" slider / `setBodyIRLevel`). `renderOfflineVoicing`
    applies the IR too, so Compare-vs-synth renders the real body. **Do:**
    record a clean knock near the bridge, crop tight to the knock, play strings
    both dry and IR'd to find the level. If the IR is longer/noisier than the
    knock it colours every string like a lo-fi room mic — re-crop, don't tune
    the string.
20. **Sample playback — the real guitar. Landed, NEEDS THE 6-STRING RECORDING.**
    The user's goal is "it should sound like a guitar", and after the recorded
    body IR (progress 19) twice landed wrong by ear (the laptop-mic knock was
    staticky raw and muddy once smoothed — the waveform pinned full-scale for
    ~5 ms with a double pulse at 6.2/8.8 ms; a 2 kHz body-band lowpass rescued
    the modes but the *source* remains a poor impulse), the user chose to stop
    synthesizing and play recordings. Adds six open-string samples to the
    debug harness ("Sample playback": one button per string, pluck + ring +
    Stop) and a playback engine (`src/synth/samples.ts`): each capture is
    trimmed → resampled 24 kHz mono → capped to a pitch-tapered tail (low E
    ~9 s → high E ~3 s) → tail-faded → normalized. Mapping is **nearest
    recorded string in pitch** (`nearestSample`: |shift| ≤ `samples.maxShift`
    12, tie → same string), so a full six-string bank keeps every fret within
    ~±2–4 semitones — the whole fretboard from six recordings, no chipmunk.
    `scheduleSampleVoice` (audio.ts) plays each note via
    `AudioBufferSource` at `2^(shift/12)`, keeping the voice-level music
    identical to the synth (gain gate **silent from t=0** — the one-sound bug
    guard now covers samples too — treble-first strum, root/color roles, pan)
    but connecting straight to `graph.master` and **bypassing** the body EQ /
    body IR / room, because the recording already has body and room. Synth is
    the fallback when no sample is within range (or `setSamplesEnabled(false)`;
    partial banks mix both per-note). Piano + single fretboard dots unchanged.
    Persisted to localStorage (`guitar-thing.string-samples`), fallback to
    shipped `assets/string-N.wav` (Pages workflow already ships `assets/`).
    `scripts/audio-sched.mjs` now asserts six sample voices, silent-from-zero
    gates, strum spread, and that every shift maps a recorded open string to
    the target note. **Do:** record the six open strings cleanly (one click
    each), clear the leftover body IR, then ear-check a chord sample-vs-synth
    in the harness and the main app. **Lesson earned:** a laptop-mic *knock*
    is a poor IR; a clean *plucked string* is a much better source — samples
    move the capture from "impulse response" to "the note itself".
21. **smplr sampled guitar — the recording pivot. Landed, NEEDS EAR CHECK.**
    The user recorded all six strings for progress 20, then verdicted the whole
    bank "just not sounding good" — the *source* was the bedroom laptop-mic
    recordings (AGC swell, mono, inconsistent takes), not the API. Per the
    user's explicit choice the app adopted **smplr** (`smplr@1.0.0`, the first
    runtime dependency): a purpose-built Web Audio sampler playing a real,
    consistent GM steel-guitar kit (MusyngKite `acoustic_guitar_steel`,
    self-hosted as `assets/guitar-steel-ogg.js`, ~2.6 MB, `MIDI.Soundfont` JS
    data format that smplr's Soundfont parses natively). Design: the kit text
    is fetched ONCE (a once-caching wrapper around smplr's `storage` — its
    Soundfont would otherwise re-fetch it for every instance; decode still
    runs per instance and `ready` only gates routing once every one has),
    then **six `Soundfont` instances, one per string**, each with
    `instrumentUrl` + the shared `loader` and a `destination` that is our own
    persistent per-string `[gate → StereoPanner]` chain onto `graph.master`.
    The music survives engine swap untouched: `scheduleKitVoice` (audio.ts)
    hands the sampler `{note: fretted midi, velocity: roles-mapped}` at the
    same strum slot, the gate holds the one-sound guard (silent from t=0,
    ramp at slot — written at every play, so a rapid re-play of the same
    string re-arms it, documented), and each string gets a FIXED stereo seat
    (low E left → high E right) rather than the count-relative synth pan.
    `config.engine.mode` (`"smplr" | "samples" | "synth"`) selects the engine;
    `setEngineMode()` switches live and primes the kit; `getSmplrStatus()`
    feeds the harness's progress line; debug events gain `kind: "kit"` +
    `velocity`. The recorded bank and the K–S synth remain selectable and act
    as fallbacks (kit mid-decode → the play waits up to 8s via
    `awaitKitIfLoading`, then either rides the kit or falls back; not ready →
    samples if a bank exists, else synth). Offline render (harness Compare)
    builds its
    own engine sharing nothing but config when mode is smplr, and falls back to
    synth if the kit can't load offline. `scripts/audio-sched.mjs` stubs smplr
    via `globalThis.__SMPLR_FAKE__` (records `start()` calls — the real
    package would fetch/decode the kit under Node) and asserts: six kit voices,
    notes = fretted midis handed to the sampler, root/color velocities, fixed
    distinct pans (lows left), the kit's six gates silent from t=0, strum
    spread. The recorded-string bank became the second engine, not the target;
    the stored body IR should be cleared. **Do:** open `/debug/audio-debug.html`
    ("Guitar engine" row), pick smplr, strum once (loads) then again (plays the
    kit), and ear-check smplr vs samples vs synth on chord + single strings.
    The kit URL + gain/attack/velocity knobs live in `config.engine`.
- **Attack/transient redesign.** Slices 1–2 landed — see progress 14 and 18:
  each string's scrape carries its own brightness (`pickBright`) and length
  (`pickDecayMs`), and the onset now "blooms" (bright + touch louder) then
  settles into the sustained tone (`bloom`/`bloom.startDamp`). Remaining: a
  *pitched* pre-ring "slap" (a bandlimited transient before the triangle, so
  the attack carries the string's own harmonic color).
- **Spatial virtualization.** Current `panning.spread` is a plain stereo pan.
  Placing each string at its own point on a modeled soundboard/PannerNode with
  per-string distance/delay + early reflections would make voices feel like they
  occupy different places in a room rather than one speaker. Real guitars are
  mostly mono *captured*, though — this helps perceived separation more than
  realism, and must not fight the strum.
- **Measurement-driven tuning.** Progress 16 landed the tooling: the debug
  harness now records/loads a real guitar clip and overlays the offline-rendered
  synth's envelope/decay (attack→peak, −20/−40 dB times) so you can tune the
  tails and attacks against an actual recording with numbers. The old lesson
  ("the voice log can lie") applies to the *timbre* too: render offline and
  compare, don't just adjust by ear.
- **Framing check (worth raising before any of the above):** a real strummed
  chord *is* one instrument, captured together — so the target might be "a
  believable recorded guitar chord," not "six separable instruments." That
  determines whether separation or spectral realism wins; the user's phrasing
  ("capturing the sounds of the instruments") points at the former.