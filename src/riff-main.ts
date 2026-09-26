import { playVoicing, preloadGuitarEngine, primeAudio, getGuitarKit, setGuitarKit, stopAudio, audioNow, type GuitarKitName } from "./audio.js";
import { chordShape } from "./fretboard.js";
import {
  chordName,
  midiName,
  noteName,
  parseStringMidi,
  TUNINGS,
} from "./theory.js";
import {
  rankGuitarVoicings,
  type VoicingPin,
} from "./song.js";
import { DEFAULT_CONFIG } from "./synth/config.js";
import { el, renderChordDiagram, renderRiffGrid, renderRiffReading, renderRiffTimeline, setRiffPlayhead } from "./render.js";
import { parseRiff, secondsPerBeat, stepName, type Riff, type RiffEvent } from "./riff.js";
import { RiffTransport } from "./transport.js";

/**
 * Riff builder: the riff trainer as its own page, off the note/chord finder.
 *
 * Two things live here that the notation box deliberately does NOT do:
 *
 *  - **Voicing search.** A chord name is pitch classes only, so the frets were
 *    always chosen by `planGuitarSong`. The picker below re-uses the same
 *    candidate set, ordered by movement from the previous chord, and lets you
 *    pin a shape. Pins are a list of `{name, shape}` index-aligned with the
 *    chord stream, and the name is re-checked on every parse, so editing the
 *    progression drops a pin that no longer refers to the chord under it instead
 *    of silently re-voicing a different chord.
 *
 *  - **Playback** on a lookahead transport, with a speed dial and a bar loop.
 */

/** Idle time before an edit to the notation is re-planned. */
const RIFF_EDIT_MS = 300;

const KIT_NAMES: Record<GuitarKitName, string> = {
  steel: "Steel-string acoustic",
  nylon: "Classical nylon",
};

if (DEFAULT_CONFIG.engine.mode === "smplr") preloadGuitarEngine();

const grid = document.getElementById("riff-grid") as HTMLDivElement;
const text = document.getElementById("riff-text") as HTMLTextAreaElement;
const errorLine = document.getElementById("riff-error") as HTMLParagraphElement;
const output = document.getElementById("riff-output") as HTMLDivElement;
const summaryLine = document.getElementById("riff-summary") as HTMLSpanElement;
const tabs = document.getElementById("voicing-tabs") as HTMLDivElement;
const picker = document.getElementById("voicing-picker") as HTMLDivElement;
const voicingSummary = document.getElementById("voicing-summary") as HTMLSpanElement;

const tuningSelect = document.getElementById("tuning") as HTMLSelectElement;
const fretsInput = document.getElementById("frets") as HTMLInputElement;
const spanInput = document.getElementById("span") as HTMLInputElement;
const capInput = document.getElementById("cap") as HTMLInputElement;
const strumInput = document.getElementById("strum") as HTMLInputElement;
const kitButton = document.getElementById("kit") as HTMLButtonElement;
const customTuning = document.getElementById("custom-tuning") as HTMLDetailsElement;
const customStrings = Array.from(customTuning.querySelectorAll("input")) as HTMLInputElement[];

const scaleInput = document.getElementById("riff-scale") as HTMLInputElement;
const loopStartInput = document.getElementById("riff-loop-start") as HTMLInputElement;
const loopEndInput = document.getElementById("riff-loop-end") as HTMLInputElement;
const playButton = document.getElementById("riff-play") as HTMLButtonElement;
const stopButton = document.getElementById("riff-stop") as HTMLButtonElement;

for (const tuning of TUNINGS) {
  const option = document.createElement("option");
  option.value = tuning.id;
  option.textContent = tuning.label;
  tuningSelect.appendChild(option);
}
tuningSelect.addEventListener("change", () => {
  customTuning.hidden = tuningSelect.value !== "custom";
});

