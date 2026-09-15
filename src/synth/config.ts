/**
 * One place to tune the synthesized sound. Adjust the numbers here to taste;
 * every knob maps to a named section of the audio pipeline:
 *
 * - `string`    the Karplus–Strong string model itself (loop damping/excitation).
 * - `attack`    the "pick scrape" highpassed noise transient on note start.
 * - `scoop`     low-strings only: a short pitch bend down at the attack.
 * - `micro`     random humanization (detune + start-time jitter, base loudness).
 * - `strum`     how far apart successive strings/keys start, so a chord reads
 *               as separate voices instead of one fused pluck. Guitar strums
 *               top string first and adds random jitter like a hand. 
 * - `variation` random ±brightness/±sustain/±damping/±velocity per note so
 *               strings don't all share one identical timbre.
 * - `panning`   stereo spread (bass strings left, treble right) for separation.
 * - `body`      resonant EQ that colors every note like a guitar's box.
 * - `room`      a short feedback-delay tail so notes ring into a space.
 * - `ring`      how long a note is allowed to keep sounding.
 */

export interface PluckAudioConfig {
  string: {
    /** Loop gain (0..1). Higher = longer sustain per note. */
    sustain: number;
    /** Loudness of the noise burst that "plucks" the string (0..1). */
    brightness: number;
    /** Loop lowpass (0 = bright/long harmonics, 1 = dull/short). */
    damping: number;
    /** Length of that noise burst in ms. */
    excitationMs: number;
  };
  attack: {
    /** Loudness of the extra highpassed pick-scrape transient (0..1). 0 = off. */
    pickLevel: number;
    /** Length of the scrape transient in ms. */
    pickMs: number;
  };
  scoop: {
    /** Pitch bend in cents at the attack (positive = falls from sharp to pitch). */
    cents: number;
    /** How long the bend takes in ms. */
    ms: number;
  };
  micro: {
    /** Max random detune applied to each note, +/- cents. */
    detuneCents: number;
    /** Max random delay of each note's start, ms. */
    jitterMs: number;
    /** Base loudness of a single note (0..~0.6). Chords scale from here. */
    peak: number;
  };
  strum: {
    /** Delay between sounding strings of a guitar voicing, ms. */
    guitarMs: number;
    /** Delay between keys of a piano voicing, ms. */
    pianoMs: number;
    /** Random +/- shift of each string's hit around the strum grid, ms. */
    jitterMs: number;
  };
  /** Per-string velocity / loudness fine-tuning. */
  balance: {
    /** Extra loudness on the thickest string (sounds like the punk of a real hit). */
    bassBoost: number;
  };
  variation: {
    /** Random +/- added to each note's brightness (0..1). */
    brightnessSpread: number;
    /** Random +/- added to each note's loop damping (0..~0.3). */
    dampingSpread: number;
    /** Random +/- added to each note's sustain (0..~0.01). */
    sustainSpread: number;
    /** Random +/- multiplier on each string's velocity (0..~0.5). */
    velocitySpread: number;
  };
  panning: {
    /** Stereo spread 0..1; bass strings panned left, treble right. 0 = mono. */
    spread: number;
  };
  body: {
    /** Chesty low resonance. */
    lowHz: number;
    lowGainDb: number;
    /** The strident "string cutting through" presence peak. */
    presenceHz: number;
    presenceGainDb: number;
  };
  room: {
    /** Feedback delay time in seconds. */
    time: number;
    /** Feedback amount (0..1); too high = ringing/pitched repeats. */
    feedback: number;
    /** Lowpass on the loop so repeats get darker. */
    dampHz: number;
    /** Wet/dry mix of the tail (0..~0.5). */
    wet: number;
  };
  ring: {
    /** Longest ring for the lowest notes, ms. */
    baseMs: number;
    /** Shorter ring per 1 kHz of pitch, ms. */
    perKHzMs: number;
  };
}

export const DEFAULT_CONFIG: PluckAudioConfig = {
  string: {
    /** Loop gain (0..1), per sample. Guitar-like long ring needs ~0.9998+. */
    sustain: 0.99985,
    brightness: 0.85,
    damping: 0.32,
    excitationMs: 8,
  },
  attack: {
    pickLevel: 0.35,
    pickMs: 6,
  },
  scoop: {
    cents: 18,
    ms: 18,
  },
  micro: {
    detuneCents: 5,
    jitterMs: 4,
    peak: 0.5,
  },
  strum: {
    guitarMs: 120,
    pianoMs: 8,
    jitterMs: 24,
  },
  balance: {
    bassBoost: 1.25,
  },
variation: {
    brightnessSpread: 0.2,
    dampingSpread: 0.2,
    sustainSpread: 0.002,
    velocitySpread: 0.25,
  },
  panning: {
    /** Stereo spread 0..1; bass strings panned left, treble right. 0 = mono. */
    spread: 0.9,
  },
  body: {
    lowHz: 200,
    lowGainDb: 1.8,
    presenceHz: 2800,
    presenceGainDb: 1.6,
  },
  room: {
    time: 0.085,
    feedback: 0.45,
    dampHz: 1500,
    wet: 0.2,
  },
  ring: {
    baseMs: 3400,
    perKHzMs: 900,
  },
};