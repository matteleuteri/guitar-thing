import { DEFAULT_CONFIG } from "./synth/config.js";
import { findFingerings, type Fingering } from "./fretboard.js";
import { findPianoVoicings, type PianoVoicing } from "./piano.js";
import { colorFor, el, renderChordDiagram, renderPiano, renderPianoVoicing, renderPositions } from "./render.js";
import {
  chordName,
  noteLabels,
  noteName,
  parseStringMidi,
  TUNINGS,
} from "./theory.js";

const DEFAULTPCS = new Set([0, 4, 7]); // C E G

document.addEventListener("DOMContentLoaded", () => {
  const noteGrid = document.getElementById("note-grid") as HTMLDivElement;
  const instrumentSelect = document.getElementById("instrument") as HTMLSelectElement;
  const guitarOnly = document.getElementById("guitar-only") as HTMLDivElement;
  const pianoOnly = document.getElementById("piano-only") as HTMLDivElement;
  const tuningSelect = document.getElementById("tuning") as HTMLSelectElement;
  const fretsInput = document.getElementById("frets") as HTMLInputElement;
  const strumInput = document.getElementById("strum") as HTMLInputElement;
  const pianoLowInput = document.getElementById("piano-low") as HTMLInputElement;
  const pianoHighInput = document.getElementById("piano-high") as HTMLInputElement;
  const keySizeInput = document.getElementById("key-size") as HTMLInputElement;
  const spanInput = document.getElementById("span") as HTMLInputElement;
  const spanLabel = document.getElementById("span-label") as HTMLLabelElement;
  const capInput = document.getElementById("cap") as HTMLInputElement;
  const form = document.getElementById("form") as HTMLFormElement;
  const error = document.getElementById("error") as HTMLParagraphElement;
  const legend = document.getElementById("legend") as HTMLDivElement;
  const posBoard = document.getElementById("positions-board") as HTMLDivElement;
  const chordList = document.getElementById("chord-list") as HTMLDivElement;
  const chordSummary = document.getElementById("chord-summary") as HTMLSpanElement;
  const positionsTitle = document.getElementById("positions-title") as HTMLElement;
  const chordsTitle = document.getElementById("chords-title") as HTMLElement;
  const customTuning = document.getElementById("custom-tuning") as HTMLDetailsElement;
  const customStrings = Array.from(customTuning.querySelectorAll("input")) as HTMLInputElement[];
  const selectedPcs = new Set<number>(DEFAULTPCS);
  const noteButtons: HTMLButtonElement[] = [];

  const refreshNoteButtons = () => {
    for (let pc = 0; pc < noteButtons.length; pc++) {
      const b = noteButtons[pc]!;
      const on = selectedPcs.has(pc);
      b.classList.toggle("selected", on);
      b.style.background = on ? colorFor(pc) : "";
      b.setAttribute("aria-pressed", String(on));
    }
  };

  for (let pc = 0; pc < 12; pc++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "note-btn";
    b.textContent = noteLabels(pc);
    b.title = noteLabels(pc);
    b.addEventListener("click", () => {
      if (selectedPcs.has(pc)) selectedPcs.delete(pc);
      else selectedPcs.add(pc);
      refreshNoteButtons();
      run();
    });
    noteButtons.push(b);
    noteGrid.appendChild(b);
  }
  refreshNoteButtons();

  for (const t of TUNINGS) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.label;
    tuningSelect.appendChild(opt);
  }

  tuningSelect.addEventListener("change", () => {
    customTuning.hidden = tuningSelect.value !== "custom";
  });

  const SPAN_DEFAULTS: Record<string, number> = { guitar: 5, piano: 12 };
  const spans: Record<string, number> = { ...SPAN_DEFAULTS };

  const saveSpan = (mode: string) => {
    const n = parseInt(spanInput.value, 10);
    if (Number.isFinite(n)) spans[mode] = Math.min(24, Math.max(1, n));
  };

  let currentInstrument = instrumentSelect.value;

  instrumentSelect.addEventListener("change", () => {
    saveSpan(currentInstrument);
    const mode = instrumentSelect.value;
    guitarOnly.hidden = mode !== "guitar";
    pianoOnly.hidden = mode !== "piano";
    spanLabel.textContent = mode === "piano" ? "Max span (keys)" : "Max span (frets)";
    spanInput.value = String(spans[mode] ?? SPAN_DEFAULTS[mode]!);
    currentInstrument = mode;
    run();
  }, { passive: false });

  keySizeInput.addEventListener("change", () => run());

  // Top-level strum speed: lives on the shared config object so `playVoicing`
  // picks it up on the next click. 0 = all strings strike together.
  const applyStrum = () => {
    const n = parseInt(strumInput.value, 10);
    if (Number.isFinite(n)) DEFAULT_CONFIG.strum.guitarMs = Math.min(400, Math.max(0, n));
  };
  strumInput.addEventListener("input", applyStrum);
  strumInput.addEventListener("change", applyStrum);

  const getTuning = (): number[] => {
    const t = TUNINGS.find((x) => x.id === tuningSelect.value)!;
    if (t.id !== "custom") return t.midi;
    return customStrings.map((input, i) => parseStringMidi(input.value, i));
  };

  const setError = (msg: string | null) => {
    error.hidden = msg === null;
    error.textContent = msg ?? "";
  };

  function renderLegend(pcs: number[]) {
    legend.replaceChildren();
    for (const pc of pcs) {
      const item = el("span", "legend-item");
      const sw = el("span", "legend-swatch");
      sw.style.background = colorFor(pc);
      item.appendChild(sw);
      item.appendChild(el("span", "", noteName(pc)));
      legend.appendChild(item);
    }
  }

  function renderChordCard(
    chordPcs: number[],
    fingerings: Fingering[],
    truncated: boolean,
    tuning: number[],
  ): HTMLElement {
    const card = el("div", "chord-card");
    const name = chordName(chordPcs);
    const h = el("h3", "", name.primary);
    if (name.alternatives.length > 0) {
      h.appendChild(el("span", "muted", `  · also ${name.alternatives.join(", ")}`));
    }
    card.appendChild(h);
    card.appendChild(
      el("div", "chord-notes", `${chordPcs.map(noteName).join(" ")}  (${chordPcs.length} notes)`),
    );

    if (fingerings.length === 0) {
      card.appendChild(el("div", "chord-count", "no fingerings within the chosen fret span"));
      return card;
    }

    card.appendChild(
      el("div", "chord-count", `${fingerings.length} fingering${fingerings.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`),
    );

    const grid = el("div", "diagrams");
    for (let i = 0; i < fingerings.length; i++) {
      const f = fingerings[i]!;
      grid.appendChild(renderChordDiagram(f, tuning, noteName, i + 1));
    }
    card.appendChild(grid);
    return card;
  }

  function renderPianoCard(
    chordPcs: number[],
    voicings: PianoVoicing[],
    truncated: boolean,
  ): HTMLElement {
    const card = el("div", "chord-card");
    const name = chordName(chordPcs);
    const h = el("h3", "", name.primary);
    if (name.alternatives.length > 0) {
      h.appendChild(el("span", "muted", `  · also ${name.alternatives.join(", ")}`));
    }
    card.appendChild(h);
    card.appendChild(
      el("div", "chord-notes", `${chordPcs.map(noteName).join(" ")}  (${chordPcs.length} notes)`),
    );

    if (voicings.length === 0) {
      card.appendChild(el("div", "chord-count", "no voicings within the chosen reach"));
      return card;
    }

    const grid = el("div", "diagrams");
    for (let i = 0; i < voicings.length; i++) {
      const v = voicings[i]!;
      grid.appendChild(renderPianoVoicing(v.keys, noteName, i + 1));
    }
    card.appendChild(
      el("div", "chord-count", `${voicings.length} voicing${voicings.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`),
    );
    card.appendChild(grid);
    return card;
  }

  const applyKeySize = () => {
    const size = Math.min(6, Math.max(1.5, parseFloat(keySizeInput.value) || 3));
    document.documentElement.style.setProperty("--key-w", `${size}rem`);
  };

  function run() {
    setError(null);
    chordList.replaceChildren();
    chordSummary.textContent = "";
    applyKeySize();

    const isPiano = instrumentSelect.value === "piano";
    positionsTitle.textContent = isPiano ? "Keyboard positions" : "Fretboard positions";
    chordsTitle.textContent = isPiano ? "Chord voicings" : "Chord fingerings";

    let pcs: number[];
    let tuning: number[] = TUNINGS[0]!.midi;
    let fretCount = 15;
    let span: number;
    let cap: number;
    let pianoLow = 48;
    let pianoHigh = 84;
    try {
      pcs = [...selectedPcs].sort((a, b) => a - b);
      span = Math.min(24, Math.max(1, parseInt(spanInput.value, 10) || SPAN_DEFAULTS[instrumentSelect.value]!));
      cap = Math.max(1, parseInt(capInput.value, 10) || 500);
      if (instrumentSelect.value === "piano") {
        pianoLow = Math.min(108, Math.max(21, parseInt(pianoLowInput.value, 10) || 48));
        pianoHigh = Math.min(108, Math.max(21, parseInt(pianoHighInput.value, 10) || 84));
        if (pianoLow >= pianoHigh) throw new Error("Lowest key must be below the highest key.");
      } else {
        tuning = getTuning();
        fretCount = Math.min(24, Math.max(7, parseInt(fretsInput.value, 10) || 15));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    const nameOf = noteName;
    legend.replaceChildren();
    renderLegend(pcs);

    if (pcs.length < 2) {
      chordSummary.textContent = "(need at least 2 notes for chords)";
      return;
    }

    if (instrumentSelect.value === "piano") {
      posBoard.replaceChildren(renderPiano(pianoLow, pianoHigh, pcs, nameOf));
      const { voicings, truncated } = findPianoVoicings(pcs, pianoLow, pianoHigh, span, cap);
      chordList.appendChild(renderPianoCard(pcs, voicings, truncated));
      chordSummary.textContent = `· ${voicings.length} voicing${voicings.length === 1 ? "" : "s"} for ${chordName(pcs).primary}`;
      return;
    }

    posBoard.replaceChildren(renderPositions(tuning, pcs, fretCount, nameOf));

    // Chord list: every provided note must be in the chord voicing.
    const { fingerings, truncated } = findFingerings(pcs, tuning, fretCount, span, cap);
    chordList.appendChild(renderChordCard(pcs, fingerings, truncated, tuning));
    chordSummary.textContent = `· ${fingerings.length} fingering${fingerings.length === 1 ? "" : "s"} for ${chordName(pcs).primary}`;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSpan(instrumentSelect.value);
    run();
  });

  run();
});