/**
 * One place to tune the synthesized sound. Adjust the numbers here to taste;
 * every knob maps to a named section of the audio pipeline:
 *
 * - `string`    the Karplus–Strong string model itself (loop damping/excitation).
 * - `voices`    fixed per-string character (wound/dark lows → thin/bright highs),
 *               so each note sounds like a *different* string, not a spread of
 *               one identical voice.
 * - `roles`     persistent accents for the root pitch class vs the color tones.
 * - `attack`    the "pick scrape" highpassed noise transient on note start.
 * - `micro`     random humanization (detune + start-time jitter, base loudness).
 * - `strum`     how far apart successive strings/keys start, so a chord reads
 *               as separate voices instead of one fused pluck. Guitar strums
 *               top string first and adds random jitter like a hand. 
 * - `variation` a thin random ±humanization on top of the systematic voices,
 *               so nothing sounds machine-stamped.
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
  /**
   * Fixed character per guitar string, index 0 = thickest/lowest. These are the
   * *systematic* differences (wound lows vs plain highs) that let the ear pick
   * voices apart; random `variation` only adds a thin humanizing sliver on top.
   */
  voices: {
    /** Noise-burst loudness (0..1): higher = stringier/brighter articulation. */
    brightness: number;
    /** Loop lowpass (0..1): 1 = dull/wound, 0 = bright/glass. */
    damping: number;
    /** Loop gain per sample (0..1): higher = longer ring. */
    sustain: number;
    /** Pitch scoop at the attack for this string (cents); 0 = strike clean. */
    scoopCents: number;
    /** Pick-scrape transient level for this string (0..1). */
    pick: number;
  }[];
  /** Role accents: the root pitch class vs the color tones. */
  roles: {
    /** Velocity multiplier for root-class notes (anchor the harmony). */
    rootVel: number;
    /** Velocity multiplier for color-tone notes. */
    colorVel: number;
    /** Brightness multiplier (root kept slightly darker/weightier). */
    rootBright: number;
    /** Brightness multiplier (color tones sparkle to stay distinct). */
    colorBright: number;
    /** Damping multiplier (root darker). */
    rootDamp: number;
    /** Damping multiplier (color tones brighter). */
    colorDamp: number;
    /** Sustain added to the root so it outlasts the chord (small! near 1). */
    rootSustainAdd: number;
    /** Sustain added to color tones so they decay sooner. */
    colorSustainAdd: number;
    /** Pick-transient multiplier for the root (heavy, less scrape). */
    rootPick: number;
    /** Pick-transient multiplier for color tones (articulate). */
    colorPick: number;
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
    /**
     * Hand-shaped accent, indexed by hit position in the downstroke
     * (0 = first hit, the treble-most string). The k-th hit starts
     * `guitarMs * sum(pattern[0..k-1])` after the base time, so the last
     * entry is the gap that "blooms" into the bass string.
     */
    pattern: number[];
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
  voices: [
    // Low E (wound): dark, heavy, long ring, big attack scoop, soft pick.
    { brightness: 0.38, damping: 0.8, sustain: 0.99993, scoopCents: 26, pick: 0.1 },
    // A (wound): still dark, slightly less so.
    { brightness: 0.52, damping: 0.68, sustain: 0.99989, scoopCents: 18, pick: 0.14 },
    // D (wound): the start of the "plain" mid range.
    { brightness: 0.68, damping: 0.52, sustain: 0.99986, scoopCents: 0, pick: 0.2 },
    // G (plain): brighter, snappier.
    { brightness: 0.84, damping: 0.38, sustain: 0.99983, scoopCents: 0, pick: 0.26 },
    // B (plain): bright and quick.
    { brightness: 0.95, damping: 0.3, sustain: 0.99981, scoopCents: 0, pick: 0.34 },
    // High E (plain): thin, glassy, aggressive pick scrape.
    { brightness: 1.0, damping: 0.22, sustain: 0.99979, scoopCents: 0, pick: 0.42 },
  ],
  roles: {
    rootVel: 1.18,
    colorVel: 1.0,
    rootBright: 0.9,
    colorBright: 1.12,
    rootDamp: 1.15,
    colorDamp: 0.85,
    rootSustainAdd: 0.00005,
    colorSustainAdd: -0.00009,
    rootPick: 0.8,
    colorPick: 1.5,
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
    // Treble bursts out fast, spacing grows into a pause before the bass hits.
    pattern: [0.9, 0.8, 0.8, 0.9, 1.1, 1.4],
  },
  balance: {
    bassBoost: 1.15,
  },
  variation: {
    // Deliberately slim: systematic `voices`/`roles` do the separation now.
    brightnessSpread: 0.06,
    dampingSpread: 0.06,
    sustainSpread: 0.0015,
    velocitySpread: 0.12,
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