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
  /**
   * The playhead's own anchor: what is SOUNDING right now.
   *
   * It is deliberately NOT the scheduling anchor. Scheduling runs a full
   * LOOKAHEAD_S ahead of the clock, so its anchor is pre-rolled into the next
   * pass before a note has finished ringing — which is right for placing notes
   * on the audio clock, and wrong for anything a person looks at. Sharing one
   * anchor meant the playhead jumped to the next pass while the last chord was
   * still ringing: it ran off the left edge, clamped there for over a second,
   * and the loop looked like it stopped early. Two anchors, one formula.
   */
  private playBeat = 0;
  private playTime = 0;
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
    return this.playBeat + (this.callbacks.now() - this.playTime) / this.spb;
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
    this.playBeat = this.loopStart;
    this.playTime = this.anchorTime;
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
    // The playhead wraps at the AUDIBLE end of the pass. This is a pure
    // function of the clock, so it is independent of the queue and of the
    // lookahead below.
    this.wrapPlayhead(time);
    // At most one pre-roll per pass: a loop shorter than the lookahead would
    // otherwise satisfy the pre-roll condition forever and spin.
    let preRolled = false;
    for (let guard = 0; guard < 512; guard++) {
      if (!preRolled && time >= this.timeAt(this.loopEnd) - LOOKAHEAD_S) {
        this.advancePass(time);
        preRolled = true;
        continue;
      }
      const event = this.queue[this.queueIndex];
      if (!event) return;
      const when = this.timeAt(event.beat);
      if (when > horizon) return;
      // An event whose time has already gone by is one we are late placing
      // (only reachable after a stall — see advancePass). Skip it: scheduling
      // it in the past would fire a whole catch-up burst at once.
      if (when < time - 1e-9) {
        this.queueIndex++;
        continue;
      }
      this.callbacks.onEvent(event, when);
      this.queueIndex++;
    }
  }

  /** Move the playhead to the top of the loop, exactly, once the pass has sounded. */
  private wrapPlayhead(time: number): void {
    const playEnd = this.playTime + (this.loopEnd - this.playBeat) * this.spb;
    if (time < playEnd) return;
    this.playTime = playEnd;
    this.playBeat = this.loopStart;
  }

  /**
   * Pre-roll the next pass. The new anchor is derived from the SCHEDULED end
   * time, not `now()`, so the loop length never drifts with timer jitter or a
   * late tick — anchoring on `now()` instead loses up to one tick (25ms) per
   * wrap, which is 10% of a 250ms note after ten passes.
   */
  private advancePass(time: number): void {
    const scheduledEnd = this.timeAt(this.loopEnd);
    // Normally the pre-roll above fires a lookahead early, so the scheduled end
    // is still in the future and is used as-is. If we are more than a lookahead
    // BEHIND — the tab was suspended, the machine slept — re-anchor on `now()`,
    // or every event of the pass would be scheduled in the past.
    this.anchorTime = scheduledEnd > time - LOOKAHEAD_S ? scheduledEnd : time;
    this.anchorBeat = this.loopStart;
    this.queue = this.eventsInWindow(this.loopStart, this.loopEnd);
    this.queueIndex = 0;
  }
}
