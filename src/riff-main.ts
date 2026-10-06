import { playVoicing, preloadGuitarEngine, primeAudio, getGuitarKit, setGuitarKit, stopAudio, audioNow, playClick, type GuitarKitName } from "./audio.js";
import { chordShape } from "./fretboard.js";
import {
  chordName,
  midiName,
  noteName,
  parseChord,
  parseStringMidi,
  TUNINGS,
} from "./theory.js";
import {
  rankGuitarVoicings,
  type VoicingPin,
} from "./song.js";
import { DEFAULT_CONFIG } from "./synth/config.js";
import { el, renderChordDiagram, renderRiffGrid, renderRiffReading, setRiffPlayhead } from "./render.js";
import { parseRiff, secondsPerBeat, type Riff, type RiffEvent } from "./riff.js";
import { RiffTransport } from "./transport.js";
import { buildOverlay } from "./tab-overlay.js";
import { renderTrack, setTrackPlayhead, type DragPayload } from "./track.js";
import { LEAD_IN_BEATS } from "./timeline.js";
import { makeDraggable } from "./dnd.js";
import {
  CHORD_REST,
  addChordToken,
  chordTokensFromText,
  clearLaneNote,
  insertOrReplacePin,
  moveChordToken,
  moveLaneNote,
  movePins,
  replaceChordLine,
  setLaneNote,
  tokenIndexForChordOrdinal,
} from "./track-edit.js";

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
const trackEl = document.getElementById("track") as HTMLDivElement;
const chordChips = document.getElementById("chord-chips") as HTMLDivElement;
const chordAddInput = document.getElementById("chord-add") as HTMLInputElement;

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
const metronomeInput = document.getElementById("riff-metronome") as HTMLInputElement;
const countInInput = document.getElementById("riff-countin") as HTMLInputElement;
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

// ------------------------------------------------------------ undo ----

/**
 * Snapshots of the notation taken before every PROGRAMMATIC rewrite (a drag
 * drop, a builder-chip add, a note drag, a progression-input apply —
 * they all funnel through the two `source = ...` sites). Native textarea
 * undo is useless here because setting `.value` from script clears its stack,
 * so the app keeps its own. User typing into the box is left to the native
 * undo; this stack is for edits the user made by clicking/dragging.
 */
const undoStack: string[] = [];
const UNDO_CAP = 50;
const undoButton = document.getElementById("riff-undo") as HTMLButtonElement;

function updateUndoButton(): void {
  undoButton.disabled = undoStack.length === 0;
}

/** Record the current notation before overwriting it. No-op if unchanged. */
function pushUndo(): void {
  if (undoStack[undoStack.length - 1] === source) return;
  undoStack.push(source);
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  updateUndoButton();
}

undoButton.addEventListener("click", () => {
  const previous = undoStack.pop();
  if (previous === undefined) return;
  source = previous;
  notesViewDirty = false;
  updateUndoButton();
  stop();
  refresh();
});

// --------------------------------------------------------- tab lanes ----

/** Tuning index → lane label. Index 5 = high e, index 0 = low E. */
const LABEL_FOR_STRING = ["E", "A", "D", "G", "B", "e"];

/**
 * Generate the tab lane text for one string from the grid. Each cell is one
 * character column; a dash is a rest, a fret number is a note (and a two-digit
 * fret occupies two columns, per the parser's rules).
 */
function tabLaneText(cells: (number | null)[]): string {
  let text = "";
  for (let i = 0; i < cells.length; i++) {
    const fret = cells[i];
    if (fret === null) {
      text += "-";
    } else {
      text += String(fret);
      if (fret >= 10) i++; // two-digit fret eats the next column
    }
  }
  return text;
}

/**
 * Replace the tab lanes in the notation with the grid's current content.
 * Directives, the chord line, and comments are preserved. The tab lane lines
 * are the ones matching `LANE_LINE` (string letter + pipe + body + pipe).
 */
