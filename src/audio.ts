const NOTE_START = 0.03;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const active = new Set<AudioScheduledSourceNode>();

function ensureCtx(): AudioContext {
  if (ctx && master) return ctx;
  const c = new AudioContext();
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.knee.value = 4;
  comp.ratio.value = 6;
  comp.attack.value = 0.002;
  comp.release.value = 0.25;
  master = c.createGain();
  master.gain.value = 0.7;
  master.connect(comp);
  comp.connect(c.destination);
  ctx = c;
  return c;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function pluck(
  c: AudioContext,
  dest: AudioNode,
  freq: number,
  t: number,
  peak: number,
  dur: number,
): void {
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(Math.min(6000, freq * 5), t);
  filter.frequency.exponentialRampToValueAtTime(Math.max(300, freq * 1.2), t + 0.5);
  filter.Q.value = 0.5;

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  const specs = [
    { type: "sawtooth", gain: 0.75, mult: 1 },
    { type: "triangle", gain: 0.22, mult: 2 },
  ] as const;

  for (const sp of specs) {
    const o = c.createOscillator();
    o.type = sp.type;
    o.frequency.value = freq * sp.mult;
    const og = c.createGain();
    og.gain.value = sp.gain;
    o.connect(og);
    og.connect(filter);
    o.start(t);
    o.stop(t + dur + 0.05);
    active.add(o);
    o.onended = () => active.delete(o);
  }
  filter.connect(g);
  g.connect(dest);
}

/** Pluck every sounding string of a voicing (muted strings skipped). */
export function playVoicing(frets: (number | null)[], tuning: number[]): void {
  const strings = frets.map((f, s) => ({ fret: f, s })).filter((x) => x.fret !== null);
  const c = start();
  const base = c.currentTime + NOTE_START;
  for (const { fret, s } of strings) {
    const midi = tuning[s]! + fret!;
    const freq = midiToFreq(midi);
    const dur = Math.max(0.7, 2.6 - freq / 500);
    const peak = 0.5 * (s === 0 ? 1.35 : 1) * (strings.length / 6) ** 0.5 + 0.08;
    pluck(c, master!, freq, base + s * 0.03, peak, dur);
  }
}

/** Pluck a set of MIDI keys together (piano voicing). */
export function playNotes(midis: number[]): void {
  if (midis.length === 0) return;
  const c = start();
  const base = c.currentTime + NOTE_START;
  const roll = midis.length > 6 ? 0.006 : 0.004;
  for (let i = 0; i < midis.length; i++) {
    const freq = midiToFreq(midis[i]!);
    const dur = Math.max(0.7, 2.6 - freq / 500);
    const peak = (0.5 * (i === 0 ? 1.3 : 1) * (midis.length / 6) ** 0.5 + 0.08) * 0.9;
    pluck(c, master!, freq, base + i * roll, peak, dur);
  }
}

function start(): AudioContext {
  const c = ensureCtx();
  if (c.state === "suspended") void c.resume().catch(() => undefined);
  return c;
}

/** Silences anything still ringing. */
export function stopAudio(): void {
  if (!ctx) return;
  for (const o of active) {
    try {
      o.stop();
    } catch {
      /* already stopped */
    }
  }
  active.clear();
}