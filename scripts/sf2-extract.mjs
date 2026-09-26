/**
 * sf2-extract.mjs — offline SoundFont 2.04 → per-note WAV extractor (Phase A).
 *
 * One-off tool for the MuseScore-General-kit plan (see AGENTS.md backlog):
 * this reads a .sf2 bank, resolves a preset's zones (key/velocity ranges,
 * sample id, root key / pitch correction), decodes the PCM samples, renders
 * each requested note by resampling to the exact target pitch, and writes the
 * note as a one-shot mono WAV once per velocity layer — with each layer's
 * brightness "baked" by a lowpass that emulates the SF2 default
 * velocity→filter-cutoff behaviour (heuristic; the real MuseScore General
 * modulators will refine this later).
 *
 * WHY: the shipped smplr kits decode all 88 notes (A0..C8, 2.6 MB) on every
 * page load, but the guitar can only sound MIDI 40..88 at frets 0..24 — so
 * over half that download and decode budget is unreachable notes. This
 * compiles a bank down to exactly the notes the app can play.
 *
 * The slice is a PROTOTYPE until the real bank is auditioned by ear: Phase A
 * is the six open strings (40,45,50,55,59,64) of one steel preset.
 *
 * The DSP (resample / lowpass / fade / normalize / WAV) is imported from the
 * app's compiled `dist/synth/ir.js` rather than reimplemented, so the baked
 * filter is provably the same one the app uses. Run `npm run build` first.
 *
 * NEVER imported by the app (Node-only). Output goes to a scratch dir.
 *
 * Usage:   node scripts/sf2-extract.mjs <bank.sf2> <presetBank> <presetProg> \
 *              --notes 40,45,50,55,59,64 --out scratch/slice/v{1,2,3} \
 *              --layers 3
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// The app's own pure DSP helpers, from the compiled output — so the extractor's
// resampling / lowpass / fade / normalize / WAV writer are provably the SAME
// code the app uses, not a second implementation that can drift.
let resampleLinear, lowpassOnePole, attackFade, normalizePeak, encodeWavMono;
try {
  ({ resampleLinear, lowpassOnePole, attackFade, normalizePeak, encodeWavMono } =
    await import(new URL("../dist/synth/ir.js", import.meta.url)));
} catch (error) {
  console.error("could not load dist/synth/ir.js — run `npm run build` first.");
  throw error;
}

// ---------------------------------------------------------------------------
// SF2 binary reading
// ---------------------------------------------------------------------------

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

/** Walk the top-level RIFF chunk list, returning { fourcc, start, size }[] */
function riffChunks(buf) {
  if (fourcc(buf, 0) !== "RIFF") throw new Error("not a RIFF file: " + fourcc(buf, 0));
  if (fourcc(buf, 8) !== "sfbk") throw new Error("not an SF2: " + fourcc(buf, 8));
  const chunks = [];
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = fourcc(buf, o);
    const size = u32(buf, o + 4);
    chunks.push({ id, start: o + 8, size });
    o += 8 + size + (size % 2); // chunks are word-aligned
  }
  return chunks;
}

/**
 * Sub-chunks of a LIST chunk. `listStart` points at the LIST's 4-byte *type*
 * ("pdta"/"sdta") — the sub-chunks begin AFTER it, and `listSize` includes
 * those 4 bytes. Starting the walk at `listStart` reads "pdta" as a sub-chunk
 * id and the whole list parses as garbage.
 */
function listSubChunks(buf, listStart, listSize) {
  const out = [];
  let o = listStart + 4;
  const end = listStart + listSize;
  while (o + 8 <= end) {
    const id = fourcc(buf, o);
    const s = u32(buf, o + 4);
    out.push({ id, start: o + 8, s });
    o += 8 + s + (s % 2); // chunks are word-aligned
  }
  return out;
}