function updateTabLanes(lanes: Map<number, (number | "x" | null)[]>): void {
  const riff = plan;
  if (!riff) return;

  const laneLines: string[] = [];
  let width = 0;
  for (const cells of lanes.values()) width = Math.max(width, cells.length);
  for (let s = 5; s >= 0; s--) {
    const cells = lanes.get(s);
    // Always print every string, even an unused one (a run of dashes) — a
    // complete lane set keeps the notation readable and the editors' widths
    // aligned. `width` is the widest overlay row; a missing row is all rests.
    const row: (number | null)[] = [];
    for (let i = 0; i < width; i++) {
      const cell = cells?.[i];
      row.push(typeof cell === "number" ? cell : null);
    }
    laneLines.push(`${LABEL_FOR_STRING[s]}|${tabLaneText(row)}|`);
  }
  if (width === 0) return; // nothing tab-side to write (chord-only riff)

  const lines = source.split("\n");
  const newLines: string[] = [];
  for (const line of lines) {
    if (/^\s*[eBGDAE]\s*\|/.test(line)) continue; // drop old tab lanes
    newLines.push(line);
  }
  // Insert tab lanes after the last non-empty, non-directive line.
  let insertAt = 0;
  for (let i = 0; i < newLines.length; i++) {
    const t = newLines[i].trim();
    if (t && !t.startsWith("#") && !/^(tempo|bpm|bar|step|grid|strum|release)\s+/i.test(t)) {
      insertAt = i + 1;
    }
  }
  newLines.splice(insertAt, 0, ...laneLines);
  const next = newLines.join("\n");
  if (next === source) return;
  pushUndo();
  source = next;
  stop();
  refresh();
}

/**
 * Append four empty bars: rest tokens in the chord line, dash columns on every lane.
 */
function addFourBars(): void {
  const riff = plan;
  if (!riff) return;
  const cols = Math.max(1, Math.round((riff.beatsPerBar * 4) / riff.stepBeats));
  const { chordLine, rest } = splitChordLine(source);
  const nextChordLine = chordLine === null ? null : `${chordLine} - - - -`;
  const nextRest = lanesOf(rest).length
    ? rest.replace(/^(\s*[eBGDAE]\s*\|)([^|]*)\|/gm, (_m, head: string, body: string) => `${head}${body}${"-".repeat(cols)}|`)
    : rest;
  const next = nextChordLine === null ? nextRest : withChordLine(nextRest, nextChordLine);
  if (next === source) return;
  pushUndo();
  source = next;
  notesViewDirty = false;
  stop();
  refresh();
}

/** Tab lane lines in a notation text. */
function lanesOf(value: string): string[] {
  return value.match(/^\s*[eBGDAE]\s*\|[^|]*\|/gm) ?? [];
}

function clearTrack(): void {
  const riff = plan;
  if (!riff) return;
  const { chordLine, rest } = splitChordLine(source);
  // Keep the bar grid: every chord becomes a rest bar and every lane cell a
  // rest — same shape of track, nothing on it.
  const tokens = chordTokensFromText(source);
  const nextChordLine =
    chordLine === null ? null : formatChordLine(tokens.map(() => CHORD_REST), riff.beatsPerBar, riff.stepBeats);
  const nextRest = lanesOf(rest).length
    ? rest.replace(/^(\s*[eBGDAE]\s*\|)([^|]*)\|/gm, (_m, head: string, body: string) => `${head}${"-".repeat(body.length)}|`)
    : rest;
  const next = nextChordLine === null ? nextRest : withChordLine(nextRest, nextChordLine);
  if (next === source) return;
  pushUndo();
  source = next;
  notesViewDirty = false;
  // The pins were aligned to chord events that no longer exist.
  pins = [];
  preview.clear();
  stop();
  // The chord line is stripped from the visible box (the box mirrors the tab
  // lanes); do the same after clearing so nothing stale stays in front.
  text.value = splitChordLine(source).rest;
  refresh();
}

document.getElementById("riff-add-bars")?.addEventListener("click", addFourBars);
document.getElementById("riff-clear")?.addEventListener("click", clearTrack);

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
/** Browsed-but-not-yet-committed shapes, keyed by the view index. */
const preview = new Map<number | string, string>();
/** Which chord of the stream the picker is showing. */
let focusIndex = 0;
let plan: Riff | null = null;
/** The bar count from the last successful parse — a change means a new piece,
 *  so the loop window resets to the whole riff (see refresh). */
