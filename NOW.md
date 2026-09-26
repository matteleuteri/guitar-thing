# NOW.md — where the riff trainer stands

**Written:** end of session, for picking this up later.
**Branch:** `riff-trainer` (local only — not on GitHub). `main` is untouched at
`56980a5` and still matches `origin/main`. The live site is unaffected.

> Design detail lives in `AGENTS.md` ("Riff trainer"). User-facing docs in
> `README.md`. This file is only "where we are and what's next" — don't let it
> duplicate those.

---

## Resuming in 30 seconds

```bash
cd /mnt/c/Users/meleu/Desktop/guitar-thing
git checkout riff-trainer      # you should already be here
npm run here                   # confirms branch + that dist/ was built from it
npm start                      # build + serve on :5173
```

Then open **http://localhost:5173/debug/riff-debug.html** for the listening
checks, or **http://localhost:5173** for Riff mode itself.

`npm run here` matters more than it looks: `dist/` is gitignored, so switching
branches does *not* switch the build. If it says **STALE**, run `npm start`
before trusting anything you hear.

## State

| | |
|---|---|
| Branch | `riff-trainer`, 4 commits ahead of `main`, **not pushed** |
| Gate | `npm test` → **690 checks, ALL PASS** |
| Verified by ear | **Nothing yet.** No browser was available in the session that built this |
| Live site | Unchanged. Pages only deploys on a push to `main` |

```
25c5724  Make "which code am I testing?" impossible to get wrong
18e9983  Add a riff ear-check page so verification is judgement-only
fdf7088  Add the offline SF2 extractor (PARKED - not part of the riff work)
6651b66  Riff mode: a chord stream + tab lane you can hear on a loop
```

The two commits that carry the feature are `6651b66` and `18e9983`. `fdf7088` is
parked and separable — it is the *third* commit from the tip, so
`git reset --soft HEAD~1` would drop the wrong one. To drop just the parked
work: `git rebase --onto 6651b66 fdf7088 riff-trainer` (verified; rewrites
history, so only do it while nothing is pushed — and nothing is).

---

## Next step: hear it, then fix what you hear

This is the only thing blocking everything else. The scheduling, the parser and
the envelope are all proven by tests; **the sound has never been heard by
anyone.** Nobody — including me — knows yet whether a gated kit note decayed by
`release` sounds like a note stopping or like a swell being cut off.

Work the ear-check page top to bottom, and treat **§0 as a hard gate**: if the
kit isn't `READY` (green), the rest is testing a fallback and any note you write
will be misleading.

| § | Case | The question only ears can answer |
|---|---|---|
| 0 | Engine gate | Is the kit ready? (no ears needed) |
| 1 | Default riff, 4 bars | Does it sound like a guitar, and like a part you'd play? |
| 2 | `ring` / 200 / 400 / 900 | Does a damped note *stop* naturally, or click/chop/swell? |
| 3 | strum `0` / `55` / `300` | Is `0` one solid chunk? Is `55` the most natural? |
| 4 | steel vs nylon | Which kit sounds right? |
| 5 | Report box | Type what you heard, hit **Copy**, paste it back |

Also worth looking at, in Riff mode: do the timeline notes line up with the
bars, and does the playhead move smoothly? Nobody has seen it render.

**Then, in order:**

1. Fix whatever the listening turns up, one commit per finding.
2. Land the fixes on `riff-trainer`, and only consider `main` once it survives
   your ears.

### Two known risks, ranked

1. **Note length (§2) is the weakest part of the slice.** `release` is new and
   kit-only, verified so far only by asserting a gain ramp exists in the
   scheduling graph. It ramps the smplr per-string gate, which is a plausible
   source of an audible swell on a ringing sample rather than a natural decay.
   Expect this one to need work.
2. **The timeline has never been rendered.** Its geometry is proven by
   arithmetic (note `left: %` and the pixel-based playhead/loop math agree by
   construction), but "proven by arithmetic" is not "seen".

### Known gaps that are real, not hypothetical

- `x` mutes are **metadata only** — `playVoicing` still receives `null` for
  unstruck strings, so a still-ringing string may not be re-muted.
- `release` is **kit-only**; the sample/synth fallbacks ring out regardless.
- `RiffEvent.beats` is nominal — there is no rhythm/duration notation yet, so
  nothing currently expresses a held or tied note.
- Only a few note kinds work. No bends/hammer-ons (tab accepts the marks and
  ignores them), no per-event strum override, no strum direction.

---

## After verification: the actual product

The user's goal is *"hear how a riff sounds before learning it by hand."*
Right now it can do the first half. Ranked by how much they serve the second:

1. **Finger numbers / learning aids.** The stated end goal is learning it
   manually, and the timeline currently shows only strings and frets. This is
   the biggest gap between "trainer" and "tool".
2. **Rhythm and duration notation.** Ties, sustains, held notes. Without it
   long riffs can't be written down, which is most real music.
3. **Metronome + count-in.** A practice trainer without a pulse reference is
   awkward to use, and it makes the transport's timing audible rather than
   merely provable.
4. **Per-event strum width and direction** (up/down). The model already carries
   per-event `strumMs`; only the notation and the engine direction are missing.
5. **Raw MIDI/Hz input.** The user said "at what frequencies", but today
   frequency only arrives as *tuning + fret*, via tab or a chord name. **Worth
   asking the user** whether they actually want to type MIDI numbers, or whether
   tab already covers what they meant.

## Open questions for the user

Worth raising rather than guessing:

- Does the default notation (a chord line *and* a melody lane playing together)
  match how they'd actually write a riff, or would they want them as separate
  things to toggle?
- Is the app still a *guitar* trainer only? The model is guitar-specific
  (strings, frets, `tuning`); piano riffing would be a different shape.
- Is sharing a riff (copy the text, or a URL that reproduces it) worth anything
  to them? Currently a riff is only ever the in-page textarea.

---

## Parked — do not build on these

- **SF2 extractor** (`scripts/sf2-extract.mjs`, commit `fdf7088`). It fixes
  sample *source*, not sequencing. Working and verified against a synthetic
  bank, but there is no real `.sf2` to run it on, the steel/nylon preset intent
  was never written down, and redistribution licensing is unresolved.
- **Sound-quality leads** from the earlier work: pitched pre-ring "slap", Lead D
  spatialization, muted-string "thunk", piano register identity, the recorded
  body IR. All ear-rejected or deferred; listed in `AGENTS.md`.

## House rules for whoever picks this up

- **Never `git push` without explicit consent** (see `AGENTS.md`).
- Pushing `main` **deploys the live site** — that's why this work sits on a
  branch. Keep it there until it's verified.
- `npm test` is the gate. It asserts the notation examples in `index.html`,
  `README.md` and `AGENTS.md` all parse, so don't hand-edit those examples
  without running it.
