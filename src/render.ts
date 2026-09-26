import { playFrettedNote, playNotes, playVoicing } from "./audio.js";
import { findPositions, type Fingering } from "./fretboard.js";
import { chordShape, type RiffEvent } from "./riff.js";
import { midiName, SEMITONES } from "./theory.js";

/** Create an element with an optional class and text content. */
export function el(tag: string, cls?: string, text?: string | number): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** Fixed fill per pitch class so the board, legend and diagrams always agree. */
export function colorFor(pitchClass: number): string {
  return `hsl(${(pitchClass * 30) % 360} 82% 60%)`;
}

/* ------------------------------------------------------------------ */
/* Fretboard positions grid                                            */
/* ------------------------------------------------------------------ */

export function renderPositions(
  tuning: number[],
  targetPitchClasses: number[],
  maxFrets: number,
  nameOf: (pitchClass: number) => string,
): HTMLElement {
  const positions = findPositions(targetPitchClasses, tuning, maxFrets);
  const positionKeys = new Set(
    positions.filter((p) => p.fret > 0).map((p) => `${p.stringIndex}:${p.fret}`),
  );

  const box = el("div", "fb");
  box.style.setProperty("--col-count", String(maxFrets));

  const nut = el("div", "fb-nut");
  for (let i = 0; i < tuning.length; i++) nut.appendChild(el("span", "fb-nut-dot"));
  box.appendChild(nut);

  for (let stringIndex = tuning.length - 1; stringIndex >= 0; stringIndex--) {
    const row = el("div", "fb-row");
    row.appendChild(el("span", "fb-string-label", midiName(tuning[stringIndex])));

    for (let fret = 1; fret <= maxFrets; fret++) {
      const cell = el("div", "fb-cell");
      if (positionKeys.has(`${stringIndex}:${fret}`)) {
        const pitchClass = (tuning[stringIndex] + fret) % SEMITONES;
        const dot = el("span", "fb-dot", nameOf(pitchClass));
        dot.style.setProperty("--c", colorFor(pitchClass));
        const midi = tuning[stringIndex] + fret;
        dot.title = `${nameOf(pitchClass)} · ${midiName(midi)} · string ${stringIndex + 1} fret ${fret}`;
        dot.addEventListener("click", () => playFrettedNote(stringIndex, fret, tuning));
        cell.appendChild(dot);
      }
      row.appendChild(cell);
    }
    box.appendChild(row);
  }

  const fretRow = el("div", "fb-fretrow");
  fretRow.appendChild(el("span"));
  for (let fret = 1; fret <= maxFrets; fret++) fretRow.appendChild(el("span", "fb-fretnum", String(fret)));
  box.appendChild(fretRow);

  return box;
}

/* ------------------------------------------------------------------ */
/* Chord diagrams                                                      */
/* ------------------------------------------------------------------ */

/** Finger numbers ranked by fret (0 = open/muted, no number shown). */
function assignFingers(frets: (number | null)[]): number[] {
  const sounding: number[] = [];
  for (const fret of frets) if (fret !== null && fret > 0) sounding.push(fret);
  const distinct = Array.from(new Set(sounding)).sort((a, b) => a - b);
  const rank = new Map<number, number>();
  distinct.forEach((fret, i) => rank.set(fret, i + 1));
  return frets.map((fret) => (fret === null || fret === 0 ? 0 : rank.get(fret)!));
}

/** Contiguous runs of the same fretted fret across ≥2 adjacent strings. */
function findBarres(frets: (number | null)[]): { fret: number; count: number }[] {
  const out: { fret: number; count: number }[] = [];
  let i = 0;
  while (i < frets.length) {
    const fret = frets[i];
    if (fret === null || fret === 0) { i++; continue; }
    let j = i;
    while (j + 1 < frets.length && frets[j + 1] === fret) j++;
    if (j - i + 1 >= 2) out.push({ fret, count: j - i + 1 });
    i = j + 1;
  }
  return out;
}

