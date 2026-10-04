import { el, colorFor } from "./render.js";
import { chordShape } from "./fretboard.js";
import { LEAD_IN_BEATS, barMarkFraction, beatAtFraction, noteLeftPercent, stepColumns, trackFraction } from "./timeline.js";
import { makeDraggable, makeDropZone, onDragEnd, onDragStart, resetDragSession } from "./dnd.js";
import type { Riff, RiffEvent } from "./riff.js";

/**
 * Unified track view, DAW-style: one canvas, and every event is a REGION —
 * left edge exactly at its start beat, width exactly its span. The playhead
 * touches a region's left edge at the moment it sounds. That convention is
 * the point: the previous blocks were CENTERED on their beats, so a block's
 * left edge (what the eye reads as the start) landed half a block-width
 * early — one full column for the shipped example, which the user measured
 * by eye as "off by a half beat".
 *
 * Layout: a bar ruler, one chord lane (name + shape per chord), and one lane
 * per string (tab notes) — all flow rows whose width IS the canvas, so a
 * region's `left`/`width` percentages resolve against the same box as the
 * loop overlay and the playhead (the same-beat-same-pixel invariant). The
 * canvas opens LEAD_IN_BEATS before the music (see timeline.ts), and being
 * flow-laid-out it is exactly as tall as the content — a fixed-height canvas
 * is what the low-string chips used to overflow.
 */

const STRING_LETTERS = "eBGDAE";

/** Drag-and-drop edits the track offers when these are provided. */
export interface TrackMoves {
  /** A chord region was dropped on bar `bar` (0-based). Replace semantics. */
  onMoveChord?: (eventIndex: number, bar: number) => void;
  /** A note region was dropped on (string, column). Fret-preserving. */
  onMoveNote?: (from: { eventIndex: number; string: number }, to: { string: number; column: number }) => void;
  /** A chord builder chip was dropped on bar `bar` (0-based). */
  onAddChord?: (bar: number, name: string, shape: string | null, key?: string) => void;
  /** A lane cell was clicked; the typed fret (or null for delete) applies there. */
  onSetNote?: (to: { string: number; column: number }, fret: number | null) => void;
}

export interface TrackOptions {
  tuning: number[];
  onPlayEvent?: (index: number) => void;
  loop?: { start: number; end: number } | null;
  moves?: TrackMoves;
  /** Bars per staff row before wrapping. Unset = the whole piece on one row. */
  barsPerRow?: number;
}

/** What a dragged thing carries to the drop zones: a region, or a builder chip. */
export type DragPayload =
  | { kind: "chord"; eventIndex: number }
  | { kind: "note"; eventIndex: number; string: number }
  | { kind: "new-chord"; name: string; shape: string | null; key?: string };

/**
 * Where each event's region ENDS, in music beats (index-aligned with
 * `events`, which parseRiff returns beat-sorted). The model has no explicit
 * durations, so a region spans until the next event OF THE SAME KIND: a
 * chord rings until the next chord (the harmonic rhythm — a bar-long C spans
 * its bar), a tab note until the next tab note (a string keeps ringing
 * through a rest, which is what a real string does), and the last of each
 * kind runs to the end of the piece. Chord and note lanes are separate, so a
 * chord and a tab event on the same beat each keep their own full span
 * instead of cutting each other off.
 */
export function regionEnds(events: RiffEvent[], totalBeats: number, beatsPerBar = 4): number[] {
  const ends = new Array<number>(events.length).fill(totalBeats);
  const nextOfKind = new Map<string, number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const next = nextOfKind.get(events[i].kind);
    if (next !== undefined) ends[i] = events[next].beat;
    nextOfKind.set(events[i].kind, i);
  }
  // A silent bar (no chord, no tab note) is a real rest: a chord or note
  // region must not ring across it, even when the next same-kind event is
  // bars away. This is what keeps an emptied grid (e.g. +4 empty bars)
  // visually empty instead of having the previous bar bleed into it.
  for (let i = 0; i < events.length; i++) {
    for (let bar = 0; bar * beatsPerBar < totalBeats; bar++) {
      const from = bar * beatsPerBar;
      const to = from + beatsPerBar;
      if (from <= events[i].beat) continue;
      if (!events.some((e) => e.beat >= from && e.beat < to)) {
        ends[i] = Math.min(ends[i], from);
        break;
      }
    }
  }
  return ends;
}

