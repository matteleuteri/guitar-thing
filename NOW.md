# NOW.md — where the riff trainer stands

**Written:** Oct 1 2026, for picking this up later. Updated Oct 2 2026.
**Branch:** `main` — 1 commit ahead of `origin/main`, **unpushed** (`1374888`).

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
| Branch | `main`, 1 commit ahead of `origin/main`, **unpushed** |
| Working tree | Clean — `1374888` holds Phase 2 + palette + undo + tool tabs |
| Gate | `npm test` → **ALL PASS** (smoke + audio-sched + 80 unit tests) |
| Sound | **Ear-approved** — last playback "sounded good" (smplr kit) |
| Track view / drag / tool tabs in a browser | **Verified by the user.** |
| Live site | Deployed from the last push; one commit behind the repo |

## What the in-flight work is

The riff page's top section is ONE track of **DAW-style regions**
(`src/track.ts`): a bar ruler, a chord lane (name + auto-voiced shape), six
string lanes (tab notes, with sticky letters + step gridlines), and the loop
region + playhead overlaid on one canvas. Every event is a region — left
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

**Also in the tree (Oct 1):** a **lead-in beat** — the track opens one beat
before the music (`LEAD_IN_BEATS = 1`), and Play sweeps the empty beat
(silent, or a click if the metronome is on) before the first region sounds.
Play-time only: loop wraps go straight back to the loop start, so bar lines
never drift against the metronome.

**And Phase 2 — drag-and-drop editing:** chord regions drag to a new bar
(replace: the target chord dies, the source bar becomes a `-` rest — new
notation), note regions drag to a new (string, column) keeping the fret.
Every drop rewrites the notation text through the pure translators in
`src/track-edit.ts` (tested); the drag machinery is `src/dnd.ts` (~80
lines, native HTML5 API). Deliberately absent: palette, region resize,
delete-by-drag-off, undo.

## Next step: try the drag in a browser, then commit

80 unit checks green, but the drag wiring is DOM code the tests cannot see
— verify by hand: drag a chord (bar swap → the notation line rewrites
itself, source becomes a `-`), drag a note across columns and across
strings (fret travels), check the dashed indicator lands where the drop
lands, and check click-to-play still works (a click is not a drag).

Then:

1. Commit + push (deploys the site; hard-refresh after the deploy —
   Pages' 10-minute module cache).
2. **Dead code**: `renderRiffTimeline`/`setRiffPlayhead` have no live
   caller, and `smoke.mjs` still guards the old timeline's source shape —
   repoint or delete.
3. **`riff.html` duplicate `#tab-editor`** — the Fingering → Tab panel is
   always empty; the chord panel's intro paragraph is duplicated too.

After that, the Phase 2 remainder (see `AGENTS.md` backlog): palette for
adding new events, region resize (needs durations in the model),
delete-by-drag-off, undo stack.

## House rules for whoever picks this up

- **Never `git push` without explicit consent** (see `AGENTS.md`). Pushing
  `main` deploys the live site.
- `npm test` is the gate. It asserts the notation examples in `riff.html`,
  `README.md` and `AGENTS.md` all parse, so don't hand-edit those examples
  without running it.
- `dist/` is gitignored — if `npm run here` says STALE, rebuild before
  trusting anything you see or hear.