/** How many strings a fingering mutes. */
function mutedCount(frets: (number | null)[]): number {
  return frets.filter((fret) => fret === null).length;
}

/* ------------------------------------------------------------------ */
/* Piano keyboard                                                      */
/* ------------------------------------------------------------------ */

const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);

interface KeyView {
  whites: number[];
  blacks: number[];
}

/** Split a MIDI range into white and black key numbers. */
function keyView(low: number, high: number): KeyView {
  const whites: number[] = [];
  const blacks: number[] = [];
  for (let midi = Math.min(low, high); midi <= Math.max(low, high); midi++) {
    if (WHITE_PCS.has(((midi % SEMITONES) + SEMITONES) % SEMITONES)) whites.push(midi);
    else blacks.push(midi);
  }
  return { whites, blacks };
}

/**
 * Shared keyboard: white keys in a flex row, black keys absolutely positioned
 * by white-key-count offset. `marked` fills target keys, `held` marks song-held
 * keys, each key plays its MIDI note on click.
 */
function keyboardEl(
  low: number,
  high: number,
  marked: Set<number>,
  nameOf: (pitchClass: number) => string,
  baseClass: string,
  extraClass = "",
  held?: Set<number>,
): HTMLElement {
  const { whites, blacks } = keyView(low, high);
  const whiteCount = Math.max(1, whites.length);
  const box = el("div", extraClass ? `${baseClass} ${extraClass}` : baseClass);
  box.style.maxWidth = `max(9rem, calc(var(--key-w, 2.4rem) * ${whites.length}))`;

  const whiteRow = el("div", `${baseClass}-white`);
  for (const midi of whites) {
    const pitchClass = ((midi % SEMITONES) + SEMITONES) % SEMITONES;
    const whiteKey = el("div", `${baseClass}-wkey`);
    if (marked.has(midi)) {
      whiteKey.style.background = colorFor(pitchClass);
      whiteKey.classList.add("kb-hit");
    }
    if (held?.has(midi)) whiteKey.classList.add("kb-held");
    whiteKey.appendChild(el("span", `${baseClass}-mark`, nameOf(pitchClass)));
    whiteKey.title = midiName(midi);
    whiteKey.addEventListener("click", () => playNotes([midi], true));
    whiteRow.appendChild(whiteKey);
  }
  box.appendChild(whiteRow);

  for (const midi of blacks) {
    let whiteKeysToTheLeft = 0;
    for (const white of whites) if (white < midi) whiteKeysToTheLeft++;
    const pitchClass = ((midi % SEMITONES) + SEMITONES) % SEMITONES;
    const blackKey = el("div", `${baseClass}-bkey`);
    if (marked.has(midi)) {
      blackKey.style.background = colorFor(pitchClass);
      blackKey.classList.add("kb-hit");
    }
    if (held?.has(midi)) blackKey.classList.add("kb-held");
    blackKey.style.left = `${(whiteKeysToTheLeft / whiteCount) * 100}%`;
    blackKey.style.width = `${(0.62 / whiteCount) * 100}%`;
    blackKey.title = midiName(midi);
    blackKey.addEventListener("click", () => playNotes([midi], true));
    blackKey.appendChild(el("span", `${baseClass}-mark`, nameOf(pitchClass)));
    whiteRow.appendChild(blackKey);
  }
  return box;
}

/** Full-range keyboard with every occurrence of each target note marked. */
export function renderPiano(
  low: number,
  high: number,
  targetPitchClasses: number[],
  nameOf: (pitchClass: number) => string,
): HTMLElement {
  const targets = new Set(targetPitchClasses);
  const marked = new Set<number>();
  const { whites, blacks } = keyView(low, high);
  for (const midi of [...whites, ...blacks]) {
    if (targets.has(((midi % SEMITONES) + SEMITONES) % SEMITONES)) marked.add(midi);
  }
  return keyboardEl(low, high, marked, nameOf, "kb");
}

