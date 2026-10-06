# NOW.md — where the riff trainer stands

**Written:** Oct 1 2026, for picking this up later. Updated Oct 3 2026.
**Branch:** `main` — 4 commits ahead of `origin/main`, **unpushed**.

> Design detail lives in `AGENTS.md` ("In flight" at the top, then "Riff
> trainer"). User-facing docs in `README.md`. This file is only "where we are
> and what's next" — don't let it duplicate those.

---

## Resuming in 30 seconds

```bash
cd /mnt/c/Users/meleu/Desktop/guitar-thing
npm run here   # confirms branch + that dist/ was built from it
npm start      # build + serve on :5173
```

Then open **http://localhost:5173/riff.html** — the track view is the top
section of the page.

## State

| | |
|---|---|
| Branch | `main`, 4 commits ahead of `origin/main`, **unpushed** |
| Working tree | Clean — loop overlay drop fix, Clear track, pending-chip retirement order, retuned default are all in |
| Gate | `npm test` → **ALL PASS** (smoke + audio-sched + 87 unit tests) |
| Sound | **Ear-approved** — last playback "sounded good" (smplr kit) |
| Track view / drag / tool tabs in a browser | **Verified by the user.** |
| Live site | Deployed from the last push; one commit behind the repo |

## What the in-flight work is

The riff page's top section is ONE track of **DAW-style regions**
(`src/track.ts`): a bar ruler, a chord lane (name + auto-voiced shape), six
string lanes (tab notes), and the loop
region + playhead overlaid on one canvas. The string names sit in a sticky
LEFT gutter (`.track-gutter`) outside the canvas, so regions never slide
under them (the old in-lane sticky letter chips are gone, Oct 3). Every
event is a region — left
edge exactly at its beat, width = its span — so the playhead touches a
region's left edge the moment it sounds. Spans are inferred
(`regionEnds`): a chord rings until the next chord, a tab note until the
next tab note, the last of each kind to the piece end. It replaces
`renderRiffTimeline`.

**Motive — two user-reported misalignments:** (1) the event blocks and the
per-string grid lived in separate positioning contexts and drifted apart →
unified canvas. (2) the unified blocks were CENTERED on their beats, but
the eye reads a timeline thing as starting at its left edge — the user
measured the result as "off by a half beat" (and the maths agreed: a ~4rem
block's left edge sits ~2rem early = one eighth-note column) →
left-anchored regions, which also show duration as a bonus.

~~**Also in the tree (Oct 1):** a **lead-in beat**~~ — REMOVED Oct 3 2026:
`LEAD_IN_BEATS` is now `0`, Play starts on the first beat, and the
transport's `leadInBeats` option is dormant (default 0, still tested).

**Update Oct 2 2026 — committed as `1374888`, and everything in the wishlist
got done that session:** builder palette (chord chips draggable onto the
track), the Undo button, and the page reorganized into tool tabs over the
one notation. The track, tool tabs, drag and undo were all verified in a
browser. Also that day: the visual tab-editor grid was judged redundant
with track drag-and-drop and removed, the Text tab now warns that a typed
chord name gets its fingering picked by the app (pin shapes in Chords),
and note entry moved onto the track itself — click a string lane, type
the fret number (empty = delete). The Tab tab and note-chip palette went
away; strip is Chords / Text / Settings.

**Oct 3 2026 (unpushed commit on `main`):** tab editor fully removed,
pins follow chords on drag/add (`movePins`/`insertOrReplacePin`), the
pending-chord "Use" button no longer grays out after ◀ ▶ (browse and
commit are separate state), the lead-in beat is gone (`LEAD_IN_BEATS = 0`),
and the string names live in a sticky left gutter outside the track canvas.

**Oct 4-5 2026 (four unpushed commits on `main`):**
- `4396bb1` — `.track-loop` no longer swallows dragover/drop (pointer-events: none): drops on newly-added bars were dead because the loop overlay ate the events. Also loop inputs reset to the whole riff when the bar count changes (previously a longer riff silently clipped its loop), and `ensure()` in audio.ts no longer dies on browsers without the Audio Worklet API.
- `1831f92` — **Clear track** button (`riff.html` + `src/riff-main.ts`): every chord token becomes a rest bar, every lane cell a rest at the same widths; pins/preview reset; `parseRiff` no longer throws on a rest-only stream — it returns a valid zero-event riff with a "Nothing to play" warning, so the empty grid remains visible (previously the error path also left a stale track on screen).
- `cbba5e9` — pending entry retired BEFORE `applyProgression`, so dragging the pending "to add" chip onto the track no longer leaves the chip in the builder (the rebuild had already run on the un-spliced list).
- `e06ce70` — shipped default retuned **+2 semitones**: `D Bm G A` with every tab fret nudged 2 up per string (the `8---8---` becomes `10--10--`). README/AGENTS/debug text updated.

## Next up (pick one)

1. Push `main` to deploy (hard-refresh after — Pages' 10-minute module
   cache). Four commits sit unpushed on `main`: `4396bb1`, `1831f92`, `cbba5e9`, `e06ce70`.
2. **Dead code**: `renderRiffTimeline`/`setRiffPlayhead` have no live
   caller, and `smoke.mjs` still guards the old timeline's source shape —
   repoint or delete.
3. Phase 2 remainder (see `AGENTS.md` backlog): region resize (needs
   explicit durations in the model), delete-by-drag-off.
4. **Export / import riffs** — user wants to download a riff file and
   reload it later. OPEN DESIGN QUESTIONS: plain text (the notation, minus
   directives?) vs a small JSON wrapping notation + pins + settings;
   whether the chord/tab lanes stay as-is; where the UI affordance lives
   (a Download / Load row in the Track section?). Not started by design.

## House rules for whoever picks this up

- **Never `git push` without explicit consent** (see `AGENTS.md`). Pushing
  `main` deploys the live site.
- `npm test` is the gate. It asserts the notation examples in `riff.html`,
  `README.md` and `AGENTS.md` all parse, so don't hand-edit those examples
  without running it.
- `dist/` is gitignored — if `npm run here` says STALE, rebuild before
  trusting anything you see or hear.