class Sf2 {
  constructor(buf) {
    this.buf = buf;
    const chunks = riffChunks(buf);
    // A top-level LIST chunk's id is always "LIST"; the type ("pdta"/"sdta")
    // is the first four bytes INSIDE it — matching on c.id === "pdta" never
    // fires and the bank looks like it has no pdta at all.
    const listOf = (type) => chunks.find((c) => c.id === "LIST" && fourcc(buf, c.start) === type) ?? null;
    const pdta = listOf("pdta");
    if (!pdta) throw new Error("no pdta LIST");
    for (const c of listSubChunks(buf, pdta.start, pdta.size)) this[c.id] = c;
    this.sdta = listOf("sdta");
    if (this.sdta) for (const c of listSubChunks(buf, this.sdta.start, this.sdta.size)) this[c.id] = c;

    this.phdr = this.records("phdr", 38, this.readPhdr.bind(this));
    this.pbag = this.records("pbag", 4, (b, o) => ({ gen: u16(b, o), mod: u16(b, o + 2) }));
    this.pmod = this.records("pmod", 10, (b, o) => ({
      src: u16(b, o), srcAmount: u16(b, o + 2), amt: b.readInt16LE(o + 4),
      dst: u16(b, o + 6), trans: u16(b, o + 8),
    }));
    this.pgen = this.records("pgen", 4, (b, o) => ({ op: u16(b, o), amt: b.readInt16LE(o + 2) }));
    this.inst = this.records("inst", 22, (b, o) => ({ name: this.cstr(b, o, 20), bag: u16(b, o + 20) }));
    this.ibag = this.records("ibag", 4, (b, o) => ({ gen: u16(b, o), mod: u16(b, o + 2) }));
    this.igen = this.records("igen", 4, (b, o) => ({ op: u16(b, o), amt: b.readInt16LE(o + 2) }));
    this.imod = this.records("imod", 10, (b, o) => ({
      src: u16(b, o), srcAmount: u16(b, o + 2), amt: b.readInt16LE(o + 4),
      dst: u16(b, o + 6), trans: u16(b, o + 8),
    }));
    this.shdr = this.records("shdr", 46, this.readShdr.bind(this));
  }

  records(name, recSize, read) {
    const rc = this[name];
    if (!rc) return [];
    const n = Math.floor(rc.s / recSize);
    const out = [];
    for (let i = 0; i < n; i++) out.push(read(this.buf, rc.start + i * recSize));
    return out;
  }