/** Mini keyboard showing one piano voicing; ▶ plays the pressed keys. Held keys get `.kb-held`. */
export function renderPianoVoicing(
  keys: number[],
  nameOf: (pitchClass: number) => string,
  id: number,
  opts?: { held?: number[] },
): HTMLElement {
  const box = keyboardEl(Math.min(...keys), Math.max(...keys), new Set(keys), nameOf, "kb", "pp",
    new Set(opts?.held ?? []));
  box.appendChild(el("span", "cd-id", String(id)));
  box.title = `Voicing ID ${id}`;

  const play = el("button", "cd-play", "▶");
  play.title = "Play voicing";
  play.addEventListener("click", (event) => {
    event.stopPropagation();
    playNotes(keys, true);
  });
  box.appendChild(play);
  return box;
}

/**
 * Chord skeleton: head mute/open markers, fretted rows, barres, finger numbers,
 * sounding notes. Held strings (unchanged from the previous song chord) get
 * `.cd-held` on their dot and head marker.
 */
export function renderChordDiagram(
  fingering: Fingering,
  tuning: number[],
  nameOf: (pitchClass: number) => string,
  id: number,
  opts?: { held?: boolean[] },
): HTMLElement {
  const { frets } = fingering;
  const held = opts?.held ?? [];
  const box = el("div", "chord-diagram");
  box.appendChild(el("span", "cd-id", String(id)));
  box.title = `Voicing ID ${id}`;

  const play = el("button", "cd-play", "▶");
  play.title = "Play voicing";
  play.addEventListener("click", (event) => {
    event.stopPropagation();
    playVoicing(frets, tuning);
  });
  box.appendChild(play);

  // Head row: mute / open markers per string.
  const head = el("div", "cd-head");
  for (let stringIndex = 0; stringIndex < frets.length; stringIndex++) {
    const fret = frets[stringIndex];
    const marker = el("span", held[stringIndex] ? "cd-held" : "", fret === null ? "×" : fret === 0 ? "○" : "");
    if (fret === null || fret === 0) marker.title = held[stringIndex] ? "held open string" : "";
    head.appendChild(marker);
  }
  box.appendChild(head);

  // Body rows: fretted positions. Every diagram gets at least three frets so a
  // simple (or all-open) chord still reads as a grid beside fuller ones.
  const positives = frets.filter((fret): fret is number => fret !== null && fret > 0);
  const body = el("div", "cd-body");
  const lowFret = positives.length > 0 ? Math.min(...positives) : 1;
  const highFret = Math.max(positives.length > 0 ? Math.max(...positives) : lowFret, lowFret + 2);
  for (let fret = lowFret; fret <= highFret; fret++) {
    const row = el("div", "cd-row");
    row.appendChild(el("span", "cd-fretnum", fret));
    for (let stringIndex = 0; stringIndex < tuning.length; stringIndex++) {
      const cell = el("div", "cd-cell");
      cell.appendChild(el("span", "cd-string"));
      if (frets[stringIndex] === fret) {
        const pitchClass = (tuning[stringIndex] + fret) % SEMITONES;
        const dot = el("span", held[stringIndex] ? "cd-dot cd-held" : "cd-dot", nameOf(pitchClass));
        dot.style.setProperty("--c", colorFor(pitchClass));
        dot.title = held[stringIndex]
          ? `${nameOf(pitchClass)} · ${midiName(tuning[stringIndex] + fret)} · string ${stringIndex + 1} fret ${fret} · held`
          : `${nameOf(pitchClass)} · ${midiName(tuning[stringIndex] + fret)} · string ${stringIndex + 1} fret ${fret}`;
        cell.appendChild(dot);
      }
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  box.appendChild(body);

  // Barre annotations.
  const barres = findBarres(frets);
  if (barres.length > 0) {
    const b = el("div", "cd-barre", barres.map((r) => `barre fret ${r.fret} (${r.count} strings)`).join(" · "));
    box.appendChild(b);
  }

  // Finger numbers.
  const fingers = assignFingers(frets);
  const foot = el("div", "cd-foot");
  for (let stringIndex = 0; stringIndex < tuning.length; stringIndex++) {
    const fret = frets[stringIndex];
    foot.appendChild(el("span", "", fret === null ? "" : fingers[stringIndex] === 0 ? "o" : String(fingers[stringIndex])));
  }
  box.appendChild(foot);

  // Played notes reference line.
  const sounding = frets
    .map((fret, stringIndex) => (fret === null ? "×" : midiName(tuning[stringIndex] + fret)))
    .join(" ");
  box.appendChild(el("div", "cd-barre", sounding));

  if (mutedCount(frets) > 0) box.title = "muted strings: ×";
  return box;
}
/* ------------------------------------------------------------------ */
/* Riff timeline                                                        */
/* ------------------------------------------------------------------ */

const STRING_LETTERS = "eBGDAE";

export interface RiffTimelineOptions {
  tuning: number[];
  /** Click a note group to hear just that event. */
  onPlayEvent?: (index: number) => void;
  /** Loop window, drawn as a highlighted region. */
  loop?: { start: number; end: number } | null;
}

/**
 * The riff as a per-string grid: one row per string, one column per `step`, so
 * a run of single notes and a stack of chord notes read the same way. The
 * playhead is a separate absolutely-positioned element the transport moves, so
 * redrawing is never needed during playback.
 */
export function renderRiffTimeline(
  events: RiffEvent[],
  beatsPerBar: number,
  stepBeats: number,
  totalBeats: number,
  options: RiffTimelineOptions,
): HTMLElement {
  const { tuning } = options;
  const box = el("div", "riff-timeline");
  const stringCount = tuning.length;
  // One column per step; the final column carries the bar that starts there so
  // a long riff still gets a sensible width.
  const stepCount = Math.max(1, Math.ceil(totalBeats / stepBeats));
  box.style.setProperty("--riff-cols", String(stepCount));

  // Bar ruler.
  const ruler = el("div", "riff-ruler");
  const spacer = el("div", "riff-corner");
  ruler.appendChild(spacer);
  const barTrack = el("div", "riff-bar-track");
  for (let bar = 0; bar * beatsPerBar < totalBeats; bar++) {
    const cell = el("div", "riff-bar", String(bar + 1));
    cell.style.setProperty("--riff-bar-start", String((bar * beatsPerBar) / stepBeats));
    barTrack.appendChild(cell);
  }
  ruler.appendChild(barTrack);
  box.appendChild(ruler);

  // Loop region, drawn behind the notes. Positions are fractions handed to CSS
  // as custom properties so the gutter is accounted for exactly (a plain
  // percentage would measure from the container, not from the track).
  if (options.loop) {
    const region = el("div", "riff-loop");
    region.style.setProperty("--riff-loop-a", String(options.loop.start / totalBeats));
    region.style.setProperty("--riff-loop-b", String(options.loop.end / totalBeats));
    box.appendChild(region);
  }

  // One row per string, high E first, like reading tab.
  for (let stringIndex = stringCount - 1; stringIndex >= 0; stringIndex--) {
    const row = el("div", "riff-row");
    row.appendChild(el("div", "riff-stringlabel", STRING_LETTERS[stringCount - 1 - stringIndex]));
    // The track's own repeating gradient draws the step gridlines and its
    // width is the full step grid, so a note's `left: %` lands exactly on its
    // beat — no per-step children needed.
    row.appendChild(el("div", "riff-track"));
    box.appendChild(row);
  }

  // Notes, placed on their string's row at their step.
  const tracks = box.querySelectorAll<HTMLElement>(".riff-track");
  events.forEach((event, index) => {
    const step = Math.round(event.beat / stepBeats);
    const group = el("div", event.notes.length > 1 ? "riff-note riff-chord" : "riff-note");
    group.style.left = `${(step / stepCount) * 100}%`;
    group.title = `${event.label} — bar ${Math.floor(event.beat / beatsPerBar) + 1}, beat ${(event.beat % beatsPerBar) + 1}`;
    group.dataset.index = String(index);
    for (const note of event.notes) {
      const chip = el("span", "riff-fret", String(note.fret));
      chip.style.background = colorFor((tuning[note.stringIndex] + note.fret) % 12);
      group.appendChild(chip);
    }
    if (options.onPlayEvent) {
      group.classList.add("riff-clickable");
      group.addEventListener("click", (e) => {
        e.stopPropagation();
        options.onPlayEvent!(index);
      });
    }
    // A multi-string event is one group; anchor it to its topmost (highest
    // sounding) string so a strummed chord hangs together.
    const anchorRow = tracks.length - 1 - Math.max(...event.notes.map((n) => n.stringIndex));
    tracks[anchorRow]?.appendChild(group);
  });

  const head = el("div", "riff-playhead");
  box.appendChild(head);
  return box;
}

/**
 * The "what will I actually hear" list, in the order the ear gets it: one row
 * per MOMENT, grouped under its bar, with the beat inside the bar, the seconds
 * from the top, what the notation printed, and the sounding note names.
 *
 * The thing this exists to answer is the one the notation box hides: a chord
 * line is one token (`C`) and the app invents a shape for it, so "C" and
 * "e|--5---|" both look equally vague on the page. Here the invented shape is
 * spelled out — frets per string, then the notes — so a mis-voice is visible
 * without pressing play. Rows are clickable like the timeline's note groups.
 *
 * A chord and a tab note on the same beat are ONE row, not two. They are one
 * moment, and printing them as two rows at the same time read as a duplicated
 * entry rather than as the thing it is — a chord with a melody note on top.
 * The app decides the layering, so the row says which: `with A4 on top`.
 */
export function renderRiffReading(
  events: RiffEvent[],
  options: {
    bpm: number;
    beatsPerBar: number;
    stepBeats: number;
    totalBeats: number;
    tuning: number[];
    onPlayEvents?: (indices: number[]) => void;
  },
): HTMLElement {
  const { tuning, beatsPerBar, onPlayEvents } = options;
  const sounded = (event: RiffEvent) =>
    event.notes.map((note) => midiName(tuning[note.stringIndex] + note.fret)).join(" ");
  // One moment per row. Events are already beat-sorted, and only a chord and a
  // tab event can share a beat, so a run of equal beats is the whole chord.
  const moments: { beat: number; indices: number[] }[] = [];
  events.forEach((event, index) => {
    const last = moments[moments.length - 1];
    if (last && Math.abs(last.beat - event.beat) < 1e-9) last.indices.push(index);
    else moments.push({ beat: event.beat, indices: [index] });
  });
  // A long riff is a wall of rows, and the timeline below is the overview, so
  // cap the detail rather than burying the transport controls.
  const cap = 64;
  const shown = moments.slice(0, cap);
  const box = el("details", "riff-reading") as HTMLDetailsElement;
  const seconds = (beat: number) => (beat * 60) / options.bpm;
  const time = (beat: number) => `${seconds(beat).toFixed(2)}s`;
  const barCount = options.totalBeats / beatsPerBar;
  // A piece that is 3.5 bars long is worth showing as "3.5", but an exact one
  // should not read "4.0 bars" or "1 bars".
  const barText = `${barCount % 1 ? barCount.toFixed(1) : barCount} bar${barCount === 1 ? "" : "s"}`;

  box.appendChild(
    el("summary", "riff-reading-head", `What you'll hear · ${barText} · ${options.bpm} bpm · ${time(options.totalBeats)}`),
  );

  const list = el("div", "riff-reading-list");
  let bar = -1;
  for (const moment of shown) {
    const eventBar = Math.floor(moment.beat / beatsPerBar);
    if (eventBar !== bar) {
      bar = eventBar;
      const head = el("div", "riff-reading-bar");
      head.appendChild(el("span", "riff-reading-bar-name", `Bar ${bar + 1}`));
      head.appendChild(el("span", "riff-reading-bar-time", time(bar * beatsPerBar)));
      list.appendChild(head);
    }
    const here = moment.indices.map((index) => events[index]);
    const chord = here.find((event) => event.kind === "chord");
    const over = here.filter((event) => event.kind !== "chord");
    const row = el("div", "riff-reading-row");
    row.appendChild(el("span", "riff-reading-beat", `${(moment.beat % beatsPerBar) + 1}`));
    row.appendChild(el("span", "riff-reading-time", time(moment.beat)));
    // What the page said (`C` + `e5`, or just `5`) — kept verbatim so a row can
    // be matched back to a column of the notation by eye.
    row.appendChild(el("span", "riff-reading-label", here.map((event) => event.label).join(" + ")));
    // The shape only exists for a voicing the app chose; a tab event's tab is
    // already the label, verbatim from the lane. It gets its own column so the
    // shapes line up when you scan a progression instead of running together.
    row.appendChild(el("span", "riff-reading-shape", chord ? chordShape(chord.frets) : ""));
    const onTop = over.map(sounded).join(" + ");
    const bed = chord ? sounded(chord) : "";
    row.appendChild(el("span", "riff-reading-notes", chord && onTop ? `${bed} with ${onTop} on top` : chord ? bed : onTop));
    // Where the shape came from, which is the only part the app invented.
    const source = chord
      ? over.length
        ? "chord + tab"
        : "chord, auto-voiced"
      : over.some((event) => event.strumMs > 0)
        ? `tab, strum ${over.find((event) => event.strumMs > 0)!.strumMs}ms`
        : "tab";
    row.appendChild(el("span", "riff-reading-voiced", source));
    if (onPlayEvents) {
      row.classList.add("riff-clickable");
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        onPlayEvents(moment.indices);
      });
    }
    list.appendChild(row);
  }
  box.appendChild(list);
  if (moments.length > shown.length) {
    box.appendChild(
      el("div", "muted riff-reading-more", `+ ${moments.length - shown.length} more events — use the timeline below.`),
    );
  }
  return box;
}

