/**
 * The transport: what actually gets scheduled, and where the playhead says the
 * listener is.
 *
 * The playhead and the scheduler are separate positions on purpose, and this
 * file pins that apart. The bug these tests exist for: scheduling runs a
 * lookahead ahead of the audio clock, the playhead used to read that same
 * pre-rolled anchor, so the bar left the timeline ~1.5s before the riff ended
 * and stood clamped at the left edge until the loop came round again. It threw
 * nothing, played all the right notes, and looked like the playhead simply
 * gave up partway through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRiff, secondsPerBeat } from "../dist/riff.js";
import { RiffTransport } from "../dist/transport.js";

const TUNING = [40, 45, 50, 55, 59, 64];
const riffOpts = {
  pins: [], beatsPerBar: 4, stepBeats: 0.5, span: 5, cap: 400,
  defaultStrumMs: 55, tuning: TUNING, maxFrets: 24,
};

/** A transport on a hand-driven clock; no timers, no audio. */
function harness(text, { loop } = {}) {
  const riff = parseRiff(text, riffOpts);
  let clock = 0;
  const fired = [];
  const transport = new RiffTransport(
    riff,
    secondsPerBeat(riff),
    {
      now: () => clock,
      // Record the clock each note was placed at, so a test can ask "was this
      // note ever scheduled behind the clock?" without rewinding time.
      onEvent: (event, when) => fired.push({ beat: event.beat, when, placedAt: clock }),
    },
    { every: () => 1, clear: () => undefined },
  );
  if (loop) transport.setLoop(loop[0], loop[1]);
  return {
    riff, transport, fired,
    /** Run `seconds` of context time in `stepMs` ticks, as the real ticker would. */
    run(seconds, stepMs = 20) {
      for (let t = 0; t <= seconds * 1000; t += stepMs) {
        clock = t / 1000;
        transport.advance(clock);
      }
    },
    /** Advance to `seconds`. The clock is monotonic — rewinding it would
     *  desynchronise the anchors, which is a test bug, not a transport one. */
    at(seconds) { assert.ok(seconds >= clock, `clock rewound to ${seconds}`); clock = seconds; transport.advance(seconds); },
    set clock(value) { clock = value; },
    get clock() { return clock; },
    /** Sample the playhead every `stepMs` up to `seconds`, advancing as we go. */
    sample(seconds, stepMs = 10) {
      const heads = [];
      for (let t = 0; t <= seconds * 1000; t += stepMs) { this.at(t / 1000); heads.push(transport.getBeat()); }
      return heads.filter((b) => b !== null);
    },
  };
}

// A note on every column, 120bpm => 0.25s per column (0.5 beats), 8 columns = 4 beats.
const EIGHTHS = "tempo 120\nbar 4\nstep eighths\ne|0-0-0-0-|\nB|-3-3-3-3|";

test("the playhead sweeps the whole loop before it wraps", () => {
  // The regression: with the lookahead pre-roll, the queue ran dry 0.3s + the
  // ring before the pass ended and the playhead was dragged back with it.
  const h = harness(EIGHTHS);
  h.transport.play(0);
  const beats = h.sample(4);
  assert.equal(Math.min(...beats), 0, "the playhead started before the loop");
  assert.ok(Math.max(...beats) > 3.9, `the playhead only reached ${Math.max(...beats)} of 4 beats`);
});

test("the playhead stays in the current pass right up to the loop point", () => {
  // 0.95 through a 2s pass: the pre-rolled anchor would already report the NEXT
  // pass, i.e. a negative beat, which renders clamped to the left edge.
  const h = harness(EIGHTHS, { loop: [0, 4] });
  h.transport.play(0);
  for (let t = 0; t <= 1.9; t += 0.01) h.at(t);
  assert.ok(h.transport.getBeat() > 3.5, `playhead was ${h.transport.getBeat()} at 1.9s of a 2s pass`);
  assert.ok(h.transport.getBeat() < 4, "the playhead ran past the loop end early");
});

test("the playhead wraps at the loop point, not a lookahead early", () => {
  const h = harness(EIGHTHS, { loop: [0, 4] }); // 2s per pass at 120bpm
  h.transport.play(0);
  h.at(1.99);
  const beforeWrap = h.transport.getBeat();
  h.at(2.01);
  const afterWrap = h.transport.getBeat();
  assert.ok(beforeWrap > 3.9, `expected ~4 beats before the wrap, got ${beforeWrap}`);
  assert.ok(afterWrap < 0.2, `expected the wrap to reset to ~0, got ${afterWrap}`);
});

