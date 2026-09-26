import { stopAudio, playNotes, playVoicing, preloadGuitarEngine, primeAudio, audioNow, getSmplrStatus, getAudioDebugEvents, getGuitarKit, setGuitarKit, type GuitarKitName } from "./audio.js";
import { DEFAULT_CONFIG } from "./synth/config.js";
import { findFingerings, type Fingering } from "./fretboard.js";
import { findPianoVoicings, type PianoVoicing } from "./piano.js";
import { colorFor, el, renderChordDiagram, renderPiano, renderPianoVoicing, renderPositions, renderRiffGrid, renderRiffReading, renderRiffTimeline, setRiffPlayhead } from "./render.js";
import { parseRiff, secondsPerBeat, stepName, type Riff, type RiffEvent } from "./riff.js";
import { RiffTransport } from "./transport.js";
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

const DEFAULT_PCS = new Set([0, 4, 7]); // C E G

/** Idle time before an edit to the riff notation is re-planned. */
const RIFF_EDIT_MS = 300;

/** Narrow the per-chord union by which plan kind produced it. */
function isPianoChord(chord: GuitarSongChord | PianoSongChord): chord is PianoSongChord {
  return "voicing" in chord;
}

document.addEventListener("DOMContentLoaded", () => {
  // Console ground truth for what the page actually plays: `__audio.status()`
  // (kit ready/loading) and `__audio.debug()` (the last voices: kind, midi,
  // role, time). Permanent, like `getAudioDebugEvents` in audio.ts.
  (globalThis as { __audio?: unknown }).__audio = {
    status: getSmplrStatus,
    debug: getAudioDebugEvents,
  };
  // Start the audio graph + smplr kit fetch/decode right away (no gesture
  // needed: the context is created suspended) so the FIRST voicing click
  // already plays the real guitar kit instead of the samples/synth fallback
  // that lazily-built engines cause on the first play.
  if (DEFAULT_CONFIG.engine.mode === "smplr") preloadGuitarEngine();
  const noteGrid = document.getElementById("note-grid") as HTMLDivElement;
  const notePicker = document.getElementById("note-picker") as HTMLDivElement;
  const modeSelect = document.getElementById("mode") as HTMLSelectElement;
  const descChord = document.getElementById("desc-chord") as HTMLParagraphElement;
  const descSong = document.getElementById("desc-song") as HTMLParagraphElement;
  const descRiff = document.getElementById("desc-riff") as HTMLParagraphElement;
  const songOnly = document.getElementById("song-only") as HTMLDivElement;
  const riffOnly = document.getElementById("riff-only") as HTMLDivElement;
  const riffText = document.getElementById("riff-text") as HTMLTextAreaElement;
  const riffGrid = document.getElementById("riff-grid") as HTMLDivElement;
  const riffScale = document.getElementById("riff-scale") as HTMLInputElement;
  const riffLoopStart = document.getElementById("riff-loop-start") as HTMLInputElement;
  const riffLoopEnd = document.getElementById("riff-loop-end") as HTMLInputElement;
  const riffPlay = document.getElementById("riff-play") as HTMLButtonElement;
  const riffStop = document.getElementById("riff-stop") as HTMLButtonElement;
  const progressionInput = document.getElementById("progression") as HTMLInputElement;
  const gapInput = document.getElementById("gap") as HTMLInputElement;
  const instrumentSelect = document.getElementById("instrument") as HTMLSelectElement;
  const guitarOnly = document.getElementById("guitar-only") as HTMLDivElement;
  const pianoOnly = document.getElementById("piano-only") as HTMLDivElement;
  const tuningSelect = document.getElementById("tuning") as HTMLSelectElement;
  const fretsInput = document.getElementById("frets") as HTMLInputElement;
  const strumInput = document.getElementById("strum") as HTMLInputElement;
  const kitButton = document.getElementById("kit") as HTMLButtonElement;
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
  const selectedPitchClasses = new Set<number>(DEFAULT_PCS);
  const noteButtons: HTMLButtonElement[] = [];

  const refreshNoteButtons = () => {
    for (let pitchClass = 0; pitchClass < noteButtons.length; pitchClass++) {
      const button = noteButtons[pitchClass];
      const on = selectedPitchClasses.has(pitchClass);
      button.classList.toggle("selected", on);
      button.style.background = on ? colorFor(pitchClass) : "";
      button.setAttribute("aria-pressed", String(on));
    }
  };

  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-btn";
    button.textContent = noteLabels(pitchClass);
    button.title = noteLabels(pitchClass);
    button.addEventListener("click", () => {
      if (selectedPitchClasses.has(pitchClass)) selectedPitchClasses.delete(pitchClass);
      else selectedPitchClasses.add(pitchClass);
      refreshNoteButtons();
      run();
    });
    noteButtons.push(button);
    noteGrid.appendChild(button);
  }
  refreshNoteButtons();

  for (const tuning of TUNINGS) {
    const option = document.createElement("option");
    option.value = tuning.id;
    option.textContent = tuning.label;
    tuningSelect.appendChild(option);
  }

  tuningSelect.addEventListener("change", () => {
    customTuning.hidden = tuningSelect.value !== "custom";
  });

  const SPAN_DEFAULTS: Record<string, number> = { guitar: 5, piano: 12 };
  const spans: Record<string, number> = { ...SPAN_DEFAULTS };

  const saveSpan = (mode: string) => {
    const value = parseInt(spanInput.value, 10);
    if (Number.isFinite(value)) spans[mode] = Math.min(24, Math.max(1, value));
  };

  let currentInstrument = instrumentSelect.value;

  const applyInstrumentVisibility = () => {
    const mode = instrumentSelect.value;
    guitarOnly.hidden = mode !== "guitar";
    pianoOnly.hidden = mode !== "piano";
    spanLabel.textContent = mode === "piano" ? "Max span (keys)" : "Max span (frets)";
    spanInput.value = String(spans[mode] ?? SPAN_DEFAULTS[mode]);
  };

  instrumentSelect.addEventListener("change", () => {
    saveSpan(currentInstrument);
    currentInstrument = instrumentSelect.value;
    applyInstrumentVisibility();
    run();
  }, { passive: false });

  keySizeInput.addEventListener("change", () => run());

  // Top-level strum speed: lives on the shared config object so `playVoicing`
  // picks it up on the next click. 0 = all strings strike together.
  const applyStrum = () => {
    const ms = parseInt(strumInput.value, 10);
    if (Number.isFinite(ms)) DEFAULT_CONFIG.strum.guitarMs = Math.min(400, Math.max(0, ms));
  };
  strumInput.addEventListener("input", applyStrum);
  strumInput.addEventListener("change", applyStrum);

  // Sampled-guitar kit toggle (progress 22): steel-string acoustic ↔ classical
  // nylon. The button shows the ACTIVE kit; clicking rebuilds the smplr engine
  // with the other one. The label is set after `preloadGuitarEngine` above so a
  // persisted choice from a previous session is reflected.
  const KIT_NAMES: Record<GuitarKitName, string> = {
    steel: "Steel-string acoustic",
    nylon: "Classical nylon",
  };
  let guitarKit = getGuitarKit();
  const refreshKitButton = () => {
    const other: GuitarKitName = guitarKit === "steel" ? "nylon" : "steel";
    kitButton.textContent = KIT_NAMES[guitarKit];
    kitButton.title = `Sampled guitar kit: ${KIT_NAMES[guitarKit].toLowerCase()}. Click to switch to ${KIT_NAMES[other].toLowerCase()}.`;
  };
  kitButton.addEventListener("click", () => {
    guitarKit = guitarKit === "steel" ? "nylon" : "steel";
    setGuitarKit(guitarKit);
    refreshKitButton();
  });
  refreshKitButton();

  const getTuning = (): number[] => {
    const tuning = TUNINGS.find((x) => x.id === tuningSelect.value)!;
    if (tuning.id !== "custom") return tuning.midi;
    return customStrings.map((input, i) => parseStringMidi(input.value, i));
  };

  const setError = (msg: string | null) => {
    error.hidden = msg === null;
    error.textContent = msg ?? "";
  };

  function renderLegend(pitchClasses: number[]) {
    legend.replaceChildren();
    for (const pitchClass of pitchClasses) {
      const item = el("span", "legend-item");
      const swatch = el("span", "legend-swatch");
      swatch.style.background = colorFor(pitchClass);
      item.appendChild(swatch);
      item.appendChild(el("span", "", noteName(pitchClass)));
      legend.appendChild(item);
    }
  }

  function renderChordCard(
    chordPitchClasses: number[],
    fingerings: Fingering[],
    truncated: boolean,
    tuning: number[],
  ): HTMLElement {
    const card = el("div", "chord-card");
    const name = chordName(chordPitchClasses);
    const heading = el("h3", "", name.primary);
    if (name.alternatives.length > 0) {
      heading.appendChild(el("span", "muted", `  · also ${name.alternatives.join(", ")}`));
    }
    card.appendChild(heading);
    card.appendChild(
      el("div", "chord-notes", `${chordPitchClasses.map(noteName).join(" ")}  (${chordPitchClasses.length} notes)`),
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
      grid.appendChild(renderChordDiagram(fingerings[i], tuning, noteName, i + 1));
    }
    card.appendChild(grid);
    return card;
  }

  function renderPianoCard(
    chordPitchClasses: number[],
    voicings: PianoVoicing[],
    truncated: boolean,
  ): HTMLElement {
    const card = el("div", "chord-card");
    const name = chordName(chordPitchClasses);
    const heading = el("h3", "", name.primary);
    if (name.alternatives.length > 0) {
      heading.appendChild(el("span", "muted", `  · also ${name.alternatives.join(", ")}`));
    }
    card.appendChild(heading);
    card.appendChild(
      el("div", "chord-notes", `${chordPitchClasses.map(noteName).join(" ")}  (${chordPitchClasses.length} notes)`),
    );

    if (voicings.length === 0) {
      card.appendChild(el("div", "chord-count", "no voicings within the chosen reach"));
      return card;
    }

    const grid = el("div", "diagrams");
    for (let i = 0; i < voicings.length; i++) {
      grid.appendChild(renderPianoVoicing(voicings[i].keys, noteName, i + 1));
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
    for (const timer of songTimers) clearTimeout(timer);
    songTimers = [];
    stopAudio();
  };

  // Riff transport. Rebuilt whenever the notation/settings change, so editing
  // stops playback (same as Song mode). The playhead is a DOM write on its own
  // rAF loop — the audio is placed on the context clock, never from rAF.
  let riffTransport: RiffTransport | null = null;
  let riffPlan: Riff | null = null;
  let riffTuning: number[] = TUNINGS[0].midi;
  let riffTimeline: HTMLElement | null = null;
  let riffReadingOpen: boolean | null = null;
  let riffFrame = 0;

  const stopRiff = () => {
    if (riffFrame) cancelAnimationFrame(riffFrame);
    riffFrame = 0;
    riffTransport?.stop();
    riffTransport = null;
    if (riffTimeline) setRiffPlayhead(riffTimeline, riffPlan?.loop.start ?? 0, riffPlan?.totalBeats ?? 1);
    riffPlay.textContent = "Play ▶";
  };

  const riffSpeed = (): number => Math.min(200, Math.max(25, parseInt(riffScale.value, 10) || 100)) / 100;

  /** Place one event on the audio clock with the notation's strum + release. */
  const playRiffEvent = (event: RiffEvent, when: number) => {
    playVoicing(event.frets, riffTuning, {
      when,
      strumMs: event.strumMs,
      releaseMs: riffPlan?.releaseMs ?? 0,
    });
  };

  // The loop window from the two inputs, clamped to the piece. ONE source of
  // truth: the drawn region and the transport's loop must be the same window,
  // or the app plays bars the timeline doesn't show.
  function riffLoop(riff: Riff): { start: number; end: number } {
    const start = Math.min(
      Math.max(0, riff.totalBeats - riff.beatsPerBar),
      Math.max(0, (parseInt(riffLoopStart.value, 10) || 1) - 1) * riff.beatsPerBar,
    );
    const end = Math.min(
      riff.totalBeats,
      Math.max(start + riff.beatsPerBar, (parseInt(riffLoopEnd.value, 10) || 1) * riff.beatsPerBar),
    );
    return { start, end };
  }

  function startRiff() {
    // Play what is on screen RIGHT NOW: re-plan from the textarea, so a click
    // can never play a stale plan (the notation used to be parsed only when
    // "Find" was pressed, so an edit was silently ignored) and an unparseable
    // box reports why instead of being a silent no-op.
    const riff = refreshRiff();
    if (!riff) return;
    // The transport reads `audioNow()`, so the context must exist AND be
    // running before it starts counting — otherwise currentTime sits at 0 and
    // every event lands in the past and fires at once.
    void primeAudio().then(() => {
      stopRiff();
      const transport = new RiffTransport(riff, secondsPerBeat(riff, riffSpeed()), {
        onEvent: (event, when) => playRiffEvent(event, when),
        now: audioNow,
      });
      transport.setLoop(riffLoop(riff).start, riffLoop(riff).end);
      transport.play();
      riffTransport = transport;
      riffPlay.textContent = "Stop ■";
      const follow = () => {
        if (riffTransport !== transport) return;
        const beat = transport.getBeat();
        if (beat === null) {
          stopRiff();
          return;
        }
        if (riffTimeline) setRiffPlayhead(riffTimeline, beat, riff.totalBeats);
        riffFrame = requestAnimationFrame(follow);
      };
      riffFrame = requestAnimationFrame(follow);
    });
  }

  modeSelect.addEventListener("change", () => {
    // Riff notation is tab, which is guitar-specific: force the instrument
    // rather than parsing six-string lanes into a piano plan.
    if (modeSelect.value === "riff" && instrumentSelect.value !== "guitar") {
      saveSpan(currentInstrument);
      instrumentSelect.value = "guitar";
      currentInstrument = "guitar";
      applyInstrumentVisibility();
    }
    run();
  });

  riffPlay.addEventListener("click", () => {
    if (riffTransport) stopRiff();
    else startRiff();
  });
  riffStop.addEventListener("click", () => {
    stopRiff();
    stopAudio();
  });
  for (const input of [riffScale, riffLoopStart, riffLoopEnd]) {
    input.addEventListener("change", () => {
      if (riffTransport) stopRiff();
      run();
    });
  }

  interface Params {
    pitchClasses: number[];
    span: number;
    cap: number;
    tuning: number[];
    fretCount: number;
    pianoLow: number;
    pianoHigh: number;
  }

  function readParams(): Params {
    const span = Math.min(24, Math.max(1, parseInt(spanInput.value, 10) || SPAN_DEFAULTS[instrumentSelect.value]));
    const cap = Math.max(1, parseInt(capInput.value, 10) || 500);
    const pitchClasses = [...selectedPitchClasses].sort((a, b) => a - b);
    if (instrumentSelect.value === "piano") {
      const pianoLow = Math.min(108, Math.max(21, parseInt(pianoLowInput.value, 10) || 48));
      const pianoHigh = Math.min(108, Math.max(21, parseInt(pianoHighInput.value, 10) || 84));
      if (pianoLow >= pianoHigh) throw new Error("Lowest key must be below the highest key.");
      return { pitchClasses, span, cap, tuning: TUNINGS[0].midi, fretCount: 15, pianoLow, pianoHigh };
    }
    return {
      pitchClasses,
      span,
      cap,
      tuning: getTuning(),
      fretCount: Math.min(24, Math.max(7, parseInt(fretsInput.value, 10) || 15)),
      pianoLow: 48,
      pianoHigh: 84,
    };
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;

  function runSong(params: Params) {
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

    const plan = instrumentSelect.value === "piano"
      ? planPianoSong(progression, params.pianoLow, params.pianoHigh, params.span, params.cap)
      : planGuitarSong(progression, params.tuning, params.fretCount, params.span, params.cap);
    if (!plan) {
      chordSummary.textContent = "(a chord has no voicing within the chosen span/reach)";
      return;
    }

    chordSummary.textContent =
      `· ${plan.chords.length} chord${plan.chords.length === 1 ? "" : "s"} · ` +
      `total move ${round1(plan.totalMove)}` +
      (plan.truncated ? " (per-chord candidates capped)" : "");

    songActions.replaceChildren();
    const playAll = el("button", "song-play", "Play arrangement ▶");
    playAll.title = "Strums every chord in sequence, one per chord-gap period";
    playAll.addEventListener("click", () => {
      cancelSong();
      if (plan.kind === "piano") {
        plan.chords.forEach((chord, index) => {
          songTimers.push(setTimeout(() => playNotes(chord.voicing.keys, true), index * gapMs));
        });
      } else {
        plan.chords.forEach((chord, index) => {
          songTimers.push(setTimeout(() => playVoicing(chord.fingering.frets, params.tuning), index * gapMs));
        });
      }
    });
    songActions.appendChild(playAll);

    const nameOf = noteName;
    plan.chords.forEach((chord, index) => {
      const card = el("div", "chord-card song-card");
      const heading = el("h3", "", planChordLabel(chord.chord));
      if (chord.chord.bass !== null) heading.appendChild(el("span", "muted", `  · ${noteName(chord.chord.bass)} bass`));
      card.appendChild(heading);

      const grid = el("div", "diagrams");
      const bits: string[] = [];
      if (isPianoChord(chord)) {
        grid.appendChild(renderPianoVoicing(chord.voicing.keys, nameOf, index + 1, { held: chord.held }));
        if (index > 0) {
          bits.push(`move ${round1(chord.move)}`);
          if (chord.held.length > 0) bits.push(`hold ${chord.held.map(midiName).join(" ")}`);
        }
      } else {
        const heldStrings = new Array<boolean>(params.tuning.length).fill(false);
        for (const stringIndex of chord.held) heldStrings[stringIndex] = true;
        grid.appendChild(renderChordDiagram(chord.fingering, params.tuning, nameOf, index + 1, { held: heldStrings }));
        if (index > 0) {
          bits.push(`move ${round1(chord.move)}`);
          if (chord.held.length > 0) {
            bits.push(`hold string${chord.held.length > 1 ? "s" : ""} ${chord.held.map((s) => s + 1).join(", ")}`);
          }
        }
      }
      card.appendChild(grid);

      if (chord.chord.bass !== null && !chord.bassMatches) {
        bits.push(index === 0 ? "lowest note misses the written bass" : "lowest note ≠ bass");
      }

      const moveLine = el("div", "song-move");
      moveLine.textContent = index === 0 ? `start here${bits.length ? ` · ${bits.join(" · ")}` : ""}` : bits.join(" · ");
      card.appendChild(moveLine);
      chordList.appendChild(card);
    });
  }

  function runRiff(params: Params) {
    chordsTitle.textContent = "Riff";
    // Own the list: `runRiff` is also called straight from the notation editor,
    // which doesn't go through `run()`.
    chordList.replaceChildren();

    let riff: Riff;
    try {
      riff = parseRiff(riffText.value, {
        tuning: params.tuning,
        maxFrets: params.fretCount,
        span: params.span,
        cap: params.cap,
        defaultStrumMs: DEFAULT_CONFIG.strum.guitarMs,
      });
    } catch (e) {
      chordSummary.textContent = "";
      setError(e instanceof Error ? e.message : String(e));
      riffGrid.replaceChildren();
      riffPlan = null;
      riffTimeline = null;
      return null;
    }

    riffPlan = riff;
    riffTuning = params.tuning;

    const bars = riff.totalBeats / riff.beatsPerBar;
    const notes = riff.events.reduce((sum, event) => sum + event.notes.length, 0);
    chordSummary.textContent =
      `· ${riff.bpm} bpm · ${bars} bar${bars === 1 ? "" : "s"} · ` +
      `${riff.events.length} event${riff.events.length === 1 ? "" : "s"} / ${notes} note${notes === 1 ? "" : "s"}` +
      (riff.strumMs > 0 ? ` · strum ${riff.strumMs} ms` : " · blocked") +
      (riff.releaseMs > 0 ? ` · release ${riff.releaseMs} ms` : "");

    for (const warning of riff.warnings) {
      const line = el("div", "riff-warning", warning);
      chordList.appendChild(line);
    }

    const loop = riffLoop(riff);
    const playEvents = (indices: number[]) => {
      for (const index of indices) {
        const event = riff.events[index];
        if (event) playVoicing(event.frets, params.tuning, { strumMs: event.strumMs, releaseMs: riff.releaseMs });
      }
    };
    const playEvent = (index: number) => playEvents([index]);

    // The ruler is the two layers' shared axis, so it is rebuilt with the plan:
    // `bar` and `step` both move the bar boundaries.
    riffGrid.replaceChildren(...renderRiffGrid(riff.beatsPerBar, riff.stepBeats, riff.totalBeats));

    // Keep the reader's own collapse choice across re-renders: it is rebuilt on
    // every keystroke, and a `<details>` that springs open each time is worse
    // than not having it.
    const reading = renderRiffReading(riff.events, {
      bpm: riff.bpm,
      beatsPerBar: riff.beatsPerBar,
      stepBeats: riff.stepBeats,
      totalBeats: riff.totalBeats,
      tuning: params.tuning,
      onPlayEvents: playEvents,
    }) as HTMLDetailsElement;
    if (riffReadingOpen !== null) reading.open = riffReadingOpen;
    reading.addEventListener("toggle", () => {
      riffReadingOpen = reading.open;
    });
    chordList.appendChild(reading);

    const box = renderRiffTimeline(riff.events, riff.beatsPerBar, riff.stepBeats, riff.totalBeats, {
      tuning: params.tuning,
      loop,
      onPlayEvent: playEvent,
    });
    riffTimeline = box;
    chordList.appendChild(box);
    chordList.appendChild(
      el("div", "muted riff-hint", "One column = " + stepName(riff.stepBeats) + ". Click any note group, or any row above, to hear just that event."),
    );
    return riff;
  }

  /**
   * Re-plan the riff from the notation box: stop playback, re-read the params,
   * re-render the timeline. Returns the plan, or `null` with the reason on
   * screen. Used by the notation editor and by Play, so both always act on
   * what the player is looking at.
   */
  function refreshRiff(): Riff | null {
    stopRiff();
    setError(null);
    let params: Params;
    try {
      params = readParams();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      riffPlan = null;
      chordList.replaceChildren();
      return null;
    }
    return runRiff(params);
  }

  // Typing in the notation re-plans it (debounced: a re-voice of the chord
  // stream per keystroke is wasted work, and error text that updates on every
  // character fights the typing). Editing stops playback, like every other
  // notation/settings change — otherwise the drawn timeline and the ringing
  // loop would silently disagree about what is playing.
  let riffEditTimer = 0;
  riffText.addEventListener("input", () => {
    if (riffEditTimer) clearTimeout(riffEditTimer);
    riffEditTimer = window.setTimeout(() => {
      riffEditTimer = 0;
      if (modeSelect.value === "riff") refreshRiff();
    }, RIFF_EDIT_MS);
  });

  function run() {
    setError(null);
    cancelSong();
    stopRiff();
    chordList.replaceChildren();
    chordSummary.textContent = "";
    songActions.replaceChildren();
    applyKeySize();

    const isPiano = instrumentSelect.value === "piano";
    const isSong = modeSelect.value === "song";
    const isRiff = modeSelect.value === "riff";
    notePicker.hidden = isSong || isRiff;
    songOnly.hidden = !isSong;
    riffOnly.hidden = !isRiff;
    posSection.hidden = isSong || isRiff;
    descChord.hidden = isSong || isRiff;
    descSong.hidden = !isSong;
    descRiff.hidden = !isRiff;
    capLabel.textContent = isSong ? "Max shapes / chord" : "Max results / chord";
    positionsTitle.textContent = isPiano ? "Keyboard positions" : "Fretboard positions";
    chordsTitle.textContent = isRiff ? "Riff" : isSong ? "Song arrangement" : isPiano ? "Chord voicings" : "Chord fingerings";

    let params: Params;
    try {
      params = readParams();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    if (isRiff) {
      runRiff(params);
      return;
    }
    if (isSong) {
      runSong(params);
      return;
    }

    const nameOf = noteName;
    legend.replaceChildren();
    renderLegend(params.pitchClasses);

    if (params.pitchClasses.length < 2) {
      chordSummary.textContent = "(need at least 2 notes for chords)";
      return;
    }

    if (isPiano) {
      posBoard.replaceChildren(renderPiano(params.pianoLow, params.pianoHigh, params.pitchClasses, nameOf));
      const { voicings, truncated } = findPianoVoicings(params.pitchClasses, params.pianoLow, params.pianoHigh, params.span, params.cap);
      chordList.appendChild(renderPianoCard(params.pitchClasses, voicings, truncated));
      chordSummary.textContent = `· ${voicings.length} voicing${voicings.length === 1 ? "" : "s"} for ${chordName(params.pitchClasses).primary}`;
      return;
    }

    posBoard.replaceChildren(renderPositions(params.tuning, params.pitchClasses, params.fretCount, nameOf));

    // Chord list: every provided note must be in the chord voicing.
    const { fingerings, truncated } = findFingerings(params.pitchClasses, params.tuning, params.fretCount, params.span, params.cap);
    chordList.appendChild(renderChordCard(params.pitchClasses, fingerings, truncated, params.tuning));
    chordSummary.textContent = `· ${fingerings.length} fingering${fingerings.length === 1 ? "" : "s"} for ${chordName(params.pitchClasses).primary}`;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSpan(instrumentSelect.value);
    run();
  });

  run();
});