/**
 * The bar ruler that sits directly above the notation box.
 *
 * This is the shared axis the two layers of the notation were missing: a chord
 * line is one token per BAR and a tab lane is one CHARACTER per column, so
 * nothing in the text showed where a bar boundary actually falls, and the one
 * thing worth understanding — that `C` and the tab's first column are the same
 * instant — had to be counted out by hand.
 *
 * It is aligned by CHARACTER, not by pixels: the box is monospace, so one
 * character is exactly one `ch` here too, and every offset is a `ch` count.
 * That holds as long as the ruler and the textarea share a font-size, a
 * font-family and a left padding, which is why the CSS pins all three to the
 * same custom properties instead of repeating literals.
 */
export function renderRiffGrid(beatsPerBar: number, stepBeats: number, totalBeats: number): HTMLElement[] {
  const perBar = Math.max(1, Math.round(beatsPerBar / stepBeats));
  // A lane body starts after its `e|`, so tab column 0 is character 2.
  const LANE_PREFIX = 2;
  const bars = Math.max(1, Math.round(totalBeats / beatsPerBar));
  const marks: HTMLElement[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const mark = el("div", "riff-grid-bar");
    mark.style.left = `${LANE_PREFIX + bar * perBar}ch`;
    mark.appendChild(el("span", "riff-grid-num", String(bar + 1)));
    marks.push(mark);
  }
  marks.push(el("div", "riff-grid-note", "bar"));
  return marks;
}

/** Move the playhead to a beat (fractional beats allowed). */
export function setRiffPlayhead(box: HTMLElement, beat: number, totalBeats: number): void {
  const fraction = totalBeats > 0 ? Math.max(0, Math.min(1, beat / totalBeats)) : 0;
  box.style.setProperty("--riff-head-frac", String(fraction));
}