/**
/**
 * Render the riff as a track: one or more SYSTEMS of (bar ruler + chord
 * lane + string lanes). Every event is a REGION — left edge exactly at its
 * start beat, width exactly its span. The playhead touches a region's left
 * edge at the moment it sounds. That convention is the point: the previous
 * blocks were CENTERED on their beats, so a block's left edge (what the eye
 * reads as the start) landed half a block-width early — one full column for
 * the shipped example, which the user measured by eye as "off by a half
 * beat".
 *
 * Staff-wrapped: the track fills the page width with `barsPerRow` bars, and
 * continues on the next row(s) when there are more. Each system is its own
 * `.track-canvas`, but every horizontal position is still a fraction of the
 * same canvas — the same-beat-same-pixel invariant is per-system, never px.
 */
export function renderTrack(
  riff: Riff,
  options: TrackOptions,
): HTMLElement {
  const { tuning } = options;
  const box = el("div", "track");
  const barsTotal = Math.max(1, Math.ceil(riff.totalBeats / riff.beatsPerBar));
  const barsPerRow =
    options.barsPerRow && options.barsPerRow > 0
      ? Math.min(options.barsPerRow, barsTotal)
      : barsTotal;
  const systemCount = Math.ceil(barsTotal / barsPerRow);
  const ends = regionEnds(riff.events, riff.totalBeats, riff.beatsPerBar);

  // Reset the drag registry once for the whole track (the canvases' cleanup
  // hooks would otherwise accumulate across systems/refreshes).
  resetDragSession();
  onDragStart<DragPayload>((payload) => {
    box.classList.toggle("track-drag-chord", payload.kind === "chord" || payload.kind === "new-chord");
    box.classList.toggle("track-drag-note", payload.kind === "note");
  });
  onDragEnd(() => {
    box.classList.remove("track-drag-chord", "track-drag-note");
  });

  for (let s = 0; s < systemCount; s++) {
    const isFirst = s === 0;
    const barStart = s * barsPerRow;
    const barCount = Math.min(barsPerRow, barsTotal - barStart);
    const sysBeats = barCount * riff.beatsPerBar;
    const sysLead = isFirst ? LEAD_IN_BEATS : 0;
    const sysStart = barStart * riff.beatsPerBar;
    const sysEnd = sysStart + sysBeats;
    const columns = stepColumns(sysBeats + sysLead, riff.stepBeats);

    const system = el("div", "track-system");
    const gutter = el("div", "track-gutter");
    gutter.appendChild(el("div", "track-gutter-ruler"));
    gutter.appendChild(el("div", "track-gutter-chord"));
    for (let stringIndex = tuning.length - 1; stringIndex >= 0; stringIndex--) {
      const cell = el("div", "track-gutter-letter", STRING_LETTERS[tuning.length - 1 - stringIndex]);
      gutter.appendChild(cell);
    }
    system.appendChild(gutter);

    const canvas = el("div", "track-canvas");
    canvas.dataset.sysStart = String(sysStart);
    canvas.dataset.sysBeats = String(sysBeats);
    canvas.dataset.sysLead = String(sysLead);
    canvas.style.setProperty("--track-cols", String(columns));
    system.appendChild(canvas);
    box.appendChild(system);

    // Local frame: music beats of this system are 0..sysBeats, and the
    // geometry functions are told about its own lead-in (1 only on system 0).
    const local = (globalBeat: number) => globalBeat - sysStart;
    const leftPct = (globalBeat: number) => noteLeftPercent(local(globalBeat), sysBeats, sysLead);

    // ---- bar ruler ----
    const barTrack = el("div", "track-bar-track");
    for (let b = 0; b < barCount; b++) {
      const cell = el("div", "track-bar", String(barStart + b + 1));
      cell.style.setProperty("--track-bar-start", String(barMarkFraction(b, riff.beatsPerBar, sysBeats, sysLead)));
      barTrack.appendChild(cell);
    }
    canvas.appendChild(barTrack);

    // ---- chord lane + string lanes ----
    const chordLane = el("div", "track-lane track-chord-lane");
    canvas.appendChild(chordLane);
    const lanes: HTMLElement[] = [];
    for (let stringIndex = tuning.length - 1; stringIndex >= 0; stringIndex--) {
      const lane = el("div", "track-lane");
      lanes[stringIndex] = lane;
      canvas.appendChild(lane);
    }

    // ---- the dashed drop indicator for this system ----
    const indicator = el("div", "track-drop");
    indicator.hidden = true;
    canvas.appendChild(indicator);
    const hideIndicator = () => {
      indicator.hidden = true;
    };
    const showIndicator = (lane: HTMLElement, leftPercent: number) => {
      indicator.style.top = `${lane.offsetTop}px`;
      indicator.style.height = `${lane.offsetHeight}px`;
      indicator.style.left = `${leftPercent}%`;
      indicator.hidden = false;
    };
    const fractionAtX = (x: number): number => {
      const rect = canvas.getBoundingClientRect();
      return Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    };
    const columnAtX = (x: number): number => {
      const beat = beatAtFraction(fractionAtX(x), sysBeats, sysLead);
      const column = Math.round((sysStart + beat) / riff.stepBeats);
      const maxColumn = stepColumns(riff.totalBeats, riff.stepBeats) - 1;
      return Math.min(maxColumn, Math.max(0, column));
    };
    const barAtX = (x: number): number => {
      const beat = beatAtFraction(fractionAtX(x), sysBeats, sysLead);
      const bar = Math.floor((sysStart + beat) / riff.beatsPerBar);
      return Math.min(barsTotal - 1, Math.max(0, bar));
    };

    if (options.moves?.onMoveChord || options.moves?.onAddChord) {
      makeDropZone<DragPayload>(chordLane, {
        over: (x, _y, payload) => {
          if (payload.kind !== "chord" && payload.kind !== "new-chord") return false;
          const barLocal = barAtX(x) - barStart;
          showIndicator(chordLane, noteLeftPercent(barLocal * riff.beatsPerBar, sysBeats, sysLead));
          return true;
        },
        drop: (x, _y, payload) => {
          const bar = barAtX(x);
          if (payload.kind === "chord") options.moves!.onMoveChord!(payload.eventIndex, bar);
          if (payload.kind === "new-chord") options.moves!.onAddChord!(bar, payload.name, payload.shape, payload.key);
        },
        end: hideIndicator,
      });
    }
    if (options.moves?.onMoveNote) {
      lanes.forEach((lane, stringIndex) => {
        makeDropZone<DragPayload>(lane, {
          over: (x, _y, payload) => {
            if (payload.kind !== "note") return false;
            const colGlobal = columnAtX(x);
            showIndicator(lane, noteLeftPercent(colGlobal * riff.stepBeats - sysStart, sysBeats, sysLead));
            return true;
          },
          drop: (x, _y, payload) => {
            const to = { string: stringIndex, column: columnAtX(x) };
            if (payload.kind === "note") options.moves!.onMoveNote!({ eventIndex: payload.eventIndex, string: payload.string }, to);
          },
          end: hideIndicator,
        });
      });
    }

    // Click-to-edit on the lanes: pop a tiny input at that column.
    if (options.moves?.onSetNote) {
      const fretInput = document.createElement("input");
      fretInput.className = "track-fret-input";
      fretInput.type = "text";
      fretInput.inputMode = "numeric";
      fretInput.placeholder = "fret #";
      fretInput.hidden = true;
      canvas.appendChild(fretInput);
      let target: { string: number; column: number } | null = null;
      const closeFretInput = () => {
        fretInput.hidden = true;
        target = null;
      };
      lanes.forEach((lane, stringIndex) => {
        lane.addEventListener("click", (event) => {
          const column = columnAtX(event.clientX);
          const onThatBeat = riff.events.find(
            (e) => e.kind === "note" && Math.abs(e.beat - column * riff.stepBeats) < 1e-6,
          );
          const current = onThatBeat?.notes.find((n) => n.stringIndex === stringIndex)?.fret ?? null;
          target = { string: stringIndex, column };
          fretInput.value = current === null ? "" : String(current);
          fretInput.style.top = `${lane.offsetTop}px`;
          fretInput.style.left = `${noteLeftPercent(column * riff.stepBeats - sysStart, sysBeats, sysLead)}%`;
          fretInput.hidden = false;
          fretInput.focus();
          fretInput.select();
        });
      });
      fretInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeFretInput();
          return;
        }
        if (event.key !== "Enter" || !target) return;
        const at = target;
        const raw = fretInput.value.trim();
        const fret = raw === "" ? null : Number(raw);
        closeFretInput();
        if (fret === null) {
          options.moves!.onSetNote!(at, null);
        } else if (Number.isInteger(fret) && fret >= 0 && fret <= 24) {
          options.moves!.onSetNote!(at, fret);
        }
      });
      fretInput.addEventListener("blur", closeFretInput);
    }

    // ---- regions for events whose START beat is in this system ----
    riff.events.forEach((event, index) => {
      if (event.beat < sysStart || event.beat >= sysEnd) return;
      const regionEndLocal = Math.min(ends[index], sysEnd);
      const left = leftPct(event.beat);
      const width = noteLeftPercent(regionEndLocal - sysStart, sysBeats, sysLead) - left;
      const bar = Math.floor(event.beat / riff.beatsPerBar) + 1;
      const beat = (event.beat % riff.beatsPerBar) + 1;
      const title = `${event.label} — bar ${bar}, beat ${beat}`;
      const wire = (region: HTMLElement, payload: DragPayload) => {
        region.style.left = `${left}%`;
        region.style.width = `${Math.max(0, width)}%`;
        region.dataset.index = String(index);
        region.title = title;
        if (options.onPlayEvent) {
          region.classList.add("track-clickable");
          region.addEventListener("click", (e) => {
            e.stopPropagation();
            options.onPlayEvent!(index);
          });
        }
        const movable = payload.kind === "chord" ? options.moves?.onMoveChord : options.moves?.onMoveNote;
        if (movable) {
          region.classList.add("track-movable");
          makeDraggable<DragPayload>(region, payload);
        }
      };
      if (event.kind === "chord") {
        const region = el("div", "track-region track-chord-region");
        region.appendChild(el("span", "track-region-name", event.label));
        region.appendChild(el("span", "track-region-shape", chordShape(event.frets)));
        wire(region, { kind: "chord", eventIndex: index });
        chordLane.appendChild(region);
      } else {
        for (const note of event.notes) {
          const region = el("div", "track-region track-note-region");
          region.style.background = colorFor((tuning[note.stringIndex] + note.fret) % 12);
          region.appendChild(el("span", "track-region-fret", String(note.fret)));
          wire(region, { kind: "note", eventIndex: index, string: note.stringIndex });
          (lanes[note.stringIndex] ?? lanes[lanes.length - 1]).appendChild(region);
        }
      }
    });

    // ---- loop region (clipped to this system) ----
    if (options.loop && options.loop.start < sysEnd && options.loop.end > sysStart) {
      const region = el("div", "track-loop");
      region.style.setProperty(
        "--track-loop-a",
        String(trackFraction(Math.max(options.loop.start, sysStart) - sysStart, sysBeats, sysLead)),
      );
      region.style.setProperty(
        "--track-loop-b",
        String(trackFraction(Math.min(options.loop.end, sysEnd) - sysStart, sysBeats, sysLead)),
      );
      canvas.appendChild(region);
    }

    canvas.appendChild(el("div", "track-playhead"));
  }
  return box;
}

/** Move the playhead on the track to a beat (negative = in the lead-in pause). */
export function setTrackPlayhead(box: HTMLElement, beat: number, totalBeats: number, leadInBeats = LEAD_IN_BEATS): void {
  box.querySelectorAll<HTMLElement>(".track-canvas").forEach((canvas) => {
    const sysStart = Number(canvas.dataset.sysStart ?? 0);
    const sysBeats = Number(canvas.dataset.sysBeats ?? 0);
    const sysLead = Number(canvas.dataset.sysLead ?? 0);
    let frac: number;
    const inSystem = beat >= sysStart - sysLead && beat < sysStart + sysBeats;
    if (!inSystem) {
      canvas.style.setProperty("--track-head-frac", "0");
      canvas.querySelector<HTMLElement>(".track-playhead")!.style.visibility = "hidden";
      return;
    }
    canvas.querySelector<HTMLElement>(".track-playhead")!.style.visibility = "";
    frac = trackFraction(beat - sysStart, sysBeats, sysLead);
    canvas.style.setProperty("--track-head-frac", String(frac));
  });
  // The old single-canvas style var is tolerated by old CSS; nothing new uses it.
  void totalBeats;
  void leadInBeats;
}
