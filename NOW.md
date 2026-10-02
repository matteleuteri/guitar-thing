# NOW.md — where the riff trainer stands

**Written:** Oct 1 2026, for picking this up later.
**Branch:** `main` — 1 commit ahead of `origin/main` (the Sep 27 docs commit
`9f220e9` was never pushed, so the live site is one commit behind the repo).

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
| Working tree | **Uncommitted**: the unified track view (`src/track.ts` new; `riff.html`, `src/riff-main.ts`, `style.css`, `README.md`, `AGENTS.md` modified) |
| Gate | `npm test` → **ALL PASS** (smoke + audio-sched + 55 unit tests) |
| Sound | **Ear-approved** — last playback "sounded good" (smplr kit) |
| Track view in a browser | **Never rendered.** Nobody has seen it yet |
| Live site | Deployed from the last push; unaffected by local work |

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

## Next step: see it, then commit

The geometry and span rules are tested (64 unit checks green), but the
regions have never been rendered in a browser. Verify by eye, then:

1. ~~Edge clipping~~, ~~chip overflow~~, ~~missing lanes~~ — all three died
   with the regions redesign (regions don't overhang; lanes are flow rows
   with letters + gridlines). Confirm by eye.
2. **Dead code**: `renderRiffTimeline`/`setRiffPlayhead` have no live
   caller, and `smoke.mjs` still guards the old timeline's source shape —
   repoint or delete.
3. **`riff.html` duplicate `#tab-editor`** — the Fingering → Tab panel is
   always empty; the chord panel's intro paragraph is duplicated too.

Then commit, and on to **Phase 2: drag-and-drop** — regions are the natural
draggable unit. Decision already made: a thin `dnd.ts` over the native
HTML5 API, no framework. See `AGENTS.md` backlog.

## House rules for whoever picks this up

- **Never `git push` without explicit consent** (see `AGENTS.md`). Pushing
  `main` deploys the live site.
- `npm test` is the gate. It asserts the notation examples in `riff.html`,
  `README.md` and `AGENTS.md` all parse, so don't hand-edit those examples
  without running it.
- `dist/` is gitignored — if `npm run here` says STALE, rebuild before
  trusting anything you see or hear.
