import type { Riff, RiffEvent } from "./riff.js";

/**
 * Lookahead scheduler for a riff. Web Audio wants every event placed on the
 * context clock slightly BEFORE it sounds, so a `setTimeout`-per-note loop
 * (what Song mode does) jitters audibly; instead a coarse timer wakes up often
 * and places every event falling inside the next `LOOKAHEAD` seconds directly
 * on `AudioContext.currentTime`, which is sample-accurate.
 *
 * The clock is a pair — `anchorBeat` (a beat in the piece) and `anchorTime`
 * (the context time it lands on) — so a loop wrap only has to re-anchor, and
 * tempo is one `secondsPerBeat` factor.
 */

/** How often the scheduler wakes to top up the schedule. */
const TICK_MS = 25;
/** How far ahead of the playhead events are placed. */
const LOOKAHEAD_S = 0.3;

export interface TransportCallbacks {
  /** Place one event at an absolute AudioContext time. */
  onEvent: (event: RiffEvent, when: number) => void;
  /** The context's current time — injected so the transport is testable. */
  now: () => number;
}

/** Timer seam, so a test can drive `advance()` instead of real time. */
export interface TransportTicker {
  every(ms: number, fn: () => void): unknown;
  clear(handle: unknown): void;
}

const realTicker: TransportTicker = {
  every: (ms, fn) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class RiffTransport {
  private readonly riff: Riff;
  private readonly spb: number;
  private readonly callbacks: TransportCallbacks;
  private readonly ticker: TransportTicker;
  private timer: unknown = null;

  /** Piece beat that `anchorTime` corresponds to. */
  private anchorBeat = 0;
  private anchorTime = 0;
  /** Next event to place; events are pre-filtered to the loop window. */
  private queue: RiffEvent[] = [];
  private queueIndex = 0;
  private loopStart: number;
  private loopEnd: number;

  constructor(
    riff: Riff,
    secondsPerBeat: number,
    callbacks: TransportCallbacks,
    ticker: TransportTicker = realTicker,
  ) {
    this.riff = riff;
    this.spb = secondsPerBeat;
    this.callbacks = callbacks;
    this.ticker = ticker;
    this.loopStart = riff.loop.start;
    this.loopEnd = riff.loop.end;
    this.queue = this.eventsInWindow(this.loopStart, this.loopEnd);
  }

  get playing(): boolean {
    return this.timer !== null;
  }
  get totalBeats(): number {
    return this.riff.totalBeats;
  }

  get loop(): { start: number; end: number } {
    return { start: this.loopStart, end: this.loopEnd };
  }

  /** Re-window the loop; takes effect from the next pass (or immediately if playing). */
  setLoop(start: number, end: number): void {
    if (this.playing) return;
    this.loopStart = start;
    this.loopEnd = end;
    this.queue = this.eventsInWindow(start, end);
    this.queueIndex = 0;
  }

  /** Current playhead position in beats, or `null` when stopped. */
  getBeat(): number | null {
    if (!this.playing) return null;
    return this.beatAt(this.callbacks.now());
  }

  private beatAt(time: number): number {
    return this.anchorBeat + (time - this.anchorTime) / this.spb;
  }

  private timeAt(beat: number): number {
    return this.anchorTime + (beat - this.anchorBeat) * this.spb;
  }

  /** Events inside the half-open window [start, end). */
  private eventsInWindow(start: number, end: number): RiffEvent[] {
    return this.riff.events.filter((event) => event.beat >= start && event.beat < end);
  }

  /** Begin (or restart) at the top of the loop window. `leadIn` delays the start. */
  play(leadIn = 0.06): void {
    this.stop();
    this.queue = this.eventsInWindow(this.loopStart, this.loopEnd);
    this.queueIndex = 0;
    this.anchorBeat = this.loopStart;
    this.anchorTime = this.callbacks.now() + leadIn;
    this.timer = this.ticker.every(TICK_MS, () => this.advance());
    this.advance();
  }

  stop(): void {
    if (this.timer !== null) {
      this.ticker.clear(this.timer);
      this.timer = null;
    }
    this.queueIndex = 0;
  }

  /**
   * One scheduling pass as of `time` (the timer calls this with the current
   * clock). Public so a test can drive the whole timeline synchronously against
   * a fake clock instead of racing `setInterval`.
   */
  advance(time: number = this.callbacks.now()): void {
    if (this.timer === null) return;
    const horizon = time + LOOKAHEAD_S;
    // Place every event due before the horizon. Guard the loop count: a window
    // with no events still has to advance the anchor past its end, or this
    // would spin forever.
    for (let guard = 0; guard < 512; guard++) {
      if (time >= this.timeAt(this.loopEnd)) {
        this.advancePass(time);
        continue;
      }
      const event = this.queue[this.queueIndex];
      if (!event) {
        // Nothing left in this pass: jump the anchor to the loop end and wrap.
        this.anchorTime = Math.max(this.timeAt(this.loopEnd), time + 0.01);
        this.anchorBeat = this.loopEnd;
        this.advancePass(time);
        continue;
      }
      const when = this.timeAt(event.beat);
      if (when > horizon) return;
      this.callbacks.onEvent(event, when);
      this.queueIndex++;
    }
  }

  /**
   * Wrap to the top of the loop window. The new anchor is derived from the
   * SCHEDULED end time, not `now()`, so the loop length never drifts with timer
   * jitter or a late tick.
   */
  private advancePass(time: number): void {
    this.anchorTime = Math.max(this.timeAt(this.loopEnd), time + 0.01);
    this.anchorBeat = this.loopStart;
    this.queue = this.eventsInWindow(this.loopStart, this.loopEnd);
    this.queueIndex = 0;
  }
}
