/**
 * PluckStringProcessor — a Karplus–Strong plucked string that runs on the
 * audio thread. Self-contained on purpose: `src/audio.ts` loads this file via
 * `audioWorklet.addModule()` and never imports it, so its global-scope
 * `registerProcessor` call never executes on the main thread.
 *
 * How it works (read section by section):
 *
 *  1. A noise burst (the "excitation") seeds a ring buffer.
 *  2. The buffer is read back as a delay line tuned to the note's period;
 *     reading and writing the same buffer makes it self-resonate (K-S loop).
 *  3. A one-pole lowpass in the loop (weighted against the previous output)
 *     makes the higher partials decay faster than the low ones, exactly like a
 *     real string under tension. Its cutoff is `damping` (0=bright, 1=dull).
 *  4. A separate highpassed noise transient adds the pick "scrape".
 *  5. An attack scoop glides the delay length (pitch) sharply toward target,
 *     giving the low strings a subtle plucked bend.
 *
 * The processor stops itself after `ringFrames` frames so the host can free it.
 */

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

export class PluckStringProcessor extends AudioWorkletProcessor {
  private readonly buffer: Float32Array;
  private readonly size: number;

  private write = 0;
  private frames = 0;
  private running = true;
  private last = 0;

  private delay: number;
  private readonly delayTarget: number;
  private readonly sustain: number;
  private readonly brightness: number;
  private readonly damping: number;
  private lp = 0;

  private excitationLeft = 0;
  private pickLeft = 0;
  private readonly pickSamples: number;
  private readonly pickLevel: number;
  private prevNoise = 0;

  private scoopsLeft = 0;

  private readonly ringFrames: number;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    // The AudioWorkletNode options arrive here as the constructor argument
    // (a processor has no `.options` property of its own).
    const o = (options?.processorOptions ?? {}) as Record<string, number | undefined>;
    const freq = Math.max(20, o.freq ?? 110);
    const cents = o.scoopCents ?? 0;
    const scoopMs = o.scoopMs ?? 18;

    this.ringFrames = Math.max(8, o.ringFrames ?? Math.floor(sampleRate * 3));
    this.size = Math.ceil(sampleRate / 16) + 16;
    this.buffer = new Float32Array(this.size);

    this.delayTarget = Math.max(8, sampleRate / freq);
    // Start sharp (shorter delay) and let scoop glide down onto pitch.
    this.delay = this.delayTarget * (1 - cents / 1200);
    this.scoopsLeft = Math.round((sampleRate * scoopMs) / 1000);

    this.sustain = clamp01(o.sustain ?? 0.996);
    this.brightness = clamp01(o.brightness ?? 0.85);
    this.damping = clamp01(o.damping ?? 0.5);
    this.excitationLeft = Math.round((sampleRate * (o.excitationMs ?? 8)) / 1000);

    this.pickSamples = Math.max(1, Math.round((sampleRate * (o.pickMs ?? 6)) / 1000));
    this.pickLevel = clamp01(o.pickLevel ?? 0);

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "stop") this.running = false;
    };
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0] && outputs[0][0];
    if (out) {
      for (let i = 0; i < out.length; i++) {
        this.step();
        out[i] = this.last;
        if (++this.frames >= this.ringFrames) this.running = false;
      }
    }
    return this.running;
  }

  /** Advance the string one sample. */
  private step(): void {
    // 1. Attack scoop: glide the (short, sharp) delay up to its pitch period.
    if (this.scoopsLeft > 0) {
      this.scoopsLeft--;
      this.delay += (this.delayTarget - this.delay) / Math.max(1, this.scoopsLeft);
    }

    // 2. Read the delayed signal at the current period; push it through the
    //    loop's one-pole lowpass (high partials die out sooner than lows).
    const read = this.write - this.delay;
    const x = this.readAt(read);
    this.lp = this.damping * this.lp + (1 - this.damping) * x;
    const damped = this.lp;

    // 3. Re-seed the loop with a fresh damped value plus the excitation.
    let w = damped * this.sustain;
    if (this.excitationLeft > 0) {
      this.excitationLeft--;
      w += (Math.random() * 2 - 1) * this.brightness;
    }

    // 4. Pick scrape: a short highpassed-noise transient, fading fast.
    if (this.pickLeft > 0) {
      this.pickLeft--;
      const n = Math.random() * 2 - 1;
      const high = n - this.prevNoise;
      this.prevNoise = n;
      const k = this.pickLeft / this.pickSamples;
      w += high * this.pickLevel * k * k;
    } else {
      this.prevNoise = 0;
    }

    this.buffer[this.write % this.size] = w;
    this.write++;
    this.last = x;
  }

  /** Read the ring buffer at a fractional (possibly negative) index. */
  private readAt(idx: number): number {
    idx = ((idx % this.size) + this.size) % this.size;
    const i0 = Math.min(this.size - 1, Math.floor(idx));
    const frac = idx - i0;
    const a = this.buffer[i0] ?? 0;
    const b = this.buffer[(i0 + 1) % this.size] ?? 0;
    return a + (b - a) * frac;
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

registerProcessor("pluck-string", PluckStringProcessor);