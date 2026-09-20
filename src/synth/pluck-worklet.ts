/**
 * PluckStringProcessor — a Karplus–Strong plucked string that runs on the
 * audio thread. Self-contained on purpose: `src/audio.ts` loads this file via
 * `audioWorklet.addModule()` and never imports it, so its global-scope
 * `registerProcessor` call never executes on the main thread.
 *
 * How it works (read section by section):
 *
 *  1. The buffer starts seeded with a physical pluck, not noise: a triangular
 *     string displacement whose kink sits at the pick position (`pickPos`,
 *     fraction of string length from the bridge). A plucked string releases a
 *     triangle — its spectrum is `sin(n·π·pickPos)/n²`, the shape of how many
 *     harmonics get excited — so each string's timbre is determined by where
 *     the pick strikes, exactly like a real guitar.
 *  2. The buffer is read back as a delay line tuned to the note's period;
 *     reading and writing the same buffer makes it self-resonate (K-S loop).
 *     The fractional part of the period is a first-order allpass, so the
 *     delay tracks pitch smoothly and the loop gets the slight high-partial
 *     sharpening (stiffness) a real string shows.
 *  3. Two-stage loop damping: a one-pole lowpass (`damping`) sets the
 *     sustained brightness, then a second one-pole (`decay`) steepens the loss
 *     so higher partials burn off along a string-like curve — wound lows can
 *     darken fast while plain highs keep a sparkly tail. 0=bright/1=dull per
 *     stage.
 *  4. A separate noise transient adds the pick "scrape" on top of the pitched
 *     triangle onset (a real pick is largely tonal with a splash of noise at
 *     the attack). Each string's scrape carries its own color and length:
 *     the noise is highpassed at a per-string cutoff (`pickBright`) and
 *     fades over a per-string window (`pickDecayMs`), so wound lows scrape
 *     dark and plosive while plain highs snap bright and short — the onsets
 *     separate from the very first sample.
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
  private readonly damping: number;
  /** Second one-pole damping stage: steepens the tail's high-partial loss. */
  private readonly decay: number;
  private sustainLowpass = 0;
  private decayLowpass = 0;
  /** First-order allpass state for the fractional-delay stage. */
  private allpassIn = 0;
  private allpassOut = 0;

  private scrapeLeft = 0;
  private readonly scrapeSamples: number;
  private readonly scrapeLevel: number;
  /** One-pole lowpass state feeding the scrape's highpass (x − lp). */
  private scrapeLowpass = 0;
  /** Per-string scrape highpass cutoff coefficient (0..1). */
  private readonly scrapeCutoff: number;

  private scoopsLeft = 0;

  private readonly ringFrames: number;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    // The AudioWorkletNode options arrive here as the constructor argument
    // (a processor has no `.options` property of its own).
    const params = (options?.processorOptions ?? {}) as Record<string, number | undefined>;
    const freq = Math.max(20, params.freq ?? 110);
    const cents = params.scoopCents ?? 0;
    const scoopMs = params.scoopMs ?? 18;

    this.ringFrames = Math.max(8, params.ringFrames ?? Math.floor(sampleRate * 3));
    this.size = Math.ceil(sampleRate / 16) + 16;
    this.buffer = new Float32Array(this.size);

    this.delayTarget = Math.max(8, sampleRate / freq);
    // Start sharp (shorter delay) and let scoop glide down onto pitch.
    this.delay = this.delayTarget * (1 - cents / 1200);
    this.scoopsLeft = Math.round((sampleRate * scoopMs) / 1000);

    this.sustain = clamp01(params.sustain ?? 0.996);
    this.damping = clamp01(params.damping ?? 0.5);
    this.decay = clamp01(params.decay ?? 0.25);
    const brightness = clamp01(params.brightness ?? 0.85);
    // Where along the string the pick strikes (small = near bridge/bright,
    // large = near nut/fat). This is what makes a voice timbrally distinct by
    // construction: the seeded triangle suppresses harmonics where
    // sin(n·π·pickPos) = 0.
    this.seed(this.delayTarget, clamp01(params.pickPos ?? 0.2), brightness);

    this.scrapeSamples = Math.max(1, Math.round((sampleRate * (params.pickDecayMs ?? params.pickMs ?? 4)) / 1000));
    this.scrapeLevel = clamp01(params.pickLevel ?? 0);
    // Scrape brightness → one-pole highpass cutoff (~350 Hz .. 9 kHz). Dark,
    // plosive lows; near-bridge highs get the full thin "tch".
    const pickBright = clamp01(params.pickBright ?? 0.6);
    const cutoffHz = 350 + (9000 - 350) * Math.pow(pickBright, 1.6);
    this.scrapeCutoff = clamp01(1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate));

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

  /**
   * Seed the delay line with one period of the string's initial *displacement*
   * — a triangle with its kink at the pick position. The first read pass taps
   * buffer[`size - D` .. `size - 1`] as the string's first period, so the
   * harmonics that resonate out of the loop are exactly `sin(n·π·pickPos)/n²`.
   */
  private seed(period: number, pickPosition: number, amplitude: number): void {
    const samples = Math.max(2, Math.round(period));
    const kink = Math.min(0.98, Math.max(0.02, pickPosition));
    const rising = Math.max(1, kink * samples);
    const falling = Math.max(1, samples - kink * samples);
    for (let i = 0; i < samples; i++) {
      const triangle = i < rising ? i / rising : (samples - i) / falling;
      this.buffer[(this.size - samples + i) % this.size] = triangle * amplitude * 0.5;
    }
  }

  /** Advance the string one sample. */
  private step(): void {
    // 1. Attack scoop: glide the (short, sharp) delay up to its pitch period.
    if (this.scoopsLeft > 0) {
      this.scoopsLeft--;
      this.delay += (this.delayTarget - this.delay) / Math.max(1, this.scoopsLeft);
    }

    // 2. Read the delay line at the integer part of the period. The fractional
    //    part becomes a first-order allpass: pitch-exact at DC, and (because
    //    the allpass delays less at high frequencies) the higher partials sit
    //    microscopically sharp, like a real stiff string.
    const integerDelay = Math.max(1, Math.floor(this.delay));
    const delayed = this.readDelayed(this.write - integerDelay);
    const fractional = this.allpass(delayed, this.delay - integerDelay);

    // 3. Two-stage loop damping: `damping` sets the sustained brightness, then
    //    `decay` steepens the loss so high partials burn off earlier — wound
    //    strings can darken fast while plain strings keep a sparkly tail.
    this.sustainLowpass = this.damping * this.sustainLowpass + (1 - this.damping) * fractional;
    this.decayLowpass = this.decay * this.decayLowpass + (1 - this.decay) * this.sustainLowpass;
    let loopOutput = this.decayLowpass * this.sustain;

    // 4. Pick scrape: a short, per-string-shaped noise transient at the onset
    //    only. (The pitched part of the pluck is the seeded triangle, so the
    //    only noise a real pick adds is this scrape.) The noise is highpassed
    //    at this string's own cutoff — wound lows scrape dark and plosive,
    //    plain highs bright and thin — and fades over its own window.
    if (this.scrapeLeft > 0) {
      this.scrapeLeft--;
      const noise = Math.random() * 2 - 1;
      const lowpassed = this.scrapeCutoff * this.scrapeLowpass + (1 - this.scrapeCutoff) * noise;
      this.scrapeLowpass = lowpassed;
      const high = noise - lowpassed;
      const fade = this.scrapeLeft / this.scrapeSamples;
      loopOutput += high * this.scrapeLevel * fade * fade;
    } else {
      this.scrapeLowpass = 0;
    }

    this.buffer[this.write % this.size] = loopOutput;
    this.write++;
    this.last = fractional;
  }

  /**
   * First-order allpass with DC delay = `fraction` samples (0 ≤ fraction < 1):
   * `H(z) = (a + z⁻¹)/(1 + a·z⁻¹)` with `a = (1−fraction)/(1+fraction)`. It lets
   * the loop period land exactly on the fractional delay without the dullness
   * of sample-to-sample interpolation.
   */
  private allpass(sample: number, fraction: number): number {
    const a = (1 - fraction) / (1 + fraction);
    const y = a * sample + this.allpassIn - a * this.allpassOut;
    this.allpassIn = sample;
    this.allpassOut = y;
    return y;
  }

  /** Read the ring buffer at a (possibly negative) integer index. */
  private readDelayed(index: number): number {
    index = ((index % this.size) + this.size) % this.size;
    return this.buffer[index] ?? 0;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

registerProcessor("pluck-string", PluckStringProcessor);