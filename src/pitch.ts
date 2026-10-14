export interface PitchResult {
  freq: number;
  midi: number;
  cents: number;
  clarity: number;
  rms: number;
}

/**
 * Monophonic pitch detection over one PCM frame (YIN).
 *
 * The core is the cumulative-mean-normalized difference function:
 *
 *   d(tau)  = sum (x[i] - x[i+tau])^2
 *   d'(tau) = d(tau) / ((1/tau) * sum_{j=1..tau} d(j))
 *
 * and the note is the first tau where d' dips below a threshold. Normalizing
 * by the running mean is what makes it robust: plain autocorrelation peaks
 * again at every multiple of the period and, because a longer lag compares
 * fewer samples, the tallest peak is often an octave (or two) DOWN — the
 * failure that made a 440 Hz tone read as 110 Hz here. The dip is picked
 * first-to-last, so the fundamental wins over its own multiples.
 *
 * Returns the fundamental in Hz, the nearest equal-tempered MIDI note
 * (A4 = 69), the cents offset from it, a 0..1 clarity, and the frame RMS, or
 * null when the frame is silent or too aperiodic to name a note.
 */
export function detectPitch(
  input: Float32Array | any,
  sampleRate: number,
  minFreq = 70,
  maxFreq = 1000
): PitchResult | null {
  if (!input || input.length < 1024) return null;
  const size = Math.min(input.length, 2048);
  const data = input.subarray(0, size) as Float32Array;

  let sumSq = 0;
  for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
  const rms = Math.sqrt(sumSq / data.length);
  if (rms < 0.0005) return null; // ~-66 dB, silence

  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(size - 2, Math.floor(sampleRate / minFreq));
  if (maxLag <= minLag) return null;

  // YIN difference function d(tau).
  const d = new Float64Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    const count = size - tau;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const diff = data[i] - data[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // Cumulative-mean-normalized difference d'(tau); d'(0) := 1.
  const dp = new Float64Array(maxLag + 1);
  dp[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runningSum += d[tau];
    dp[tau] = runningSum > 0 ? (d[tau] * tau) / runningSum : 1;
  }

  // Absolute threshold: the first dip below it is the fundamental period.
  const THRESHOLD = 0.15;
  let tauEstimate = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (dp[tau] < THRESHOLD) {
      // Walk to the bottom of this dip so the estimate is the minimum.
      while (tau + 1 <= maxLag && dp[tau + 1] < dp[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  // No dip below the threshold: fall back to the global minimum if it is
  // still clearly periodic, otherwise give up.
  if (tauEstimate < 0) {
    let best = -1;
    let bestVal = Infinity;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (dp[tau] < bestVal) {
        bestVal = dp[tau];
        best = tau;
      }
    }
    if (best < 0 || bestVal > 0.5) return null;
    tauEstimate = best;
  }

  const clarity = Math.max(0, Math.min(1, 1 - dp[tauEstimate]));
  if (clarity < 0.5) return null;

  // Parabolic interpolation on d' for sub-sample precision.
  let lag = tauEstimate;
  if (tauEstimate > minLag && tauEstimate < maxLag) {
    const c0 = dp[tauEstimate - 1];
    const c1 = dp[tauEstimate];
    const c2 = dp[tauEstimate + 1];
    const denom = c0 - 2 * c1 + c2;
    if (Math.abs(denom) > 1e-12) {
      const delta = (c0 - c2) / (2 * denom);
      if (Math.abs(delta) < 1) lag = tauEstimate + delta;
    }
  }

  const freq = sampleRate / lag;
  if (!isFinite(freq) || freq < minFreq || freq > maxFreq) return null;

  // A4 = 440 Hz, MIDI 69
  const midiFloat = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);

  return { freq, midi, cents, clarity, rms };
}
