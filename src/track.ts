import { el, colorFor } from "./render.js";
import { chordShape } from "./fretboard.js";
import { noteLeftPercent, trackFraction } from "./timeline.js";
import type { Riff } from "./riff.js";

/**
 * Unified track view: one canvas, everything absolutely positioned against it.
 *
 * Event blocks on top, per-string grid chips below, one playhead. All share
 * the same positioning context so a note at beat N lands on the same pixel
 * whether it's a block or a chip.
 */

const STRING_LETTERS = "eBGDAE";

export interface TrackOptions {
  tuning: number[];
  onPlayEvent?: (index: number) => void;
  loop?: { start: number; end: number } | null;
}

/**
 * Render the riff as a unified track: one canvas with blocks + grid + playhead.
 */
export function renderTrack(
  riff: Riff,
  options: TrackOptions,
): HTMLElement {
  const { tuning } = options;
  const box = el("div", "track");
  const cols = Math.max(1, Math.ceil(riff.totalBeats / riff.stepBeats));

  // Single canvas — everything positions against this
  const canvas = el("div", "track-canvas");
  canvas.style.setProperty("--track-cols", String(cols));
  box.appendChild(canvas);

  // Bar ruler
  const barTrack = el("div", "track-bar-track");
  for (let bar = 0; bar * riff.beatsPerBar < riff.totalBeats; bar++) {
    const cell = el("div", "track-bar", String(bar + 1));
    cell.style.setProperty("--track-bar-start", String(barMarkFraction(bar, riff.beatsPerBar, riff.totalBeats)));
    barTrack.appendChild(cell);
  }
  canvas.appendChild(barTrack);

  // Loop region. When a loop edge IS the track edge it gets a class so the
  // CSS can bleed the highlight tint into the container's end padding — the
  // blocks centered on the first/last beat overhang the canvas and should
  // still sit on the blue. The region's own borders stay at the exact loop
  // bounds; an interior loop gets no bleed.
  if (options.loop) {
    const region = el("div", "track-loop");
    region.style.setProperty("--track-loop-a", String(trackFraction(options.loop.start, riff.totalBeats)));
    region.style.setProperty("--track-loop-b", String(trackFraction(options.loop.end, riff.totalBeats)));
    if (options.loop.start <= 0) region.classList.add("track-loop-at-start");
    if (options.loop.end >= riff.totalBeats) region.classList.add("track-loop-at-end");
    canvas.appendChild(region);
  }

  // Event blocks (top row)
  riff.events.forEach((event, index) => {
    const block = el("div", "track-block");
    block.style.left = `${noteLeftPercent(event.beat, riff.totalBeats)}%`;
    block.dataset.index = String(index);

    if (event.kind === "chord") {
      block.classList.add("track-chord");
      block.appendChild(el("span", "track-name", event.label));
      block.appendChild(el("span", "track-shape", chordShape(event.frets)));
    } else {
      block.classList.add("track-note");
      const frets = event.notes
        .map((n) => `${STRING_LETTERS[5 - n.stringIndex]}${n.fret}`)
        .join(" ");
      block.appendChild(el("span", "track-name", frets));
    }

    const bar = Math.floor(event.beat / riff.beatsPerBar) + 1;
    const beat = (event.beat % riff.beatsPerBar) + 1;
    block.title = `${event.label} — bar ${bar}, beat ${beat}`;

    if (options.onPlayEvent) {
      block.classList.add("track-clickable");
      block.addEventListener("click", (e) => {
        e.stopPropagation();
        options.onPlayEvent!(index);
      });
    }

    canvas.appendChild(block);
  });

  // Per-string grid chips
  riff.events.forEach((event, index) => {
    for (const note of event.notes) {
      const chip = el("div", "track-chip");
      const fretChip = el("span", "track-chip-fret", String(note.fret));
      fretChip.style.background = colorFor((tuning[note.stringIndex] + note.fret) % 12);
      chip.appendChild(fretChip);
      chip.style.left = `${noteLeftPercent(event.beat, riff.totalBeats)}%`;
      chip.style.top = `${5 + (tuning.length - 1 - note.stringIndex) * 1.5}rem`;
      chip.dataset.index = String(index);
      chip.title = `${event.label} — string ${note.stringIndex + 1} fret ${note.fret}`;

      if (options.onPlayEvent) {
        chip.classList.add("track-clickable");
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          options.onPlayEvent!(index);
        });
      }

      canvas.appendChild(chip);
    }
  });

  // Playhead
  canvas.appendChild(el("div", "track-playhead"));

  return box;
}

/** Move the playhead on the track to a beat. */
export function setTrackPlayhead(box: HTMLElement, beat: number, totalBeats: number): void {
  box.style.setProperty("--track-head-frac", String(trackFraction(beat, totalBeats)));
}

function barMarkFraction(bar: number, beatsPerBar: number, totalBeats: number): number {
  return trackFraction(bar * beatsPerBar, totalBeats);
}
