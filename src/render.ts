import { playNotes, playVoicing } from "./audio.js";
import { findPositions, type Fingering } from "./fretboard.js";
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
        dot.addEventListener("click", () => playNotes([midi]));
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