  cstr(b, o, n) {
    let s = "";
    for (let i = 0; i < n; i++) {
      const c = b[o + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  readPhdr(b, o) {
    return {
      name: this.cstr(b, o, 20),
      preset: u16(b, o + 20),
      bank: u16(b, o + 22),
      bag: u16(b, o + 24),
      library: u32(b, o + 26), genre: u32(b, o + 30), morpho: u32(b, o + 34),
    };
  }

  readShdr(b, o) {
    return {
      name: this.cstr(b, o, 20),
      start: u32(b, o + 20),
      end: u32(b, o + 24),
      startLoop: u32(b, o + 28),
      endLoop: u32(b, o + 32),
      sampleRate: u32(b, o + 36),
      originalPitch: b[o + 40],
      pitchCorr: b.readInt8(o + 41),
      link: u16(b, o + 42),
      type: u16(b, o + 44),
    };
  }

  /** Decode mono 16-bit PCM for a sample header. */
  pcm(shdr) {
    const smpl = this.smpl; // sub-chunk of the sdta LIST
    if (!smpl) throw new Error("no smpl chunk");
    const start = smpl.start + shdr.start * 2;
    const end = smpl.start + shdr.end * 2;
    const frames = Math.max(0, Math.floor((end - start) / 2));
    const out = new Float32Array(frames);
    const b = this.buf;
    for (let i = 0; i < frames; i++) out[i] = b.readInt16LE(start + i * 2) / 32768;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Generator / zone resolution
// ---------------------------------------------------------------------------

const OP = Object.freeze({
  startAddrs: 0, endAddrs: 1, initialFilterFc: 8, initialFilterQ: 9,
  coarseTune: 49, fineTune: 50, pan: 17, initialAtten: 46, keyRange: 41,
  velRange: 42, sampleModes: 52, sampleID: 51, overrideRoot: 56, scaleTuning: 54,
  exclusive: 55,
});

/** Pack/unpack a keyRange/velRange amount (low byte = low, high byte = high). */
function rangeOf(amt) {
  return { lo: amt & 0xff, hi: (amt >> 8) & 0xff };
}

/** Each bag's records are a contiguous run; zones inside are split on the
 *  endOper separator (58). We fold the first zone of a bag-without-sample
 *  (global) into the zone defaults. */
function zonesFor(gens, bagIndex, nextBagIndex) {
  const zones = [];
  let cur = null;
  const finalize = () => {
    if (cur && cur.sampleId >= 0) zones.push(cur);
    cur = null;
  };
  for (let i = bagIndex; i < nextBagIndex; i++) {
    const g = gens[i];
    if (!cur) cur = { sampleId: -1, keyLo: 0, keyHi: 127, velLo: 1, velHi: 127, baseZone: false, gens: new Map() };
    if (g.op === 58) { finalize(); continue; }                 // endOper separator
    cur.baseZone = cur.baseZone || g.op !== OP.sampleID;       // not yet a sample zone
    cur.gens.set(g.op, g.amt);
    if (g.op === OP.keyRange || g.op === OP.velRange) {
      const r = rangeOf(g.amt & 0xffff);
      if (g.op === OP.keyRange) { cur.keyLo = r.lo; cur.keyHi = r.hi; }
      else { cur.velLo = Math.max(1, Math.min(127, r.lo)); cur.velHi = Math.min(127, r.hi); }
    }
    if (g.op === OP.sampleID) cur.sampleId = g.amt;
  }
  finalize();
  return zones;
}

/** The generator defaults that apply to every zone of a preset/instrument.
 *
 *  A "global" zone is one that carries no sampleID, and per the spec it
 *  supplies defaults to the zones that FOLLOW it in the same
 *  preset/instrument (not just the ones inside its own bag). An endOper
 *  separator or a sampleID both terminate a global run. Later values win. */
function globalGens(gens, from, to) {
  const merged = new Map();
  let inGlobal = false;
  for (let i = from; i < to; i++) {
    const g = gens[i];
    if (g.op === 58 || g.op === OP.sampleID) { inGlobal = false; continue; }
    inGlobal = true;
    merged.set(g.op, g.amt);
  }
  return merged;
}

/** Later maps win: instrument global < instrument zone < preset global < preset zone. */
function mergeGens(...maps) {
  const out = new Map();
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  return out;
}

/** Clamp a key range intersection to something playable (0..127). */
function intersect(loA, hiA, loB, hiB) {
  return { lo: Math.max(loA, loB), hi: Math.min(hiA, hiB) };
}

/**
 * Read a generator amount with the right signedness. Almost every SF2
 * generator is a signed 16-bit value, but startAddrs/endAddrs (0/1) are
 * UNSIGNED sample offsets — reading a 44100-frame sample's end as signed
 * yields a negative offset and an empty slice.
 */
const UNSIGNED_GENS = new Set([OP.startAddrs, OP.endAddrs]);
function genAmt(gens, op) {
  const amt = gens.get(op);
  if (amt === undefined) return undefined;
  return UNSIGNED_GENS.has(op) && amt < 0 ? amt + 0x10000 : amt;
}

/**
 * Resolve a preset to a flat list of playable regions, each with its merged
 * generators, effective key/velocity range and the sample header it points at.
 *
 * The subtlety that makes real banks work: a *preset* zone's sampleID (51)
 * names an INSTRUMENT, while an *instrument* zone's sampleID names a sample.
 * So a playable region is a preset zone × an instrument zone pair, and ranges
 * intersect down the chain.
 *
 * A `wBagNdx` is the index of the entry's FIRST bag, and the entry owns every
 * bag from there up to the NEXT entry's first bag (the trailing EOP entry marks
 * the end of the table) — so the bag span must be taken from the neighbouring
 * *record*, not from `bag + 1`, which would stop at the entry's second bag and
 * drop most of its zones.
 */
function presetRegions(sf, bank, program) {
  const regions = [];
  for (let pi = 0; pi < sf.phdr.length; pi++) {
    const preset = sf.phdr[pi];
    if (preset.bank !== bank || preset.preset !== program) continue;
    const pFrom = sf.pbag[preset.bag].gen;
    const pTo = pi + 1 < sf.phdr.length ? sf.pbag[sf.phdr[pi + 1].bag].gen : sf.pgen.length;
    const pGlobal = globalGens(sf.pgen, pFrom, pTo);

    for (const pZone of zonesFor(sf.pgen, pFrom, pTo)) {
      if (pZone.sampleId < 0) continue;
      const ii = pZone.sampleId;
      const inst = sf.inst[ii];
      if (!inst) throw new Error(`preset zone references missing instrument ${ii}`);

      const iFrom = sf.ibag[inst.bag].gen;
      const iTo = ii + 1 < sf.inst.length ? sf.ibag[sf.inst[ii + 1].bag].gen : sf.igen.length;
      const iGlobal = globalGens(sf.igen, iFrom, iTo);

      for (const iZone of zonesFor(sf.igen, iFrom, iTo)) {
        if (iZone.sampleId < 0) continue;
        const shdr = sf.shdr[iZone.sampleId];
        if (!shdr) throw new Error(`instrument zone references missing sample ${iZone.sampleId}`);
        const key = intersect(pZone.keyLo, pZone.keyHi, iZone.keyLo, iZone.keyHi);
        const vel = intersect(pZone.velLo, pZone.velHi, iZone.velLo, iZone.velHi);
        if (key.lo > key.hi || vel.lo > vel.hi) continue; // ranges don't overlap
        regions.push({
          keyLo: key.lo, keyHi: key.hi, velLo: vel.lo, velHi: vel.hi,
          shdr, instName: inst.name, presetName: preset.name,
          gens: mergeGens(iGlobal, iZone.gens, pGlobal, pZone.gens),
        });
      }
    }
  }
  if (!regions.length) {
    throw new Error(`preset bank ${bank} prog ${program} resolved to no playable zones`);
  }
  return regions;
}

// ---------------------------------------------------------------------------
// Default modulators (baked statically — a sliced WAV cannot evaluate them)
// ---------------------------------------------------------------------------

/** velocity → initial attenuation. The SF2 default is a concave, negative,
 *  unipolar modulator of 960 cB: quiet notes are attenuated most, loud notes
 *  pass ~untouched. Returns cB. */
function defaultAttenuationCb(vel) {
  const x = Math.min(1, Math.max(0, vel / 127));
  return 960 * (1 - x * x);
}

/** velocity → initial filter cutoff. The SF2 default is concave/negative at
 *  −2400 cB, so harder playing opens the filter. `fcCents` is the zone's
 *  initialFilterFc (absent = no zone filtering, which this naturally no-ops by
 *  clamping to Nyquist). Returns Hz, clamped to the audible band. */
function defaultCutoffHz(fcCents, vel, sampleRate) {
  if (fcCents === undefined) return sampleRate / 2;
  const x = Math.min(1, Math.max(0, vel / 127));
  const cents = fcCents - 2400 * (1 - x * x);
  return Math.min(sampleRate / 2 - 100, Math.max(20, 440 * Math.pow(2, cents / 1200)));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Pick the region that a (key, velocity) pair plays. First match wins, which
 *  is the highest-priority zone; banks with genuinely split/overlapping zones
 *  would need the full zone-cascade, so warn loudly if the choice is ambiguous. */
function regionFor(regions, key, vel) {
  const hits = regions.filter((r) => key >= r.keyLo && key <= r.keyHi && vel >= r.velLo && vel <= r.velHi);
  if (!hits.length) return null;
  if (hits.length > 1) {
    const uniq = new Set(hits.map((r) => r.shdr.name));
    if (uniq.size > 1) {
      console.warn(`  ! key ${key} vel ${vel}: ${hits.length} overlapping zones (${[...uniq].join(", ")}) — using the first`);
    }
  }
  return hits[0];
}

/** Fade the last `ms` of a buffer to zero so a cut sample cannot click. */
function fadeOut(x, sampleRate, ms) {
  const n = Math.min(x.length, Math.max(1, Math.round((ms / 1000) * sampleRate)));
  for (let i = 0; i < n; i++) x[x.length - n + i] *= 0.5 * (1 + Math.cos((Math.PI * i) / n));
  return x;
}

/**
 * Render one (region, key, velocity) note as a one-shot mono buffer at
 * `outRate`, resampled to the exact target pitch.
 *
 * Sliced in the SOURCE domain first (loop-end bounds are source frames, and
 * it's cheaper), then reinterpreted as playing at `sampleRate * m` and
 * resampled to `outRate` — which does the pitch shift and the sample-rate
 * conversion in one pass.
 */
function renderNote(sf, region, key, vel, outRate, maxMs) {
  const shdr = region.shdr;
  const g = region.gens;

  // Zone bounds are RELATIVE to the sample header's dwStart (sf.pcm() returns
  // the sample's own data, indexed from 0), while the header's loop points are
  // absolute smpl offsets — so the loop end needs the same shift.
  const start = genAmt(g, OP.startAddrs) ?? 0;
  const end = genAmt(g, OP.endAddrs) ?? (shdr.end - shdr.start);
  if (end <= start) return null;

  // A one-shot ends where the loop would have restarted: the loop-end is the
  // sample's natural "one strum" length. Clamp it to the sample's real end.
  let stop = end;
  const loopEnd = shdr.endLoop - shdr.start;
  if (loopEnd > start && loopEnd <= end) stop = loopEnd;
  if (maxMs && shdr.sampleRate > 0) {
    stop = Math.min(stop, start + Math.round((maxMs / 1000) * shdr.sampleRate));
  }

  const pcm = sf.pcm(shdr);
  const slice = pcm.subarray(start, Math.min(stop, pcm.length));
  if (slice.length < 32) return null;

  // Pitch: (key - rootKey) × scaleTuning + coarse/fine/correction, all in cents.
  const rootKey = genAmt(g, OP.overrideRootKey) ?? shdr.originalPitch;
  const cents =
    (key - rootKey) * (genAmt(g, OP.scaleTuning) ?? 100) +
    (genAmt(g, OP.coarseTune) ?? 0) * 100 +
    (genAmt(g, OP.fineTune) ?? 0) +
    shdr.pitchCorr;
  const m = Math.pow(2, cents / 1200);
  const srcRate = shdr.sampleRate * m;

  let out = resampleLinear(slice, srcRate, outRate);
  if (!out || out.length < 32) return null;

  // Static bake of what the engine would have modulated per note.
  out = lowpassOnePole(out, outRate, defaultCutoffHz(genAmt(g, OP.initialFilterFc), vel, outRate));
  // initialAttenuation is in cB (tenths of a dB); add the default velocity curve.
  const attenCb = (genAmt(g, OP.initialAttenuation) ?? 0) + defaultAttenuationCb(vel);
  const gain = Math.pow(10, -attenCb / 20 / 10);
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  if (g.has(OP.pan)) {
    const pan = Math.max(-1, Math.min(1, genAmt(g, OP.pan) / 500));
    for (let i = 0; i < out.length; i++) out[i] *= (1 - pan * 0.5) * (1 - Math.abs(pan) * 0.15);
  }

  out = attackFade(out, outRate, 2);
  out = fadeOut(out, outRate, 12);
  return normalizePeak(out, 0.999);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

function noteLabel(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Representative velocity for layer `i` of `n`: the TOP of each equal bucket,
 *  so layer n is the loudest/brightest and every layer is an achievable hit. */
function layerVelocity(i, n) {
  return Math.round((127 * (i + 1)) / n);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    flags[a.slice(2)] = argv[++i];
  }
  return { positional, flags };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 3) {
    console.error(fsUsage());
    process.exit(2);
  }
  const bankPath = positional[0];
  const bank = Number(positional[1]);
  const program = Number(positional[2]);
  if (!Number.isFinite(bank) || !Number.isFinite(program)) {
    console.error("presetBank and presetProg must be numbers");
    process.exit(2);
  }

  const notes = (flags.notes ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (!notes.length) {
    console.error("--notes is required, e.g. --notes 40,45,50,55,59,64");
    process.exit(2);
  }
  const layers = Math.max(1, Number(flags.layers ?? 1));
  const outRate = Number(flags.rate ?? 44100);
  const maxMs = flags["max-ms"] ? Number(flags["max-ms"]) : undefined;
  const outTemplate = flags.out ?? "scratch/slice";

  if (!existsSync(bankPath)) {
    console.error(`no such bank: ${bankPath}`);
    process.exit(2);
  }

  // NOTE: `buf` must stay a Node Buffer, not a bare Uint8Array/ArrayBuffer —
  // the record readers below index it (fourcc/u16/u32) AND call its
  // readInt16LE/readInt8, which only exist on Buffer. A Buffer IS a Uint8Array,
  // so both styles work; passing `.buffer` (an ArrayBuffer) silently reads
  // undefined and reports "not a RIFF file" on a perfectly good bank.
  const sf = new Sf2(readFileSync(resolve(bankPath)));
  const regions = presetRegions(sf, bank, program);

  const covered = new Set(regions.map((r) => `${r.keyLo}-${r.keyHi}/${r.velLo}-${r.velHi}`));
  console.log(`bank ${bankPath}: ${sf.shdr.length} samples, ${sf.inst.length} instruments`);
  console.log(`preset bank ${bank} prog ${program} → ${regions.length} playable zones`);
  console.log(`  key/vel coverage: ${[...covered].join("  ")}`);
  console.log(`slicing ${notes.length} note(s) × ${layers} layer(s) @ ${outRate} Hz\n`);

  const written = [];
  for (let l = 1; l <= layers; l++) {
    const vel = layerVelocity(l - 1, layers);
    // "--out dir/v{1,2,3}" expands to one directory per layer.
    const dir = resolve(outTemplate.replace(/\{[^}]*\}/g, String(l)));
    mkdirSync(dir, { recursive: true });
    for (const midi of notes) {
      const region = regionFor(regions, midi, vel);
      if (!region) {
        console.warn(`  ${noteLabel(midi)} v${vel}: no zone covers key ${midi} — skipped`);
        continue;
      }
      const pcm = renderNote(sf, region, midi, vel, outRate, maxMs);
      if (!pcm) {
        console.warn(`  ${noteLabel(midi)} v${vel}: empty render — skipped`);
        continue;
      }
      const file = resolve(dir, `${noteLabel(midi)}_v${vel}.wav`);
      writeFileSync(file, Buffer.from(encodeWavMono(pcm, outRate)));
      written.push({ file, samples: pcm.length, seconds: pcm.length / outRate });
      console.log(
        `  v${String(vel).padStart(3)}  ${noteLabel(midi).padEnd(4)} ` +
        `${(pcm.length / outRate).toFixed(2)}s  <- "${region.shdr.name}" root ${genAmt(region.gens, OP.overrideRootKey) ?? region.shdr.originalPitch}`,
      );
    }
  }

  const bytes = written.reduce((n, w) => n + statSync(w.file).size, 0);
  console.log(`\n${written.length} WAV(s), ${(bytes / 1024).toFixed(0)} KB total`);
}

function fsUsage() {
  return [
    "usage: node scripts/sf2-extract.mjs <bank.sf2> <presetBank> <presetProg> \\",
    "           --notes 40,45,50,55,59,64 --out scratch/slice/v{1,2,3} --layers 3",
    "",
    "  --notes    comma-separated MIDI notes to render (required)",
    "  --out      output path; a {…} placeholder is replaced by the layer index",
    "  --layers   velocity layers to bake (default 1; the top layer is full velocity)",
    "  --rate     output sample rate (default 44100)",
    "  --max-ms   cap each one-shot's length (default: the sample's loop end)",
  ].join("\n");
}

main();