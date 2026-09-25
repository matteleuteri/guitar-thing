/**
 * Recorded guitar-body impulse-response helpers. A real guitar's top couples
 * to the strings and resonates at fixed modes — most of "it sounds like a
 * box" — and a *recorded* body IR is the one way that got past the "wobbly
 * synthetic sines" failure (see AGENTS.md progress 13/19). These pure helpers
 * turn a mic recording of a knock/pluck into a normalized, length-capped WAV
 * that the shared graph convolves every string through.
 */

/** Average all channels to mono (a body resonance is basically mono). */
export function mixToMono(buffer: AudioBuffer): Float32Array {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const data = new Float32Array(buffer.length);
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    data[i] = sum / channels.length;
  }
  return data;
}

/** Simple linear resample (body modes are low; linear is plenty). */
export function resampleLinear(x: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return x;
  const len = Math.max(1, Math.round((x.length * dstRate) / srcRate));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = (i / dstRate) * srcRate;
    const i0 = Math.floor(t);
    const i1 = Math.min(x.length - 1, i0 + 1);
    const frac = t - i0;
    out[i] = x[i0] * (1 - frac) + x[i1] * frac;
  }
  return out;
}

/**
 * Cut everything before the first clear transient (the knock/pluck), so room
 * noise or the recording start doesn't poison the convolution. Threshold is
 * `trimDb` dB below the clip peak, with a small must-exceed floor.
 */
export function trimToOnset(x: Float32Array, trimDb: number): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak) peak = Math.abs(x[i]);
  if (peak <= 0) return new Float32Array(1);
  const floor = Math.max(peak * Math.pow(10, trimDb / 20), 2e-5);
  let start = 0;
  for (let i = 2; i < x.length; i++) if (Math.abs(x[i]) > floor) { start = Math.max(0, i - 2); break; }
  return x.slice(start);
}

/** Cap the IR tail length: past that the body has fully decayed. */
export function capLength(x: Float32Array, sampleRate: number, maxMs: number): Float32Array {
  const len = Math.max(1, Math.round((sampleRate * maxMs) / 1000));
  return x.slice(0, len);
}

/** Peak-normalize to `peak` (ConvolverNode runs with `normalize: false`). */
export function normalizePeak(x: Float32Array, peak = 0.999): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  if (m <= 0) return x;
  const scale = peak / m;
  for (let i = 0; i < x.length; i++) x[i] *= scale;
  return x;
}

/**
 * Smooth an IR imported from a laptop mic (progress 19): captures clip and
 * pin full-scale for several ms (a saturated knock's edges read as "static"
 * when convolved into every pluck), while the body's real modes sit low.
 * A one-pole lowpass in the body band removes the clipped edge's hard
 * harmonics; a short raised-cosine attack fade rounds what's left.
 */
export function lowpassOnePole(x: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * Math.max(1, cutoffHz)) / sampleRate);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += a * (x[i] - s);
    y[i] = s;
  }
  return y;
}

/** Raised-cosine attack fade over the first `ms` (kills the pinned edge). */
export function attackFade(x: Float32Array, sampleRate: number, ms: number): Float32Array {
  const m = Math.min(x.length, Math.max(1, Math.round((sampleRate * ms) / 1000)));
  const y = x.slice();
  for (let i = 0; i < m; i++) y[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / m));
  return y;
}

/** 16-bit PCM mono WAV (the format we ship/store IRs and samples in). */
export function encodeWavMono(x: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = x.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const write = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i));
  };
  write(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytesPerSample, true);
  v.setUint16(32, bytesPerSample, true);
  v.setUint16(34, 16, true);
  write(36, "data");
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(44 + i * bytesPerSample, Math.round(s * 32767), true);
  }
  return buf;
}

/** Decode a canonical 16-bit PCM mono WAV (our own `encodeWavMono` format). */
export function decodeWavMono(buf: ArrayBuffer): { pcm: Float32Array; sampleRate: number } {
  const v = new DataView(buf);
  const sampleRate = v.getUint32(24, true);
  const n = v.getUint32(40, true) / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = v.getInt16(44 + i * 2, true) / 32768;
  return { pcm, sampleRate };
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}