let lastBarsTotal = 0;
let timelineEl: HTMLElement | null = null;
let readingOpen: boolean | null = null;
let transport: RiffTransport | null = null;
let frame = 0;
let editTimer = 0;

/**
 * The full notation (chord line included) is the source of truth. The
 * textarea in the Notes tab is a VIEW of it minus the chord line — chords
 * are built in the Chords tab, whose progression input is the live view of
 * that line. Edits in the Notes box are spliced back around the preserved
 * chord line; the box is only rewritten when the change did NOT come from
 * the box itself (else typing loses its cursor).
 */
let source = text.value;
let notesViewDirty = false;

/** A chord typed into "+ chord" but not yet on the track. Its voicings are
 * previewed in the picker, and the drop of its chip carries the previewed
 * shape so the new chord is pinned to it from the first bar. */
let pending: { key: string; name: string } | null = null;
let focusPending = false;
/** The shape being BROWSED for a pending chord. Stepping only previews —
 *  `preview` (the shape the chip drop carries) updates on "Use for the
 *  drop", not per arrow click. */
let pendingBrowse: string | null = null;

/** Split the source into the chord line and everything else, in order. */
function splitChordLine(value: string): { chordLine: string | null; rest: string } {
  const lines = value.split("\n");
  const isDirective = (t: string) => /^(tempo|bpm|bar|step|grid|strum|release)\s+/i.test(t);
  const index = lines.findIndex((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) return false;
    if (/^\s*[eBGDAE]\s*\|/.test(line)) return false;
    return !isDirective(t);
  });
  if (index < 0) return { chordLine: null, rest: value };
  return { chordLine: lines[index], rest: [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n") };
}

/** Re-insert a chord line just before the first tab lane (or after the directives). */
function withChordLine(notesText: string, chordLine: string): string {
  const lines = notesText.split("\n");
  const laneAt = lines.findIndex((line) => /^\s*[eBGDAE]\s*\|/.test(line));
  if (laneAt >= 0) {
    lines.splice(laneAt, 0, chordLine);
  } else {
    let insertAt = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^(tempo|bpm|bar|step|grid|strum|release)\s+/i.test(t) || !t || t.startsWith("#") || t.startsWith("//")) insertAt = i + 1;
    }
    lines.splice(insertAt, 0, chordLine);
  }
  return lines.join("\n");
}


