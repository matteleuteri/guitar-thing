/**
 * Real-guitar sample bank (progress 20): the app plays guitar voicings from
 * six recorded open-string samples instead of the K–S synth — literally the
 * user's guitar. A sample is captured once in the debug harness, then any
 * fretted note is played by transposing to the *nearest recorded string* via
 * playback rate, so with a full six-string bank the worst shift is ~±2-4
 * semitones and nothing reads as a chipmunk.
 *
 * State only — Web-Audio scheduling of the samples lives in `audio.ts`
 * (`scheduleSampleVoice`), which reads the bank through `nearestSample`.
 */

import { DEFAULT_CONFIG } from "./config.js";
import {
  trimToOnset,
  resampleLinear,
  encodeWavMono,
  decodeWavMono,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from "./ir.js";

/** Storage/playback rate for samples: 24 kHz mono keeps the whole bank under
 *  localStorage's ~5 MB while still covering the strings' harmonics. */
const SAMPLE_SR = 24000;
const STORAGE_KEY = "guitar-thing.string-samples";

export interface StringSample {
  /** Which string this started as (0 = thickest/lowest). */
  stringIndex: number;
  /** MIDI of the recorded open string (its identity for pitch mapping). */
  midi: number;
  /** Mono PCM, already onset-trimmed, tail-capped, faded and normalized. */
  pcm: Float32Array;
  sampleRate: number;
}

const bank: (StringSample | null)[] = Array(6).fill(null);

/** Fade the last `ms` to silence so a capped sample never clicks at its end. */
function tailFade(x: Float32Array, sampleRate: number, ms: number): Float32Array {
  const y = x.slice();
  const m = Math.min(y.length, Math.max(1, Math.round((sampleRate * ms) / 1000)));
  for (let i = 0; i < m; i++) {
    const p = i / m;
    y[y.length - 1 - i] *= 0.5 * (1 - Math.cos(Math.PI * p));
  }
  return y;
}

/** A plucked string decays smoothly, so a 10 ms bin that sits way above its
 *  immediate neighbours in the *tail half* of a capture is a stop-click, not
 *  music. Zero those bins (the ring is already faint there) so a click never
 *  pops out of the end of a long-held note. */
function scrubTailClicks(x: Float32Array): Float32Array {
  const step = Math.floor(SAMPLE_SR * 0.01);
  const half = Math.floor(x.length / 2);
  for (let q = Math.max(step * 4, half); q + step <= x.length; q += step) {
    let sm = 0;
    for (let i = q; i < q + step; i++) sm += x[i] * x[i];
    const e = Math.sqrt(sm / step);
    const prev: number[] = [];
    for (let k = 1; k <= 4; k++) {
      let psm = 0;
      for (let i = q - k * step; i < q - (k - 1) * step && i >= 0; i++) psm += x[i] * x[i];
      prev.push(Math.sqrt(psm / Math.max(1, step)));
    }
    prev.sort((a, b) => a - b);
    if (e > Math.max(prev[2] * 6, 1e-3)) {
      for (let i = q; i < q + step; i++) x[i] = 0;
    }
  }
  return x;
}

/** Turn a raw pluck recording into a playable sample. Laptop mics pump an
 *  AGC on the quiet lead-in before the pluck ("swell"), so instead of trimming
 *  at a fixed dB floor we find the *sharpest* envelope rise (the pluck itself)
 *  and start there; and a stop-click logged at the very end of the clip must
 *  not skew the normalization, so level is scaled to the sample peak of the
 *  bulk (first 95%) rather than the clip's absolute max, and tail clicks are
 *  scrubbed outright. High strings decay fast, so their tail caps are short;
 *  the lows keep ringing. */
export function processSample(
  pcm: Float32Array,
  sampleRate: number,
  stringIndex: number,
  midi: number,
): StringSample {
  const { maxMs, minMs } = DEFAULT_CONFIG.samples;
  const trimmed = trimToOnset(pcm, -45);
  const resampled = resampleLinear(trimmed, sampleRate, SAMPLE_SR);

  // 10 ms RMS envelope, to locate the real transient under AGC swelling.
  const step = Math.floor(SAMPLE_SR * 0.01);
  const env: number[] = [];
  for (let q = 0; q < resampled.length; q += step) {
    let sm = 0;
    const c = Math.min(step, resampled.length - q);
    for (let i = q; i < q + c; i++) sm += resampled[i] * resampled[i];
    env.push(Math.sqrt(sm / c));
  }
  let startBin = 0;
  // Find the onset by *cumulative energy*: the pluck is where the clip's
  // energy count leaves the baseline. Laptop AGC swells the lead-in and a
  // stop-click spikes the very end, but both hold only a few percent of the
  // total energy — the real transient is unmistakeable as the first time the
  // running sum crosses 5% of the whole clip. (A plain "steepest rise" latch
  // onto the end-of-clip click once AGC flattened the attack.)
  let total = 0;
  for (const e of env) total += e * e;
  if (total > 0) {
    let acc = 0;
    for (let i = 0; i < env.length; i++) {
      acc += env[i] * env[i];
      if (acc >= total * 0.05) {
        startBin = Math.max(0, i - 2);
        break;
      }
    }
  }

  const capMs = Math.max(minMs, maxMs - (midi - 40) * 400);
  const capSamples = Math.round((SAMPLE_SR * capMs) / 1000);
  const from = startBin * step;
  const cutEnd = Math.min(resampled.length, from + capSamples);
  const sliced = new Float32Array(Math.max(0, cutEnd - from));
  sliced.set(resampled.subarray(from, cutEnd));
  const body = tailFade(scrubTailClicks(sliced), SAMPLE_SR, 120);

  // Normalize to the sample peak of the first 95% — a stop-click in the last
  // 5% must not shrink the whole note — then clamp any overshoot (that click).
  let bulkPeak = 0;
  const cut = Math.floor(body.length * 0.95);
  for (let i = 0; i < cut; i++) {
    const a = Math.abs(body[i]);
    if (a > bulkPeak) bulkPeak = a;
  }
  const scale = 0.95 / Math.max(bulkPeak, 1e-9);
  for (let i = 0; i < body.length; i++) {
    body[i] = Math.max(-1, Math.min(1, body[i] * scale));
  }

  return {
    stringIndex,
    midi,
    pcm: body,
    sampleRate: SAMPLE_SR,
  };
}

/** Store + persist one string's sample. */
export function setSample(stringIndex: number, midi: number, pcm: Float32Array, sampleRate: number): void {
  bank[stringIndex] = processSample(pcm, sampleRate, stringIndex, midi);
  persist();
}

/** Drop every recorded sample (back to pure synth). */
export function clearSamples(): void {
  for (let i = 0; i < bank.length; i++) bank[i] = null;
  persist();
}

export function sampleAt(stringIndex: number): StringSample | null {
  return bank[stringIndex] ?? null;
}

/** Any sample recorded? */
export function hasSamples(): boolean {
  return bank.some((s) => s !== null);
}

export interface NearestMatch {
  sample: StringSample;
  stringIndex: number;
  /** Semitones to transpose the sample to hit the target note. */
  shift: number;
}

/** The recorded string whose open note is closest to `midi` in pitch (tie →
 *  prefer the same string, so a fretted note on its own string wins). Falls
 *  back to the synth when nothing is close enough or samples are disabled. */
export function nearestSample(midi: number): NearestMatch | null {
  const { enabled, maxShift } = DEFAULT_CONFIG.samples;
  if (!enabled) return null;
  let best: { index: number; shift: number } | null = null;
  for (let i = 0; i < bank.length; i++) {
    const s = bank[i];
    if (!s) continue;
    const shift = midi - s.midi;
    if (Math.abs(shift) > maxShift) continue;
    if (!best) {
      best = { index: i, shift };
      continue;
    }
    const compete = (a: number, b: number): number => {
      const da = Math.abs(a), db = Math.abs(b);
      if (da !== db) return da - db;
      // Same pitch distance: same-string samples win; otherwise the lower string.
      return (a === 0 ? -1 : 1) - (b === 0 ? -1 : 1);
    };
    if (compete(shift, best.shift) < 0) best = { index: i, shift };
  }
  return best ? { sample: bank[best.index]!, stringIndex: best.index, shift: best.shift } : null;
}

interface Stored {
  sr: number;
  samples: ({ midi: number; wav: string } | null)[];
}

function persist(): void {
  try {
    const record: Stored = {
      sr: SAMPLE_SR,
      samples: bank.map((s) =>
        s ? { midi: s.midi, wav: arrayBufferToBase64(encodeWavMono(s.pcm, s.sampleRate)) } : null,
      ),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* storage full/unavailable — the bank just won't survive a reload */
  }
}

/** Best-effort: restore a bank the user recorded on this origin. No
 *  shipped-asset fallback — the six-bedroom-laptop-mic bank (progress 20) was
 *  verdicted "just not sounding good", so a fresh origin gets the K–S synth
 *  rather than a single mismatched E2 sample playing everything. */
export async function loadStoredSamples(): Promise<void> {
  const load = ({ pcm, sampleRate }: { pcm: Float32Array; sampleRate: number }, midi: number, i: number): void => {
    bank[i] = processSample(pcm, sampleRate, i, midi);
  };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const record = JSON.parse(stored) as Stored;
      (record.samples ?? []).forEach((entry, i) => {
        if (entry) load(decodeWavMono(base64ToArrayBuffer(entry.wav)), entry.midi, i);
      });
    }
  } catch {
    /* corrupt/old format — plain synth, as expected */
  }
}

export interface SampleBankStatus {
  enabled: boolean;
  /** One entry per string; `null` when that string has no sample. */
  samples: ({ midi: number; ms: number } | null)[];
}
export function sampleStatus(): SampleBankStatus {
  return {
    enabled: DEFAULT_CONFIG.samples.enabled,
    samples: bank.map((s) =>
      s ? { midi: s.midi, ms: Math.round((s.pcm.length / s.sampleRate) * 1000) } : null,
    ),
  };
}

/** A single string's sample as a WAV Blob (to save/commit as an asset). */
export function sampleWav(stringIndex: number): Blob | null {
  const s = bank[stringIndex];
  if (!s) return null;
  return new Blob([encodeWavMono(s.pcm, s.sampleRate)], { type: "audio/wav" });
}