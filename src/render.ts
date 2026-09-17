import { playNotes, playVoicing } from "./audio.js";
import { findPositions, type Fingering } from "./fretboard.js";
import { midiName, SEMITONES } from "./theory.js";

export function el(tag: string, cls?: string, text?: string | number): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
}

export function colorFor(pc: number): string {
  return `hsl(${(pc * 30) % 360} 82% 60%)`;
}

function pcAt(tuning: number[], s: number, f: number): number {
  return (tuning[s]! + f) % SEMITONES;
}

function soundingMidi(tuning: number[], s: number, f: number|null): number | null {
  return f === null ? null : tuning[s]! + f;
}

/* ------------------------------------------------------------------ */
/* Fretboard positions grid                                            */
/* ------------------------------------------------------------------ */

export function renderPositions(
  tuning: number[],
  targetPcs: number[],
  maxFrets: number,
  nameOf: (pc: number) => string,
): HTMLElement {
  const positions = findPositions(targetPcs, tuning, maxFrets);
  const posByPos = new Set(positions.filter((p) => p.fret > 0).map((p) => `${p.string}:${p.fret}`));
  const colCount = maxFrets;

  const box = el("div", "fb");
  box.style.setProperty("--col-count", String(colCount));

  const nut = el("div", "fb-nut");
  for (let i = 0; i < tuning.length; i++) nut.appendChild(el("span", "fb-nut-dot"));
  box.appendChild(nut);

  for (let s = tuning.length - 1; s >= 0; s--) {
    const row = el("div", "fb-row");
    row.appendChild(el("span", "fb-string-label", midiName(tuning[s]!)));

    for (let f = 1; f <= maxFrets; f++) {
      const cell = el("div", "fb-cell");
      if (posByPos.has(`${s}:${f}`)) {
        const pc = pcAt(tuning, s, f);
        const dot = el("span", "fb-dot", nameOf(pc));
        dot.style.setProperty("--c", colorFor(pc));
        const midi = tuning[s]! + f;
        dot.title = `${nameOf(pc)} · ${midiName(midi)} · string ${s + 1} fret ${f}`;
        dot.addEventListener("click", () => playNotes([midi]));
        cell.appendChild(dot);
      }
      row.appendChild(cell);
    }
    box.appendChild(row);
  }

  const fretRow = el("div", "fb-fretrow");
  fretRow.appendChild(el("span"));
  for (let f = 1; f <= maxFrets; f++) fretRow.appendChild(el("span", "fb-fretnum", String(f)));
  box.appendChild(fretRow);

  return box;
}

/* ------------------------------------------------------------------ */
/* Chord diagrams                                                      */
/* ------------------------------------------------------------------ */

function assignFingers(frets: (number | null)[]): number[] {
  const sounding: number[] = [];
  for (const f of frets) if (f !== null && f > 0) sounding.push(f);
  const distinct = Array.from(new Set(sounding)).sort((a, b) => a - b);
  const rank = new Map<number, number>();
  distinct.forEach((f, i) => rank.set(f, i + 1));
  return frets.map((f) => (f === null || f === 0 ? 0 : rank.get(f)!));
}

function findBarres(frets: (number | null)[]): { fret: number; count: number }[] {
  const out: { fret: number; count: number }[] = [];
  let i = 0;
  while (i < frets.length) {
    const f = frets[i];
    if (f === null || f === 0) { i++; continue; }
    let j = i;
    while (j + 1 < frets.length && frets[j + 1] === f) j++;
    if (j - i + 1 >= 2) out.push({ fret: f, count: j - i + 1 });
    i = j + 1;
  }
  return out;
}

function mutedCount(frets: (number | null)[]): number {
  return frets.filter((f) => f === null).length;
}

/* ------------------------------------------------------------------ */
/* Piano keyboard                                                      */
/* ------------------------------------------------------------------ */

const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);

interface KeyView {
  whites: number[];
  blacks: number[];
}

function keyView(low: number, high: number): KeyView {
  const whites: number[] = [];
  const blacks: number[] = [];
  for (let m = Math.min(low, high); m <= Math.max(low, high); m++) {
    if (WHITE_PCS.has(((m % SEMITONES) + SEMITONES) % SEMITONES)) whites.push(m);
    else blacks.push(m);
  }
  return { whites, blacks };
}

