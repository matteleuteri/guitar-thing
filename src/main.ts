import { stopAudio, playNotes, playVoicing } from "./audio.js";
import { DEFAULT_CONFIG } from "./synth/config.js";
import { findFingerings, type Fingering } from "./fretboard.js";
import { findPianoVoicings, type PianoVoicing } from "./piano.js";
import { colorFor, el, renderChordDiagram, renderPiano, renderPianoVoicing, renderPositions } from "./render.js";
import {
  chordName,
  midiName,
  noteLabels,
  noteName,
  parseStringMidi,
  TUNINGS,
  type ParsedChord,
} from "./theory.js";
import {
  parseProgression,
  planChordLabel,
  planGuitarSong,
  planPianoSong,
  type GuitarSongChord,
  type PianoSongChord,
} from "./song.js";

const DEFAULTPCS = new Set([0, 4, 7]); // C E G

document.addEventListener("DOMContentLoaded", () => {
  const noteGrid = document.getElementById("note-grid") as HTMLDivElement;
  const notePicker = document.getElementById("note-picker") as HTMLDivElement;
  const modeSelect = document.getElementById("mode") as HTMLSelectElement;
  const descChord = document.getElementById("desc-chord") as HTMLParagraphElement;
  const descSong = document.getElementById("desc-song") as HTMLParagraphElement;
  const songOnly = document.getElementById("song-only") as HTMLDivElement;
  const progressionInput = document.getElementById("progression") as HTMLInputElement;
  const gapInput = document.getElementById("gap") as HTMLInputElement;
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
  const capLabel = document.getElementById("cap-label") as HTMLLabelElement;
  const form = document.getElementById("form") as HTMLFormElement;
  const error = document.getElementById("error") as HTMLParagraphElement;
  const legend = document.getElementById("legend") as HTMLDivElement;
  const posSection = document.getElementById("positions") as HTMLElement;
  const posBoard = document.getElementById("positions-board") as HTMLDivElement;
  const chordList = document.getElementById("chord-list") as HTMLDivElement;
  const chordSummary = document.getElementById("chord-summary") as HTMLSpanElement;
  const songActions = document.getElementById("song-actions") as HTMLSpanElement;
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

  // Whole-song playback: queue each chord's voicing `gapMs` apart.
  let songTimers: number[] = [];
  const cancelSong = () => {
    for (const t of songTimers) clearTimeout(t);
    songTimers = [];
    stopAudio();
  };

  modeSelect.addEventListener("change", () => run());

  interface Params {
    pcs: number[];
    span: number;
    cap: number;
    tuning: number[];
    fretCount: number;
    pianoLow: number;
    pianoHigh: number;
  }

  function readParams(): Params {
    const span = Math.min(24, Math.max(1, parseInt(spanInput.value, 10) || SPAN_DEFAULTS[instrumentSelect.value]!));
    const cap = Math.max(1, parseInt(capInput.value, 10) || 500);
    const pcs = [...selectedPcs].sort((a, b) => a - b);
    if (instrumentSelect.value === "piano") {
      const pianoLow = Math.min(108, Math.max(21, parseInt(pianoLowInput.value, 10) || 48));
      const pianoHigh = Math.min(108, Math.max(21, parseInt(pianoHighInput.value, 10) || 84));
      if (pianoLow >= pianoHigh) throw new Error("Lowest key must be below the highest key.");
      return { pcs, span, cap, tuning: TUNINGS[0]!.midi, fretCount: 15, pianoLow, pianoHigh };
    }
    return {
      pcs,
      span,
      cap,
      tuning: getTuning(),
      fretCount: Math.min(24, Math.max(7, parseInt(fretsInput.value, 10) || 15)),
      pianoLow: 48,
      pianoHigh: 84,
    };
  }

  function runSong(p: Params) {
    const isPiano = instrumentSelect.value === "piano";
    chordsTitle.textContent = "Song arrangement";

    let progression: ParsedChord[];
    let gapMs: number;
    try {
      progression = parseProgression(progressionInput.value);
      gapMs = Math.min(10000, Math.max(200, parseInt(gapInput.value, 10) || 1500));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    const plan = isPiano
      ? planPianoSong(progression, p.pianoLow, p.pianoHigh, p.span, p.cap)
      : planGuitarSong(progression, p.tuning, p.fretCount, p.span, p.cap);
    if (!plan) {
      chordSummary.textContent = "(a chord has no voicing within the chosen span/reach)";
      return;
    }

    chordSummary.textContent =
      `· ${plan.chords.length} chord${plan.chords.length === 1 ? "" : "s"} · ` +
      `total move ${Math.round(plan.totalMove * 10) / 10}` +
      (plan.truncated ? " (per-chord candidates capped)" : "");

    songActions.replaceChildren();
    const playAll = el("button", "song-play", "Play arrangement ▶");
    playAll.title = "Strums every chord in sequence, one per chord-gap period";
    playAll.addEventListener("click", () => {
      cancelSong();
      const chords = plan.chords;
      for (let i = 0; i < chords.length; i++) {
        songTimers.push(setTimeout(() => {
          const c = chords[i]!;
          if (isPiano) playNotes((c as PianoSongChord).voicing.keys, true);
          else playVoicing((c as GuitarSongChord).fingering.frets, p.tuning);
        }, i * gapMs));
      }
    });
    songActions.appendChild(playAll);

    const nameOf = noteName;
    plan.chords.forEach((c, i) => {
      const card = el("div", "chord-card song-card");
      const h = el("h3", "", planChordLabel(c.chord));
      if (c.chord.bass !== null) h.appendChild(el("span", "muted", `  · ${noteName(c.chord.bass)} bass`));
      card.appendChild(h);

      const grid = el("div", "diagrams");
      if (isPiano) {
        const pc = c as PianoSongChord;
        grid.appendChild(renderPianoVoicing(pc.voicing.keys, nameOf, i + 1, { held: pc.held }));
      } else {
        const gc = c as GuitarSongChord;
        const heldArr = new Array<boolean>(p.tuning.length).fill(false);
        for (const s of gc.held) heldArr[s] = true;
        grid.appendChild(renderChordDiagram(gc.fingering, p.tuning, nameOf, i + 1, { held: heldArr }));
      }
      card.appendChild(grid);

      const moveLine = el("div", "song-move");
      const bits: string[] = [];
      if (i > 0) {
        bits.push(`move ${Math.round(c.move * 10) / 10}`);
        if (c.held.length > 0) {
          bits.push(isPiano
            ? `hold ${(c as PianoSongChord).held.map(midiName).join(" ")}`
            : `hold string${c.held.length > 1 ? "s" : ""} ${(c as GuitarSongChord).held.map((s) => s + 1).join(", ")}`);
        }
        if (c.chord.bass !== null && !c.bassMatches) bits.push("lowest note ≠ bass");
      } else if (c.chord.bass !== null && !c.bassMatches) {
        bits.push("lowest note misses the written bass");
      }
      moveLine.textContent = i === 0 ? `start here${bits.length ? ` · ${bits.join(" · ")}` : ""}` : bits.join(" · ");
      card.appendChild(moveLine);
      chordList.appendChild(card);
    });
  }

  function run() {
    setError(null);
    cancelSong();
    chordList.replaceChildren();
    chordSummary.textContent = "";
    songActions.replaceChildren();
    applyKeySize();

    const isPiano = instrumentSelect.value === "piano";
    const isSong = modeSelect.value === "song";
    notePicker.hidden = isSong;
    songOnly.hidden = !isSong;
    posSection.hidden = isSong;
    descChord.hidden = isSong;
    descSong.hidden = !isSong;
    capLabel.textContent = isSong ? "Max shapes / chord" : "Max results / chord";
    positionsTitle.textContent = isPiano ? "Keyboard positions" : "Fretboard positions";
    chordsTitle.textContent = isSong ? "Song arrangement" : isPiano ? "Chord voicings" : "Chord fingerings";

    let p: Params;
    try {
      p = readParams();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    if (isSong) {
      runSong(p);
      return;
    }

    const nameOf = noteName;
    legend.replaceChildren();
    renderLegend(p.pcs);

    if (p.pcs.length < 2) {
      chordSummary.textContent = "(need at least 2 notes for chords)";
      return;
    }

    if (isPiano) {
      posBoard.replaceChildren(renderPiano(p.pianoLow, p.pianoHigh, p.pcs, nameOf));
      const { voicings, truncated } = findPianoVoicings(p.pcs, p.pianoLow, p.pianoHigh, p.span, p.cap);
      chordList.appendChild(renderPianoCard(p.pcs, voicings, truncated));
      chordSummary.textContent = `· ${voicings.length} voicing${voicings.length === 1 ? "" : "s"} for ${chordName(p.pcs).primary}`;
      return;
    }

    posBoard.replaceChildren(renderPositions(p.tuning, p.pcs, p.fretCount, nameOf));

    // Chord list: every provided note must be in the chord voicing.
    const { fingerings, truncated } = findFingerings(p.pcs, p.tuning, p.fretCount, p.span, p.cap);
    chordList.appendChild(renderChordCard(p.pcs, fingerings, truncated, p.tuning));
    chordSummary.textContent = `· ${fingerings.length} fingering${fingerings.length === 1 ? "" : "s"} for ${chordName(p.pcs).primary}`;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSpan(instrumentSelect.value);
    run();
  });

  run();
});