test("the playhead is null when stopped, and restarts from the loop top", () => {
  const h = harness(EIGHTHS, { loop: [0, 2] });
  assert.equal(h.transport.getBeat(), null, "a stopped transport has no playhead");
  h.transport.play(0);
  assert.ok(h.transport.getBeat() >= 0);
  h.transport.stop();
  assert.equal(h.transport.getBeat(), null);
  h.transport.play(0);
  assert.ok(h.transport.getBeat() < 0.5, "play() restarts at the top of the loop");
});

test("every event in the window is placed exactly once per pass", () => {
  const h = harness(EIGHTHS, { loop: [0, 2] }); // 1s per pass, 4 events
  h.transport.play(0);
  h.run(5);
  const first = h.fired.slice(0, 4).map((f) => f.beat);
  assert.deepEqual(first, [0, 0.5, 1, 1.5], "the first pass is missing or reordered events");
  for (let pass = 0; pass < 5; pass++) {
    const slice = h.fired.slice(pass * 4, pass * 4 + 4);
    assert.deepEqual(slice.map((f) => f.beat), first, `pass ${pass} differs`);
    assert.equal(new Set(slice.map((f) => f.when)).size, 4, `pass ${pass} placed a note twice`);
  }
});

test("the loop period is exact, over many passes, whatever the tick rate", () => {
  // Anchoring the wrap on `now()` instead of the scheduled end loses up to one
  // tick per pass: 25ms a pass is 10% of a 250ms note after ten loops.
  for (const tickMs of [5, 20, 25, 50]) {
    const h = harness(EIGHTHS, { loop: [0, 2] }); // 1.0s per pass
    h.transport.play(0);
    h.run(10, tickMs);
    const starts = h.fired.filter((f) => f.beat === 0).map((f) => f.when);
    assert.ok(starts.length >= 9, `only ${starts.length} passes in 10s at ${tickMs}ms ticks`);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(
        Math.abs(starts[i] - starts[i - 1] - 1.0) < 1e-9,
        `pass ${i} drifted by ${(starts[i] - starts[i - 1] - 1.0).toFixed(6)}s at ${tickMs}ms ticks`,
      );
    }
  }
});

test("a narrowed loop plays only its own window", () => {
  const h = harness(EIGHTHS, { loop: [1, 3] });
  h.transport.play(0);
  const heads = h.sample(1.6);
  assert.ok(h.fired.length > 0);
  assert.ok(h.fired.every((f) => f.beat >= 1 && f.beat < 3), "played a note outside the window");
  assert.ok(Math.min(...heads) >= 1 - 1e-9, "the playhead left the loop window");
  assert.ok(Math.max(...heads) < 3 + 1e-9, "the playhead ran past the loop window");
});

test("an empty window still loops, and the playhead still moves", () => {
  // A window with no events used to need a queue-drain branch to make
  // progress; it must not hang, and it must not place anything.
  const h = harness(EIGHTHS, { loop: [4, 4.5] });
  h.transport.play(0);
  const heads = h.sample(1);
  assert.equal(h.fired.length, 0, "placed notes from an empty window");
  assert.ok(Math.max(...heads) > 4.4, "the playhead stalled in an empty window");
});

test("a stall resyncs instead of dumping a catch-up burst", () => {
  // Simulate a suspended tab: the clock jumps 10s past the scheduled end.
  const h = harness(EIGHTHS, { loop: [0, 2] });
  h.transport.play(0);
  h.at(0.1);
  const before = h.fired.length;
  h.at(10.2);
  const burst = h.fired.length - before;
  assert.ok(burst <= 2, `a 10s stall fired ${burst} notes at once`);
  h.run(1, 20);
  assert.ok(h.fired.length > before, "the transport did not resume after the stall");
});

test("nothing is ever placed in the past", () => {
  const h = harness(EIGHTHS, { loop: [0, 4] });
  h.transport.play(0);
  h.run(4, 20);
  for (const f of h.fired) {
    assert.ok(
      f.when >= f.placedAt - 1e-6,
      `note at ${f.when} was placed behind the clock (${f.placedAt})`,
    );
  }
});

test("scheduled times never go backwards", () => {
  const h = harness(EIGHTHS, { loop: [0, 4] });
  h.transport.play(0);
  h.run(6, 7);
  for (let i = 1; i < h.fired.length; i++) {
    assert.ok(
      h.fired[i].when >= h.fired[i - 1].when - 1e-9,
      `note ${i} at ${h.fired[i].when} is before note ${i - 1} at ${h.fired[i - 1].when}`,
    );
  }
});