const stop = () => {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  transport?.stop();
  transport = null;
  if (timelineEl && plan) setRiffPlayhead(timelineEl, plan.loop.start, plan.totalBeats);
  const track = trackEl.firstElementChild as HTMLElement | null;
  // Rest the playhead one lead-in beat before the loop: where playback starts.
  if (track && plan) setTrackPlayhead(track, plan.loop.start - LEAD_IN_BEATS, plan.totalBeats, LEAD_IN_BEATS);
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

// ---------------------------------------------------------- progression ----

/**
 * Build the chord line for the notation, with each chord token landing on its
 * bar's mark on the ruler. The mark for bar `i` is at character
 * `LANE_PREFIX + i * perBar`, where `perBar` is the number of tab columns per
 * bar. The padding is what makes `C` and the tab's first note line up on the
 * same beat — without it the chord stream and the tab lanes drift apart.
 */
function formatChordLine(chords: string[], beatsPerBar: number, stepBeats: number): string {
  const perBar = beatsPerBar / stepBeats;
  let line = "";
  for (let i = 0; i < chords.length; i++) {
    // LANE_PREFIX is 2 (the `e|` before the first tab column).
    const pos = 2 + i * perBar;
    while (line.length < pos) line += " ";
    line += chords[i];
  }
  return line;
}

/**
 * Replace the chord line in the notation with the progression from the input
 * (or INSERT one after the directives when the riff has none — a tab-only
 * riff gaining its first chord via a builder chip). Tab lanes, directives,
 * and comments are preserved; the surgery itself is `replaceChordLine`.
 */
function applyProgression(chords: string[]): void {
  if (chords.length === 0) return;

  const riff: Riff | null = plan;
  if (!riff) return;

  const chordLine = formatChordLine(chords, riff.beatsPerBar, riff.stepBeats);
  const next = replaceChordLine(source, chordLine);
  if (next === source) return;
  pushUndo();
  source = next;
  stop();
  refresh();
}

// ------------------------------------------------------------ builders ----

/** Chord chips the user added by name, on top of the progression's own.
 * Each entry is its own to-add chip — the same name can be added several
 * times, once for several voicings. */
const addedChords: { key: string; name: string }[] = [];
let addedSeq = 0;

/**
 * The draggable building blocks under the track: chord chips (the
 * progression's chords, deduped, plus each addition by name). Dragging one
 * onto the track adds an event; the track's drop zones do the geometry.
 * (Note adding/editing happens by clicking a string lane on the track.)
 */
function renderBuilders(): void {
  const streamTokens = [...new Set(chordTokensFromText(source).filter((token) => token !== CHORD_REST))];
  chordChips.replaceChildren(
    ...streamTokens.map((name) => {
      const chip = el("button", "builder-chip builder-chord", name) as HTMLButtonElement;
      chip.type = "button";
      chip.title = `Drag ${name} onto a bar in the track`;
      makeDraggable<DragPayload>(chip, { kind: "new-chord", name, shape: null });
      return chip;
    }),
    ...addedChords.map((entry) => {
      const chip = el("button", "builder-chip builder-chord is-pending", `${entry.name} · to add`) as HTMLButtonElement;
      chip.type = "button";
      chip.title = `Drag ${entry.name} onto a bar in the track (drags with the voicing you previewed for it)`;
      makeDraggable<DragPayload>(chip, {
        kind: "new-chord",
        name: entry.name,
        shape: preview.get(entry.key) ?? null,
        key: entry.key,
      });
      return chip;
    }),
  );
}

chordAddInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const name = chordAddInput.value.trim();
  if (!name) return;
  try {
    const chord = parseChord(name);
    const entry = { key: `added:${addedSeq++}`, name: chord.name };
    addedChords.push(entry);
    // Do NOT add it to the track yet — just flag it as pending so its
    // voicings can be previewed below. The chip for it is dragged onto a
    // bar later; the pending preview shape rides with it.
    pending = entry;
    pendingBrowse = null;
    focusPending = true;
    chordAddInput.value = "";
    chordAddInput.classList.remove("is-invalid");
    render();
  } catch {
    chordAddInput.classList.add("is-invalid");
    chordAddInput.title = `"${name}" is not a chord the app understands`;
  }
});

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

  const next = new RiffTransport(riff, secondsPerBeat(riff, speed()), {
    onEvent: (event, when) => playEvent(event, when),
    onClick: (_beat, when, isDownbeat) => playClick(when, isDownbeat),
    now: audioNow,
  }, undefined, {
    metronome: metronomeInput.checked,
    countInBars: Math.min(8, Math.max(0, readInt(countInInput, 0))),
    leadInBeats: LEAD_IN_BEATS,
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
    const track = trackEl.firstElementChild as HTMLElement | null;
    if (track) setTrackPlayhead(track, beat, riff.totalBeats, LEAD_IN_BEATS);
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

  // The same chord NAME can sit on several bars, and each bar can be
  // pinned to a DIFFERENT voicing — so the tab says which bar it is,
  // and only when that name appears more than once (otherwise they
  // are distinguished just by name).
  const counts = new Map<string, number>();
  for (const v of views) counts.set(v.event.label, (counts.get(v.event.label) ?? 0) + 1);

  const tabButtons = views.map((view) => {
      const duplicate = (counts.get(view.event.label) ?? 0) > 1;
      const bar = duplicate ? Math.floor(view.event.beat / (plan?.beatsPerBar ?? 4)) + 1 : 0;
      const label = duplicate ? `${view.event.label} · bar ${bar}` : view.event.label;
      const button = el("button", "voicing-tab", label) as HTMLButtonElement;
      button.type = "button";
      if (view.index === focusIndex) button.classList.add("is-active");
      if (view.pinned) button.classList.add("is-pinned");
      button.title = view.pinned
        ? `${view.event.label}${duplicate ? ` (bar ${bar})` : ""} is pinned to ${view.shape} — click to browse it`
        : `${view.event.label}${duplicate ? ` (bar ${bar})` : ""} is voiced by the search (${view.shape}) — click to browse it`;
      button.addEventListener("click", () => {
        focusIndex = view.index;
        focusPending = false;
        render();
      });
      return button;
    });

  for (const entry of addedChords) {
    const pill = el("button", "voicing-tab is-pending", `${entry.name} · to add`) as HTMLButtonElement;
    pill.type = "button";
    if (focusPending && pending?.key === entry.key) pill.classList.add("is-active");
    pill.title = "This chord is waiting: browse its voicings, hear it, then drag its chip onto a bar to place it.";
    pill.addEventListener("click", () => {
      pending = entry;
      focusPending = true;
      render();
    });
    tabButtons.push(pill);
  }

  tabs.replaceChildren(...tabButtons);

  if (pending && focusPending) {
    const parsed = parseChord(pending.name);
    const previous = views.length > 0 ? views[views.length - 1] : null;
    const prevFrets = previous
      ? previous.list[previous.rank]?.frets ?? previous.event.frets
      : null;
    const list = rankGuitarVoicings(
      parsed.pitchClasses,
      readTuning(),
      readInt(fretsInput, 15),
      readInt(spanInput, 5),
      prevFrets,
      readInt(capInput, 400),
    );
    const committed = preview.get(pending.key);
    const chosenShape = pendingBrowse ?? committed ?? list[0]?.shape ?? "";
    const current = list.find((entry) => entry.shape === chosenShape) ?? list[0];

    const rank = current ? list.findIndex((e) => e.shape === current.shape) : 0;
    const step = (delta: number) => {
      const next = Math.min(list.length - 1, Math.max(0, rank + delta));
      pendingBrowse = list[next].shape;
      render();
    };
    const prevButton = el("button", "voicing-step", "◀") as HTMLButtonElement;
    prevButton.type = "button";
    prevButton.disabled = rank === 0;
    prevButton.addEventListener("click", () => step(-1));
    const nextButton = el("button", "voicing-step", "▶") as HTMLButtonElement;
    nextButton.type = "button";
    nextButton.disabled = rank >= list.length - 1;
    nextButton.addEventListener("click", () => step(1));

    const hear = el("button", "voicing-play", "▶ Hear it") as HTMLButtonElement;
    hear.type = "button";
    hear.addEventListener("click", () => {
      if (current)
        playVoicing(current.frets, readTuning(), {
          strumMs: list[0] && plan ? plan.strumMs : 55,
          releaseMs: plan?.releaseMs ?? 0,
        });
    });

    const useButton = el(
      "button",
      "voicing-use",
      pendingBrowse !== null && pendingBrowse !== committed ? `Use this (${current.shape})` : "Use for the drop",
    ) as HTMLButtonElement;
    useButton.type = "button";
    useButton.title = "The next chip drop pins this shape";
    useButton.disabled = pendingBrowse === null || pendingBrowse === committed;
    useButton.addEventListener("click", () => {
      if (current) preview.set(pending!.key, current.shape);
      pendingBrowse = null;
      render();
    });

    const notes = current
      ? current.frets
          .map((fret, s) => (fret === null ? null : midiName(readTuning()[s] + fret)))
          .filter((n): n is string => n !== null)
          .join(" ")
      : "";

    picker.replaceChildren(
      el("div", "voicing-head", `${pending.name} · ${list.length} voicings · not yet on the track`),
      el("div", "voicing-shape", current?.shape ?? ""),
      el("div", "voicing-notes", `${parsed.name} · ${notes}`),
      (() => {
        const controls = el("div", "voicing-controls");
        controls.append(prevButton, nextButton, useButton, hear);
        return controls;
      })(),
      ...(current
        ? [renderChordDiagram({ frets: current.frets }, readTuning(), noteName, 0)]
        : []),
      el(
        "p",
        "muted riff-hint",
        pendingBrowse === null && committed !== undefined && committed === current.shape
          ? `"${pending.name}" will land with this shape pinned when you drag its chip onto a bar.`
          : `Previewing — click "Use for the drop" to make this the shape the chip drops with.`,
      ),
    );
    voicingSummary.textContent = `· ${pending.name} waiting to be placed`;
    return;
  }

  const view = views[focusIndex];
  const base = view.list[view.rank] ?? { frets: view.event.frets, shape: view.shape, cost: 0 };
  const previewed = preview.get(view.index);
  const current = previewed === undefined
    ? base
    : (view.list.find((entry) => entry.shape === previewed) ?? base);
  const previous = focusIndex > 0 ? views[focusIndex - 1] : null;
  const notes = view.event.notes
    .map((note) => midiName(readTuning()[note.stringIndex] + note.fret))
    .join(" ");

  // Stepping only PREVIEWS: the browsed shape is shown/played but is not
  // written into the stream, so wandering the list can't silently pin a
  // shape the ear hasn't approved (the pin happens on "Use this").
  const step = (delta: number) => {
    const effective = preview.get(view.index) ?? view.shape;
    const currentRank = view.list.findIndex((entry) => entry.shape === effective);
    const next = Math.min(view.list.length - 1, Math.max(0, currentRank + delta));
    preview.set(view.index, view.list[next].shape);
    focusIndex = view.index;
    render();
  };
  const effectiveRank = previewed === undefined ? view.rank : Math.max(0, view.list.findIndex((e) => e.shape === previewed));
  const prevButton = el("button", "voicing-step", "◀") as HTMLButtonElement;
  prevButton.type = "button";
  prevButton.disabled = effectiveRank === 0;
  prevButton.title = "Previous voicing (smoother hand movement)";
  prevButton.addEventListener("click", () => step(-1));

  const nextButton = el("button", "voicing-step", "▶") as HTMLButtonElement;
  nextButton.type = "button";
  nextButton.disabled = effectiveRank === view.list.length - 1;
  nextButton.title = "Next voicing (smoother hand movement)";
  nextButton.addEventListener("click", () => step(1));

  // Stepping alone is not enough. The list is ordered "best first", so a shape
  // the search only reached because it charges nothing for a muted string can
  // sit hundreds of ranks down, and ◀ ▶ from there walk further into the same
  // thin tail. This is the way back to the top of the list in one click.
  const bestButton = el("button", "voicing-best", "best ▲") as HTMLButtonElement;
  bestButton.type = "button";
  bestButton.disabled = effectiveRank === 0;
  bestButton.title = "Jump to the top of the list: the smoothest, fullest option";
  bestButton.addEventListener("click", () => {
    preview.set(view.index, view.list[0].shape);
    focusIndex = view.index;
    render();
  });

  // The commit button: browser-stepping and "best" only PREVIEW. Writing
  // the browsed shape into the chord stream is an explicit choice (the
  // pin), so a careless ◀ ▶ can't silently replace the ring of chords
  // with a shape the ear hasn't approved. It is disabled only when there
  // is nothing SO DIFFERENT to pin (no preview, or the preview is the
  // pinned/auto shape already).
  const useButton = el("button", "voicing-use", previewed !== undefined && previewed !== view.shape ? `Use this (${current.shape})` : "Use this") as HTMLButtonElement;
  useButton.type = "button";
  useButton.disabled = previewed === undefined || previewed === view.shape;
  useButton.title = "Pin this exact shape for this chord; other chords re-optimize around it";
  useButton.addEventListener("click", () => {
    pins[view.index] = { name: view.event.label, shape: current.shape };
    preview.delete(view.index);
    focusIndex = view.index;
    render();
  });

  const autoButton = el("button", "voicing-auto", view.pinned || previewed !== undefined ? "Auto (unpin/unpreview)" : "Auto") as HTMLButtonElement;
  autoButton.type = "button";
  autoButton.disabled = !view.pinned && previewed === undefined;
  autoButton.title = "Hand this chord back to the voicing search";
  autoButton.addEventListener("click", () => {
    pins[view.index] = null;
    preview.delete(view.index);
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
  const hint = previewed !== undefined
    ? `Previewing ${current.shape} — nothing is played until you click "Use this"; 'Auto' stops previewing.`
    : deeper > 0
      ? `The search picked a ${current.sounded}-string shape; ${deeper} fuller voicing${deeper === 1 ? "" : "s"} rank above it. "best ▲" jumps straight there, then ◀ ▶ walks the list.`
      : view.pinned
        ? "Pinned: this is the exact shape that plays, and the chords after it were re-chosen around it."
        : "Auto: the search picked this, and it is already the fullest smooth option from the previous chord.";

  const controls = el("div", "voicing-controls");
  controls.append(prevButton, nextButton, bestButton, useButton, autoButton, playButtonOne);

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
    riff = parseRiff(source, {
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
    trackEl.replaceChildren();
    output.replaceChildren();
    tabs.replaceChildren();
    picker.replaceChildren();
    return null;
  }
  setError(null);
  plan = riff;
  if (!notesViewDirty) text.value = splitChordLine(source).rest;
  renderBuilders();

  const barsTotal = Math.max(1, Math.ceil(riff.totalBeats / riff.beatsPerBar));
  loopStartInput.max = String(barsTotal);
  loopEndInput.max = String(barsTotal);
  // A new bar count means a new piece: reset the loop to the whole riff,
  // otherwise a riff that grew gets clipped to whatever stale loop was left
  // (the default "Loop to bar 4" silently plays only the first row). A same-
  // length edit keeps the user's loop numbers.
  if (barsTotal !== lastBarsTotal) {
    lastBarsTotal = barsTotal;
    loopStartInput.value = "1";
    loopEndInput.value = String(barsTotal);
  }

  const bars = riff.totalBeats / riff.beatsPerBar;
  const noteCount = riff.events.reduce((sum, event) => sum + event.notes.length, 0);
  summaryLine.textContent =
    `· ${riff.bpm} bpm · ${bars} bar${bars === 1 ? "" : "s"} · ` +
    `${riff.events.length} event${riff.events.length === 1 ? "" : "s"} / ${noteCount} note${noteCount === 1 ? "" : "s"}` +
    (riff.strumMs > 0 ? ` · strum ${riff.strumMs} ms` : " · blocked") +
    (riff.releaseMs > 0 ? ` · release ${riff.releaseMs} ms` : "");

  const loop = loopWindow(riff);
  const tuningNow = readTuning();
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

  // Bars that fit in the track's box width (== one column per step column of
  // 2rem, read from the CSS var so the wrap maths follows the stylesheet).
  const stepPx = parseFloat(getComputedStyle(document.documentElement).fontSize || "16") * 2;
  const trackColsPx = Math.max(320, trackEl.clientWidth || 900) / stepPx;
  const barsPerRow = Math.max(1, Math.floor(trackColsPx / (riff.beatsPerBar / riff.stepBeats)));

  // Unified track view: regions + lanes + playhead, draggable onto itself.
  const track = renderTrack(riff, {
    tuning: tuningNow,
    loop,
    barsPerRow,
    onPlayEvent: (index) => playEvents([index]),
    moves: {
      // A chord drop writes through the progression input (the live view of
      // the stream), which formats and replaces the chord line. Regions
      // count chord EVENTS (rests are not events); the notation is
      // positional in TOKENS — tokenIndexForChordOrdinal bridges them.
      onMoveChord: (index, bar) => {
        const ordinal = riff.events.slice(0, index + 1).filter((e) => e.kind === "chord").length - 1;
        const tokens = chordTokensFromText(source);
        const from = tokenIndexForChordOrdinal(tokens, ordinal);
        if (from < 0 || from === bar) return;
        pins = movePins(pins, tokens, from, bar);
        applyProgression(moveChordToken(tokens, from, bar));
      },
      // A note drop edits the overlay lanes (same machinery as the tab
      // editor's cells), which regenerates the lane text.
      onMoveNote: (from, to) => {
        const event = riff.events[from.eventIndex];
        if (!event || event.kind !== "note") return;
        const column = Math.round(event.beat / riff.stepBeats);
        const lanes = buildOverlay(riff);
        if (!moveLaneNote(lanes, { string: from.string, column }, to)) return;
        updateTabLanes(lanes);
      },
      // A chord chip dropped on a bar: same write path as a chord move. If
      // the chip's voicing was previewed, the bar is pinned to it.
      onAddChord: (bar, name, shape, key) => {
        const tokens = chordTokensFromText(source);
        const next = addChordToken(tokens, bar, name);
        if (shape) {
          pins = insertOrReplacePin(pins, tokens, bar, { name, shape });
        }
        // Retire the pending entry BEFORE applyProgression: refresh() rebuilds
        // the chip row from addedChords, so splicing after it would leave the
        // "to add" chip on screen until the next refresh — the reported bug.
        if (key) {
          const at = addedChords.findIndex((e) => e.key === key);
          if (at >= 0) addedChords.splice(at, 1);
          preview.delete(key);
          if (pending?.key === key) {
            pending = null;
            pendingBrowse = null;
            focusPending = false;
          }
        }
        applyProgression(next);
      },
      // Type a fret number onto a string/beat: the track's lane clicks land
      // here. An empty entry DELETES whatever note sat there.
      onSetNote: (to, fret) => {
        const lanes = buildOverlay(riff);
        const ok = fret === null ? clearLaneNote(lanes, to) : setLaneNote(lanes, to, fret);
        if (!ok) return;
        updateTabLanes(lanes);
      },
    },
  });
  trackEl.replaceChildren(track);

  renderVoicingPicker();
  return riff;
}

/** Repaint everything from the current plan + pins. */
function render() {
  if (refresh()) return;
}

text.addEventListener("input", () => {
  stop();
  notesViewDirty = true;
  // Re-voicing the whole chord stream per keystroke is wasted work, and error
  // text that updates per character fights the typing.
  window.clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    const { chordLine } = splitChordLine(source);
    const candidate = chordLine === null ? text.value : withChordLine(text.value, chordLine);
    try {
      parseRiff(candidate, {
        tuning: readTuning(),
        maxFrets: readInt(fretsInput, 15),
        span: readInt(spanInput, 5),
        cap: readInt(capInput, 400),
        defaultStrumMs: DEFAULT_CONFIG.strum.guitarMs,
        pins: pins.filter((pin): pin is VoicingPin => pin !== null),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return; // keep the last good source and the box as typed
    }
    source = candidate;
    notesViewDirty = false;
    setError(null);
    refresh();
  }, RIFF_EDIT_MS);
});

// These re-plan: they change what the chord stream is voiced into.
for (const input of [tuningSelect, fretsInput, spanInput, capInput, ...customStrings]) {
  input.addEventListener("input", () => {
    stop();
    refresh();
  });
}

// Strum speed is NOT in that list and does not re-plan. It writes the shared
// audio config so `playVoicing` picks it up on the next click, and re-planning
// here would rewrite the field from the config on every keystroke — which
// silently undid the edit (typed 40, field snapped back to 140).
const applyStrum = () => {
  DEFAULT_CONFIG.strum.guitarMs = Math.min(400, Math.max(0, readInt(strumInput, 140)));
};
strumInput.addEventListener("input", applyStrum);
strumInput.addEventListener("change", applyStrum);

for (const input of [scaleInput, loopStartInput, loopEndInput]) {
  input.addEventListener("input", () => {
    if (transport) stop();
    if (plan) {
      const loop = loopWindow(plan);
      transport?.setLoop(loop.start, loop.end);
    }
  });
}

// Tool tab switching (Chords / Text / Settings over one notation)
let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => refresh(), 150);
});

const toolTabs = document.querySelectorAll<HTMLButtonElement>(".fingering-tab");
const toolPanels = document.querySelectorAll<HTMLElement>(".fingering-panel");
toolTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    toolTabs.forEach((t) => t.classList.remove("is-active"));
    toolPanels.forEach((p) => { p.hidden = true; });
    tab.classList.add("is-active");
    const panel = document.querySelector<HTMLElement>(`.fingering-panel[data-tool-panel="${tab.dataset.tool}"]`);
    if (panel) panel.hidden = false;
  });
});

refresh();