// The kit label is set after `preloadGuitarEngine` above, which may already have
// restored a stored choice, so it must be read rather than assumed.
let guitarKit = getGuitarKit();
if (kitButton) {
  const other: GuitarKitName = guitarKit === "steel" ? "nylon" : "steel";
  kitButton.textContent = KIT_NAMES[guitarKit];
  kitButton.title = `Sampled guitar kit: ${KIT_NAMES[guitarKit].toLowerCase()}. Click to switch to ${KIT_NAMES[other].toLowerCase()}.`;
  kitButton.addEventListener("click", () => {
    const next: GuitarKitName = guitarKit === "steel" ? "nylon" : "steel";
    setGuitarKit(next);
    guitarKit = next;
    kitButton.textContent = KIT_NAMES[guitarKit];
    kitButton.title = `Sampled guitar kit: ${KIT_NAMES[guitarKit].toLowerCase()}. Click to switch to ${KIT_NAMES[other].toLowerCase()}.`;
  });
}

function readTuning(): number[] {
  if (tuningSelect.value === "custom") return customStrings.map((input, i) => parseStringMidi(input.value, i));
  return TUNINGS.find((x) => x.id === tuningSelect.value)!.midi;
}

function readInt(input: HTMLInputElement, fallback: number): number {
  const value = parseInt(input.value, 10);
  return Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------- state ----

/** Pinned shapes, index-aligned with the chord stream. `null` = let the search decide. */
let pins: (VoicingPin | null)[] = [];
/** Which chord of the stream the picker is showing. */
let focusIndex = 0;
let plan: Riff | null = null;
let timelineEl: HTMLElement | null = null;
let readingOpen: boolean | null = null;
let transport: RiffTransport | null = null;
let frame = 0;
let editTimer = 0;

const stop = () => {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  transport?.stop();
  transport = null;
  if (timelineEl && plan) setRiffPlayhead(timelineEl, plan.loop.start, plan.totalBeats);
  playButton.textContent = "Play ▶";
};

const speed = (): number => Math.min(200, Math.max(25, readInt(scaleInput, 100))) / 100;

function loopWindow(riff: Riff): { start: number; end: number } {
  const start = Math.min(
    Math.max(0, riff.totalBeats - riff.beatsPerBar),
    Math.max(0, (readInt(loopStartInput, 1) - 1) * riff.beatsPerBar),
  );
  return {
    start,
    end: Math.max(
      start + riff.beatsPerBar,
      readInt(loopEndInput, 1) * riff.beatsPerBar,
    ),
  };
}

function playEvent(event: RiffEvent, when: number) {
  playVoicing(event.frets, readTuning(), {
    when,
    strumMs: event.strumMs,
    releaseMs: plan?.releaseMs ?? 0,
  });
}

/**
 * Re-parse, re-render, and (re)start. Everything that can change the plan calls
 * this, so a click can never play a stale plan — the same contract the notation
 * editor has on the main page.
 */
function start() {
  stop();
  // Unlock the context inside the click gesture: the first scheduled event can
  // land before an un-primed context is running, which costs the downbeat.
  void primeAudio();
  const riff = refresh();
  if (!riff) return;
  loopStartInput.max = String(Math.max(1, Math.ceil(riff.totalBeats / riff.beatsPerBar)));
  loopEndInput.max = loopStartInput.max;
  const next = new RiffTransport(riff, secondsPerBeat(riff, speed()), {
    onEvent: (event, when) => playEvent(event, when),
    now: audioNow,
  });
  next.setLoop(loopWindow(riff).start, loopWindow(riff).end);
  next.play();
  transport = next;
  playButton.textContent = "Stop ■";
  const follow = () => {
    if (transport !== next) return;
    const beat = next.getBeat();
    if (beat === null) {
      stop();
      return;
    }
    if (timelineEl) setRiffPlayhead(timelineEl, beat, riff.totalBeats);
    frame = requestAnimationFrame(follow);
  };
  frame = requestAnimationFrame(follow);
}

playButton.addEventListener("click", () => (transport ? stop() : start()));
stopButton.addEventListener("click", stop);
window.addEventListener("beforeunload", stopAudio);

// --------------------------------------------------------------- voicing ----

/**
 * The chord stream as the picker sees it: one entry per chord event, with the
 * shape currently in force (pinned or chosen) and the rank of that shape in the
 * ordered candidate list.
 */
/** One entry of `rankGuitarVoicings` — see there for what the numbers mean. */
type RankedVoicing = ReturnType<typeof rankGuitarVoicings>[number];

interface VoicingView {
  event: RiffEvent;
  index: number;
  shape: string;
  list: RankedVoicing[];
  rank: number;
  pinned: boolean;
}

function voicingViews(): VoicingView[] {
  if (!plan) return [];
  const tuning = readTuning();
  const chords = plan.events.filter((event) => event.kind === "chord");
  const views: VoicingView[] = [];
  for (const event of chords) {
    if (!event.chord) continue;
    // Rank from the shape the PREVIOUS chord is actually using, so a pin
    // upstream reorders this chord's options the moment it is stepped.
    const previous = views.length > 0 ? views[views.length - 1] : null;
    const list = rankGuitarVoicings(
      event.chord.pitchClasses,
      tuning,
      readInt(fretsInput, 15),
      readInt(spanInput, 5),
      previous ? previous.list[previous.rank].frets : null,
      readInt(capInput, 400),
    );
    const shape = chordShape(event.frets);
    const rank = list.findIndex((entry) => entry.shape === shape);
    views.push({
      event,
      index: views.length,
      shape,
      list,
      rank: rank < 0 ? 0 : rank,
      pinned: event.pinned === true,
    });
  }
  return views;
}

function renderVoicingPicker() {
  const views = voicingViews();
  if (views.length === 0) {
    tabs.replaceChildren();
    picker.replaceChildren(el("p", "muted", "No chords in the stream — everything here is tab, so the frets are already yours."));
    voicingSummary.textContent = "";
    return;
  }
  focusIndex = Math.min(Math.max(0, focusIndex), views.length - 1);

  voicingSummary.textContent =
    `· ${views.length} chord${views.length === 1 ? "" : "s"}` +
    ` · ${views.filter((v) => v.pinned).length} pinned`;

  tabs.replaceChildren(
    ...views.map((view) => {
      const button = el("button", "voicing-tab", view.event.label) as HTMLButtonElement;
      button.type = "button";
      if (view.index === focusIndex) button.classList.add("is-active");
      if (view.pinned) button.classList.add("is-pinned");
      button.title = view.pinned
        ? `${view.event.label} is pinned to ${view.shape} — click to browse it`
        : `${view.event.label} is voiced by the search (${view.shape}) — click to browse it`;
      button.addEventListener("click", () => {
        focusIndex = view.index;
        render();
      });
      return button;
    }),
  );

  const view = views[focusIndex];
  const current = view.list[view.rank] ?? { frets: view.event.frets, shape: view.shape, cost: 0 };
  const previous = focusIndex > 0 ? views[focusIndex - 1] : null;
  const notes = view.event.notes
    .map((note) => midiName(readTuning()[note.stringIndex] + note.fret))
    .join(" ");

  const step = (delta: number) => {
    const next = Math.min(view.list.length - 1, Math.max(0, view.rank + delta));
    if (next === view.rank) return;
    pins[view.index] = { name: view.event.label, shape: view.list[next].shape };
    focusIndex = view.index;
    render();
  };

  const prevButton = el("button", "voicing-step", "◀") as HTMLButtonElement;
  prevButton.type = "button";
  prevButton.disabled = view.rank === 0;
  prevButton.title = "Previous voicing (smoother hand movement)";
  prevButton.addEventListener("click", () => step(-1));

  const nextButton = el("button", "voicing-step", "▶") as HTMLButtonElement;
  nextButton.type = "button";
  nextButton.disabled = view.rank === view.list.length - 1;
  nextButton.title = "Next voicing (smoother hand movement)";
  nextButton.addEventListener("click", () => step(1));

  // Stepping alone is not enough. The list is ordered "best first", so a shape
  // the search only reached because it charges nothing for a muted string can
  // sit hundreds of ranks down, and ◀ ▶ from there walk further into the same
  // thin tail. This is the way back to the top of the list in one click.
  const bestButton = el("button", "voicing-best", "best ▲") as HTMLButtonElement;
  bestButton.type = "button";
  bestButton.disabled = view.rank === 0;
  bestButton.title = "Jump to the top of the list: the smoothest, fullest option";
  bestButton.addEventListener("click", () => {
    pins[view.index] = { name: view.event.label, shape: view.list[0].shape };
    focusIndex = view.index;
    render();
  });

  const autoButton = el("button", "voicing-auto", view.pinned ? "Auto (unpin)" : "Auto") as HTMLButtonElement;
  autoButton.type = "button";
  autoButton.disabled = !view.pinned;
  autoButton.title = "Hand this chord back to the voicing search";
  autoButton.addEventListener("click", () => {
    pins[view.index] = null;
    focusIndex = view.index;
    render();
  });

  const playButtonOne = el("button", "voicing-play", "▶ Hear it") as HTMLButtonElement;
  playButtonOne.type = "button";
  playButtonOne.addEventListener("click", () => {
    playVoicing(current.frets, readTuning(), { strumMs: view.event.strumMs, releaseMs: plan?.releaseMs ?? 0 });
  });

  const head = el(
    "div",
    "voicing-head",
    `${view.rank + 1} of ${view.list.length} searched` +
      (previous ? ` · moves ${current.cost} from ${previous.event.label}` : " · first chord") +
      ` · ${current.sounded} string${current.sounded === 1 ? "" : "s"}`,
  );

  // The search can pick a shape that sits far down a list ordered the way a
  // guitarist would choose ("350 of 400" is a real, common result, because the
  // search charges nothing for a muted string). Saying so is the whole point of
  // the builder: the number is not a glitch to be tidied away, it is the search
  // preferring a thinner chord than the browse list leads with.
  const deeper = view.list
    .slice(0, view.rank)
    .filter((entry) => entry.sounded > current.sounded).length;
  const hint = deeper > 0
    ? `The search picked a ${current.sounded}-string shape; ${deeper} fuller voicing${deeper === 1 ? "" : "s"} rank above it. "best ▲" jumps straight there, then ◀ ▶ walks the list.`
    : view.pinned
      ? "Pinned: this is the exact shape that plays, and the chords after it were re-chosen around it."
      : "Auto: the search picked this, and it is already the fullest smooth option from the previous chord.";

  const controls = el("div", "voicing-controls");
  controls.append(prevButton, nextButton, bestButton, autoButton, playButtonOne);

  picker.replaceChildren(
    head,
    el("div", "voicing-shape", current.shape),
    el("div", "voicing-notes", `${chordName(view.event.chord!.pitchClasses).primary} · ${notes}`),
    controls,
    renderChordDiagram({ frets: current.frets }, readTuning(), noteName, focusIndex + 1),
    el("p", "muted riff-hint", hint),
  );
}

// ---------------------------------------------------------------- render ----

function setError(message: string | null) {
  errorLine.textContent = message ?? "";
  errorLine.hidden = message === null;
}

function refresh(): Riff | null {
  let riff: Riff;
  const tuning = readTuning();
  try {
    riff = parseRiff(text.value, {
      tuning,
      maxFrets: readInt(fretsInput, 15),
      span: readInt(spanInput, 5),
      cap: readInt(capInput, 400),
      defaultStrumMs: DEFAULT_CONFIG.strum.guitarMs,
      pins: pins.filter((pin): pin is VoicingPin => pin !== null),
    });
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    summaryLine.textContent = "";
    grid.replaceChildren();
    plan = null;
    timelineEl = null;
    output.replaceChildren();
    tabs.replaceChildren();
    picker.replaceChildren();
    return null;
  }
  setError(null);
  plan = riff;

  const bars = riff.totalBeats / riff.beatsPerBar;
  const noteCount = riff.events.reduce((sum, event) => sum + event.notes.length, 0);
  summaryLine.textContent =
    `· ${riff.bpm} bpm · ${bars} bar${bars === 1 ? "" : "s"} · ` +
    `${riff.events.length} event${riff.events.length === 1 ? "" : "s"} / ${noteCount} note${noteCount === 1 ? "" : "s"}` +
    (riff.strumMs > 0 ? ` · strum ${riff.strumMs} ms` : " · blocked") +
    (riff.releaseMs > 0 ? ` · release ${riff.releaseMs} ms` : "");

  const tuningNow = readTuning();
  const loop = loopWindow(riff);
  const playEvents = (indices: number[]) => {
    for (const index of indices) {
      const event = riff.events[index];
      if (event) playVoicing(event.frets, tuningNow, { strumMs: event.strumMs, releaseMs: riff.releaseMs });
    }
  };

  // The ruler is the two layers' shared axis, so it is rebuilt with the plan:
  // `bar` and `step` both move the bar boundaries.
  grid.replaceChildren(...renderRiffGrid(riff.beatsPerBar, riff.stepBeats, riff.totalBeats));

  output.replaceChildren();
  for (const warning of riff.warnings) output.appendChild(el("div", "riff-warning", warning));

  // Keep the reader's own collapse choice across re-renders: it is rebuilt on
  // every keystroke, and a `<details>` that springs open each time is worse
  // than not having it.
  const reading = renderRiffReading(riff.events, {
    bpm: riff.bpm,
    beatsPerBar: riff.beatsPerBar,
    stepBeats: riff.stepBeats,
    totalBeats: riff.totalBeats,
    tuning: tuningNow,
    onPlayEvents: playEvents,
  }) as HTMLDetailsElement;
  if (readingOpen !== null) reading.open = readingOpen;
  reading.addEventListener("toggle", () => {
    readingOpen = reading.open;
  });
  output.appendChild(reading);

  const box = renderRiffTimeline(riff.events, riff.beatsPerBar, riff.stepBeats, riff.totalBeats, {
    tuning: tuningNow,
    loop,
    onPlayEvent: (index) => playEvents([index]),
  });
  timelineEl = box;
  output.appendChild(box);
  output.appendChild(
    el("div", "muted riff-hint", `One column = ${stepName(riff.stepBeats)}. Click any note group, or any row above, to hear just that event.`),
  );
  renderVoicingPicker();
  return riff;
}

/** Repaint everything from the current plan + pins. */
function render() {
  if (refresh()) return;
}

text.addEventListener("input", () => {
  stop();
  // Re-voicing the whole chord stream per keystroke is wasted work, and error
  // text that updates per character fights the typing.
  window.clearTimeout(editTimer);
  editTimer = window.setTimeout(() => refresh(), RIFF_EDIT_MS);
});

for (const input of [tuningSelect, fretsInput, spanInput, capInput, strumInput, ...customStrings]) {
  input.addEventListener("input", () => {
    strumInput.value = String(DEFAULT_CONFIG.strum.guitarMs);
    stop();
    refresh();
  });
}
strumInput.addEventListener("input", () => {
  DEFAULT_CONFIG.strum.guitarMs = Math.max(0, readInt(strumInput, 140));
  stop();
  refresh();
});

for (const input of [scaleInput, loopStartInput, loopEndInput]) {
  input.addEventListener("input", () => {
    if (transport) stop();
    if (plan) {
      const loop = loopWindow(plan);
      transport?.setLoop(loop.start, loop.end);
    }
  });
}

refresh();
