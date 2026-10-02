import { el, colorFor } from "./render.js";
import { chordShape } from "./fretboard.js";
import { LEAD_IN_BEATS, barMarkFraction, noteLeftPercent, stepColumns, trackFraction } from "./timeline.js";
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

export interface TrackOptions {
  tuning: number[];
  onPlayEvent?: (index: number) => void;
  loop?: { start: number; end: number } | null;
}

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
export function regionEnds(events: RiffEvent[], totalBeats: number): number[] {
  const ends = new Array<number>(events.length).fill(totalBeats);
  const nextOfKind = new Map<string, number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const next = nextOfKind.get(events[i].kind);
    if (next !== undefined) ends[i] = events[next].beat;
    nextOfKind.set(events[i].kind, i);
  }
  return ends;
}

/**
 * Render the riff as one track: bar ruler + chord lane + string lanes, with
 * the loop region and the playhead overlaid on the same canvas.
 */
export function renderTrack(
  riff: Riff,
  options: TrackOptions,
): HTMLElement {
  const { tuning } = options;
  const box = el("div", "track");
  // The canvas is one lead-in beat wider than the piece, so the empty beat
  // before the music takes up a real beat's width (not just thinner beats).
  const cols = stepColumns(riff.totalBeats + LEAD_IN_BEATS, riff.stepBeats);
  const canvas = el("div", "track-canvas");
  canvas.style.setProperty("--track-cols", String(cols));
  box.appendChild(canvas);

  // Bar ruler — a flow row, full canvas width like the lanes.
  const barTrack = el("div", "track-bar-track");
  for (let bar = 0; bar * riff.beatsPerBar < riff.totalBeats; bar++) {
    const cell = el("div", "track-bar", String(bar + 1));
    cell.style.setProperty("--track-bar-start", String(barMarkFraction(bar, riff.beatsPerBar, riff.totalBeats, LEAD_IN_BEATS)));
    barTrack.appendChild(cell);
  }
  canvas.appendChild(barTrack);

  // Chord lane, then one lane per string (high e first, like reading tab).
  const chordLane = el("div", "track-lane track-chord-lane");
  canvas.appendChild(chordLane);
  const lanes: HTMLElement[] = [];
  for (let stringIndex = tuning.length - 1; stringIndex >= 0; stringIndex--) {
    const lane = el("div", "track-lane");
    lane.appendChild(el("span", "track-lane-letter", STRING_LETTERS[tuning.length - 1 - stringIndex]));
    lanes[stringIndex] = lane;
    canvas.appendChild(lane);
  }

  // Regions. Left edge = the event's beat, width = its span, both as
  // percentages of the canvas with the lead-in — like every other position.
  const ends = regionEnds(riff.events, riff.totalBeats);
  const leftPct = (beat: number) => noteLeftPercent(beat, riff.totalBeats, LEAD_IN_BEATS);
  riff.events.forEach((event, index) => {
    const bar = Math.floor(event.beat / riff.beatsPerBar) + 1;
    const beat = (event.beat % riff.beatsPerBar) + 1;
    const title = `${event.label} — bar ${bar}, beat ${beat}`;
    const wire = (region: HTMLElement) => {
      region.style.left = `${leftPct(event.beat)}%`;
      region.style.width = `${leftPct(ends[index]) - leftPct(event.beat)}%`;
      region.dataset.index = String(index);
      region.title = title;
      if (options.onPlayEvent) {
        region.classList.add("track-clickable");
        region.addEventListener("click", (e) => {
          e.stopPropagation();
          options.onPlayEvent!(index);
        });
      }
    };
    if (event.kind === "chord") {
      const region = el("div", "track-region track-chord-region");
      region.appendChild(el("span", "track-region-name", event.label));
      region.appendChild(el("span", "track-region-shape", chordShape(event.frets)));
      wire(region);
      chordLane.appendChild(region);
    } else {
      for (const note of event.notes) {
        const region = el("div", "track-region track-note-region");
        region.style.background = colorFor((tuning[note.stringIndex] + note.fret) % 12);
        region.appendChild(el("span", "track-region-fret", String(note.fret)));
        wire(region);
        // A note lands on its own string's lane; an out-of-range index falls
        // back to the top lane so the region stays visible.
        (lanes[note.stringIndex] ?? lanes[lanes.length - 1]).appendChild(region);
      }
    }
  });

  // Loop region: borders at the exact loop bounds, tint between them. The
  // lead-in beat stays un-highlighted — it is outside the loop, and there is
  // no container padding left for its tint to bleed into.
  if (options.loop) {
    const region = el("div", "track-loop");
    region.style.setProperty("--track-loop-a", String(trackFraction(options.loop.start, riff.totalBeats, LEAD_IN_BEATS)));
    region.style.setProperty("--track-loop-b", String(trackFraction(options.loop.end, riff.totalBeats, LEAD_IN_BEATS)));
    canvas.appendChild(region);
  }

  // Playhead
  canvas.appendChild(el("div", "track-playhead"));

  return box;
}

/** Move the playhead on the track to a beat (negative = in the lead-in pause). */
export function setTrackPlayhead(box: HTMLElement, beat: number, totalBeats: number, leadInBeats = LEAD_IN_BEATS): void {
  box.style.setProperty("--track-head-frac", String(trackFraction(beat, totalBeats, leadInBeats)));
}