function keyboardEl(
  low: number,
  high: number,
  marked: Set<number>,
  nameOf: (pc: number) => string,
  baseClass: string,
  extraClass = "",
): HTMLElement {
  const { whites, blacks } = keyView(low, high);
  const wc = Math.max(1, whites.length);
  const box = el("div", extraClass ? `${baseClass} ${extraClass}` : baseClass);
  box.style.maxWidth = `max(9rem, calc(var(--key-w, 2.4rem) * ${whites.length}))`;

  const wrow = el("div", `${baseClass}-white`);
  for (const m of whites) {
    const pc = ((m % SEMITONES) + SEMITONES) % SEMITONES;
    const wkey = el("div", `${baseClass}-wkey`);
    if (marked.has(m)) {
      wkey.style.background = colorFor(pc);
      wkey.classList.add("kb-hit");
    }
    wkey.appendChild(el("span", `${baseClass}-mark`, nameOf(pc)));
    wkey.title = midiName(m);
    wkey.addEventListener("click", () => playNotes([m]));
    wrow.appendChild(wkey);
  }
  box.appendChild(wrow);

  for (const m of blacks) {
    let leftCount = 0;
    for (const w of whites) if (w < m) leftCount++;
    const pc = ((m % SEMITONES) + SEMITONES) % SEMITONES;
    const bkey = el("div", `${baseClass}-bkey`);
    if (marked.has(m)) {
      bkey.style.background = colorFor(pc);
      bkey.classList.add("kb-hit");
    }
    bkey.style.left = `${(leftCount / wc) * 100}%`;
    bkey.style.width = `${(0.62 / wc) * 100}%`;
    bkey.title = midiName(m);
    bkey.addEventListener("click", () => playNotes([m]));
    bkey.appendChild(el("span", `${baseClass}-mark`, nameOf(pc)));
    wrow.appendChild(bkey);
  }
  return box;
}

/** Full-range keyboard with every occurrence of each target note marked. */
export function renderPiano(
  low: number,
  high: number,
  targetPcs: number[],
  nameOf: (pc: number) => string,
): HTMLElement {
  const targets = new Set(targetPcs);
  const marked = new Set<number>();
  const { whites, blacks } = keyView(low, high);
  for (const m of [...whites, ...blacks]) {
    if (targets.has(((m % SEMITONES) + SEMITONES) % SEMITONES)) marked.add(m);
  }
  return keyboardEl(low, high, marked, nameOf, "kb");
}

/** Mini keyboard showing one piano voicing; ▶ plays the pressed keys. */
export function renderPianoVoicing(
  keys: number[],
  nameOf: (pc: number) => string,
  id: number,
): HTMLElement {
  const box = keyboardEl(Math.min(...keys), Math.max(...keys), new Set(keys), nameOf, "kb", "pp");
  box.appendChild(el("span", "cd-id", String(id)));
  box.title = `Voicing ID ${id}`;

  const play = el("button", "cd-play", "▶");
  play.title = "Play voicing";
  play.addEventListener("click", (e) => {
    e.stopPropagation();
    playNotes(keys);
  });
  box.appendChild(play);
  return box;
}

export function renderChordDiagram(
  fingering: Fingering,
  tuning: number[],
  nameOf: (pc: number) => string,
  id: number,
): HTMLElement {
  const { frets } = fingering;
  const box = el("div", "chord-diagram");
  box.appendChild(el("span", "cd-id", String(id)));
  box.title = `Voicing ID ${id}`;

  const play = el("button", "cd-play", "▶");
  play.title = "Play voicing";
  play.addEventListener("click", (e) => {
    e.stopPropagation();
    playVoicing(frets, tuning);
  });
  box.appendChild(play);

  // Head row: mute / open markers per string.
  const head = el("div", "cd-head");
  for (const f of frets) head.appendChild(el("span", "", f === null ? "×" : f === 0 ? "○" : ""));
  box.appendChild(head);

  // Body rows: fretted positions only.
  const positives = frets.filter((f): f is number => f !== null && f > 0);
  const body = el("div", "cd-body");
  if (positives.length > 0) {
    const lo = Math.min(...positives);
    const hi = Math.max(...positives);
    for (let f = lo; f <= hi; f++) {
      const row = el("div", "cd-row");
      row.appendChild(el("span", "cd-fretnum", f));
      for (let s = 0; s < tuning.length; s++) {
        const cell = el("div", "cd-cell");
        cell.appendChild(el("span", "cd-string"));
        if (frets[s] === f) {
          const pc = pcAt(tuning, s, f);
          const dot = el("span", "cd-dot", nameOf(pc));
          dot.style.setProperty("--c", colorFor(pc));
          dot.title = `${nameOf(pc)} · ${midiName(tuning[s]! + f)} · string ${s + 1} fret ${f}`;
          cell.appendChild(dot);
        }
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
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
  for (let s = 0; s < tuning.length; s++) {
    const fr = frets[s];
    foot.appendChild(el("span", "", fr === null ? "" : fingers[s] === 0 ? "o" : String(fingers[s])));
  }
  box.appendChild(foot);

  // Played notes reference line.
  const sounding = frets
    .map((f, s) => (f === null ? "×" : midiName(soundingMidi(tuning, s, f)!)))
    .join(" ");
  box.appendChild(el("div", "cd-barre", sounding));

  if (mutedCount(frets) > 0) box.title = "muted strings: ×";
  return box;
}