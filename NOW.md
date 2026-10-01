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

The riff page's top section is being rebuilt as ONE unified track
(`src/track.ts`): event blocks + per-string fret chips + a single playhead,
all absolutely positioned against one canvas in one unit (fractions of the
track, from `src/timeline.ts`). It replaces `renderRiffTimeline`, which
`riff-main.ts` no longer calls.

**Motive:** the user hit a **misalignment** on an otherwise good-sounding
playback — the event blocks and the per-string grid lived in separate
positioning contexts (the grid had a string-label gutter, the blocks strip
did not), so a block at beat N and its chips at beat N drifted apart. One
canvas makes "same beat = same pixel" true by construction.

## Next step: see it, then fix what you see

The horizontal geometry is provably consistent (everything is a fraction of
the same canvas), but the track has never been rendered in a browser. A
static read of the working tree already turned up five likely-visible
issues — verify by eye, fix, then commit:

1. ~~**First chord block half-clipped**~~ **FIXED (Oct 1)**: `.track` now
   carries `padding: 0 var(--track-endpad)` (4rem), so the blocks centered
   on the first/last beat render whole (container padding is scrollable
   space; padding the canvas instead would have stretched the beat grid and
   fixed nothing). The loop highlight bleeds into the pad to match
   (`track-loop-at-start`/`-at-end` pseudo-elements), so an overhanging edge
   block sits on the blue; the loop borders still mark the exact bounds.
   Verify by eye anyway — the 4rem pad assumes a block half-width under
   ~2.5rem.
2. **Low-string chips overflow the canvas bottom**: chip rows are
   `top: 5 + row*1.5rem` against a 12rem-high canvas, so the low-E row sits
   at 12.5rem — below the canvas and below the loop highlight — and `.track`
   grows a vertical scrollbar (`overflow-x: auto` forces `overflow-y: auto`).
3. **No string lanes, lane letters or step gridlines** in the track — the
   old timeline had all three. Chips float on bare canvas
   (`--track-gutter: 1.4rem` is declared but never used).
4. **Dead code**: `renderRiffTimeline`/`setRiffPlayhead` have no live caller
   (`timelineEl` in `riff-main.ts` is only ever `null`), and `smoke.mjs`
   still asserts the old timeline's source shape — it guards a renderer the
   app does not use. Repoint or delete when the track lands.
5. **`riff.html` has two `#tab-editor` divs** (Notation section + Fingering →
   Tab panel). The editor mounts into the first, so the Tab panel is always
   empty. The chord panel's intro paragraph is also duplicated verbatim.

Then, in order:

1. Fix what the browser shows, one commit per finding.
2. Commit the track view.
3. Only then consider **Phase 2: drag-and-drop** (a palette of chords/notes
   dropped onto the track). Decision is already made: a thin `dnd.ts` helper
   over the native HTML5 API, no framework. See `AGENTS.md` backlog.

## House rules for whoever picks this up

- **Never `git push` without explicit consent** (see `AGENTS.md`). Pushing
  `main` deploys the live site.
- `npm test` is the gate. It asserts the notation examples in `riff.html`,
  `README.md` and `AGENTS.md` all parse, so don't hand-edit those examples
  without running it.
- `dist/` is gitignored — if `npm run here` says STALE, rebuild before
  trusting anything you see or hear.
