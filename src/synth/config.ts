/**
 * One place to tune the synthesized sound. Adjust the numbers here to taste;
 * every knob maps to a named section of the audio pipeline:
 *
 * - `string`    fallback string model knobs used by notes that don't declare
 *               their own identity (single fretboard dots) — sustain/brightness/
 *               damping of the K–S loop.
 * - `voices`    fixed per-string identity (wound/dark lows → thin/bright highs)
 *               — each string gets its own pickup-style EQ, attack envelope,
 *               brightness/damping/decay/sustain/scoop/pick, a `pickPos` where
 *               the pick strikes (commuted-synthesis pluck seed), and its own
 *               scrape transient (`pickBright`/`pickDecayMs`). The core of
 *               "each string makes its own sound".
 * - `piano`     the guitar `voices` idea for keys: a note's identity comes from
 *               its register (dark thumpy bass → bright snappy treble), so the
 *               notes of a piano voicing ring apart instead of fusing.
 * - `roles`     persistent accents for the root pitch class vs the color tones.
 * - `attack`    the "pick scrape" highpassed noise transient on note start.
 * - `life`      the string is never a static oscillator: a slow amplitude+pitch
 *               wobble (random phase per note) keeps the tone breathing.
 * - `thump`     the top/bridge reacting to the pluck: a brief low-frequency
 *               "box hit", strongest on the wound strings.
 * - `bloom`     the attack bloom (progress 17): each onset starts brighter and
 *               a bit louder, then settles into the string's sustained tone
 *               over ~0.4 s — a real pluck sheds its bright transient energy
 *               fast (measured: highs sit 10..25 dB down within a second).
 * - `ir`        the recorded body IR mix (progress 19): dry/IR wet level. The
 *               IR itself is a recording, never a knob.
 * - `samples`   real-guitar sample playback (progress 20): recorded open-string
 *               samples played/transposed instead of the K–S synth — literally
 *               the user's guitar.
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
    /** Excitation loudness (0..1): amplitude of the seeded pluck. */
    brightness: number;
    /** Loop lowpass (0 = bright/long harmonics, 1 = dull/short). */
    damping: number;
  };
  /**
   * Fixed character per guitar string, index 0 = thickest/lowest. These are the
   * *systematic* differences (wound lows vs plain highs) that let the ear pick
   * voices apart; random `variation` only adds a thin humanizing sliver on top.
   * Each string is a full "pickup voicing": tone EQ (like a pickup position),
   * attack envelope (bass thumps, treble snaps), excitation loudness, loop
   * damping, sustain, scoop and pick character.
   */
  voices: {
    /** Excitation loudness (0..1): amplitude of the seeded pluck (how hard the
     *  string is hit). Higher = stronger, stringier articulation. */
    brightness: number;
    /** Loop lowpass (0..1): 1 = dull/wound, 0 = bright/glass. */
    damping: number;
    /** Second one-pole loop loss (0..1): steepens the tail so high partials
     *  burn off along a string-like curve. Wound lows darken fast; plain highs
     *  keep a sparkly tail. Independent of `damping` (which sets the sustained
     *  brightness). */
    decay: number;
    /** Loop gain per sample (0..1): higher = longer ring. */
    sustain: number;
    /**
     * Attack bloom (0..~0.35): how much extra early level this string's onset
     * carries before settling into the sustained tone (see `bloom`). Real
     * strings shed their bright transient energy fast — measured vs a live E2:
     * the high strings are 10..25 dB below peak within a second, the lows only
     * a few dB — so the bloom increases with string index. 0 = no bloom.
     */
    bloom?: number;
    /** Pitch scoop at the attack for this string (cents); 0 = strike clean. */
    scoopCents: number;
    /** Pick-scrape transient level for this string (0..1). */
    pick: number;
    /**
     * Brightness of this string's scrape transient (0..1 → highpass cutoff
     * ~350 Hz..9 kHz). Wound lows scrape dark and plosive (near the nut);
     * plain highs scrape bright and thin (near the bridge). This is what
     * separates the onsets from the very first sample, before the body EQ.
     */
    pickBright: number;
    /** Length of this string's scrape transient in ms (lows linger, highs snap). */
    pickDecayMs: number;
    /** Host-side gain ramp time in ms: slow = bass thump, fast = treble snap. */
    attackMs: number;
    /**
     * Where along the string the pick strikes (0..1, fraction from the bridge).
     * Seeds the K–S loop with a triangular displacement whose kink is at this
     * point, so the string excites harmonics `sin(n·π·pickPos)/n²` — small =
     * near-bridge/bright, large = near-nut/fat. Each string being plucked at a
     * different spot is a big part of real guitars (and makes voices distinct
     * by construction, not just by post-EQ).
     */
    pickPos: number;
    /**
     * Body-thump transient level for this string (0..1): how much this string
     * makes the top/bridge react with a brief low-frequency "box hit" at its
     * attack. Wound lows shake the box, plain highs barely do.
     */
    thump: number;
    /** Optional tone-shape EQ applied to this string only (pickup voicing). */
    eq?: {
      /** Low shelf cut for wound strings (Hz); darkens without killing lows. */
      lowpassHz?: number;
      /** Presence peak (Hz) — each string rings at its own resonant color. */
      peakHz?: number;
      /** Gain of the presence peak in dB. */
      peakGainDb?: number;
      /** Q of the presence peak. */
      peakQ?: number;
    };
  }[];
  /**
   * A piano note's fixed character comes from where it sits on the keyboard —
   * the piano analogue of the guitar's per-string `voices`. `scheduleVoice`
   * interpolates every knob between the `low` and `high` profiles by MIDI note,
   * so a voicing's bass is dark/thumpy/long and its treble bright/snappy while
   * every key keeps its own identity.
   */
  piano: {
    /** Character of a deep bass note (anchor MIDI = `low.midi`). */
    low: PianoRegisterProfile;
    /** Character of a bright treble note (anchor MIDI = `high.midi`). */
    high: PianoRegisterProfile;
  };
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
    /** Brightness of the scrape when the string doesn't set its own (0..1). */
    pickBright: number;
    /** Length of the scrape transient in ms (default for unpicked voices). */
    pickMs: number;
  };
  /**
   * The string is never a perfectly static oscillator on a real guitar — it
   * breathes. A slow wobble, each note starting at its own random phase (and
   * a ± `hzSpread` rate), makes the amplitude swallow and the pitch waver the
   * tiniest bit; both are strongest right after the pluck ("blooms") and
   * settle into a steady lope. 0 everywhere = the old machine-stamped loop.
   */
  life: {
    /** Wobble depth applied to the loop gain (0..1, ~0.006 is plenty). */
    amt: number;
    /** Steady wobble rate in Hz. */
    hz: number;
    /** Random ± on `hz` per note (Hz), so chord voices never bob in unison. */
    hzSpread: number;
    /** The extra early wobble blooms away over this window, ms. */
    bloomMs: number;
    /** Max pitch waver in cents; keep under ~3 or it reads as vibrato. */
    pitchCents: number;
  };
  /**
   * The top/bridge reacting to the pluck: a brief low-frequency "box hit"
   * added to each string's output (never fed back into the string loop, so it
   * decays out fast and can't ring as a pitch). How much a string excites it
   * lives in that `voices[s].thump` entry; these are the shared-mode knobs.
   */
  thump: {
    /** Body-mode frequency, Hz (~105 is a typical dreadnought monopole). */
    hz: number;
    /** How long the thump decays out, ms. */
    decayMs: number;
  };
  /**
   * Recorded body IR (progress 19) — the one body approach that beat the
   * "wobbly synthetic sines" failure (progress 13). When a recorded guitar-top
   * impulse is loaded, every string is convolved through it so the box rings
   * with the instrument's real modes. The IR itself (a normalized mono WAV,
   * trimmed to onset, length-capped) is not a knob — it comes from the debug
   * harness or a shipped `assets/body-ir.wav` — these are just mix knobs.
   */
  ir: {
    /** Wet level of the convolved body in the mix (0..1; 0 disables the IR). */
    level: number;
    /** Imported IR tail is capped to this many ms. */
    maxMs: number;
    /**
     * One-pole lowpass applied to imported IRs (progress 19): laptop-mic knocks
     * clip/pin full-scale for a few ms, and those saturated edges read as
     * "static" when convolved into every pluck. A lowpass in the body band
     * (the guitar box has ~0 energy above ~1 kHz anyway) makes the clean modes
     * dominate. Lower = safer/smoother, higher = more of the knock's snap.
     */
    smoothHz: number;
    /** Raised-cosine attack fade over the first ms of the imported IR. */
    attackMs: number;
  };
  /**
   * Which engine produces a guitar voicing (progress 21):
   *  - "smplr" — the smplr sampled guitar (a real GM steel-guitar kit, six
   *    per-string instances sharing one decode) — the priority sound.
   *  - "samples" — the user's recorded open strings (progress 20), transposed
   *    by nearest sample; the K–S synth fills the gaps.
   *  - "synth" — the K–S worklet (the always-available fallback).
   * Piano keys and single fretboard dots are untouched by all three.
   */
  engine: {
    /** Active source for guitar voicings. */
    mode: "smplr" | "synth" | "samples";
    /**
     * Which real guitar the smplr kit plays: steel-string acoustic
     * (MusyngKite `acoustic_guitar_steel`, sparkly/nasal) or classical nylon
     * (`guitar_nylon`, mellow/warm). Selecting a kit is a live engine swap —
     * the other kit's decode stays cached per context, so going back is cheap.
     */
    kit: "steel" | "nylon";
    /** The self-hosted kits (page-relative — they ship under `assets/`). */
    kits: Record<"steel" | "nylon", string>;
    /** Level trim for the kit vs the synth path (1 = nominal). */
    gain: number;
    /** Host-side gate ramp ms (de-clicks the fade-in; the kit has its own attack). */
    attackMs: number;
    /**
     * Base note velocity (0..127) fed to the sampler; the root/color roles
     * scale on top, reaching the sample layer's velocity handling.
     */
    velocity: number;
  };
  /**
   * Real-guitar sample playback (progress 20): plays guitar voicings from six
   * recorded open-string samples (the user's actual guitar) instead of the
   * K–S synth. Each sample is captured once in the debug harness, stored
   * 24 kHz mono, and transposed to any fretted note via playback rate.
   * Mapping is *nearest sample in pitch*, so with all six strings recorded
   * the worst shift is ~±2–4 semitones and nothing reads as a chipmunk.
   * Piano keys are untouched — samples are a guitar thing.
   */
  samples: {
    /** Use recorded samples whenever a usable one exists; synth otherwise. */
    enabled: boolean;
    /** Loudness trim vs the synth path (1 = same nominal level). */
    gain: number;
    /**
     * Host-side gate ramp, ms. Samples already carry their real attack — this
     * only de-clicks the fade-in.
     */
    attackMs: number;
    /**
     * Furthest a sample may be transposed, semitones. Beyond this (a partial
     * bank, or the fretboard's extremes) the synth takes over so a stretched
     * sample never sounds robotic.
     */
    maxShift: number;
    /** Longest a sample may keep playing, ms (capped further by pitch). */
    maxMs: number;
    /** Shortest a sample may be capped to, ms (highs decay fast). */
    minMs: number;
  };
  /**
   * Attack bloom (the shared part; how *much* each string blooms lives in that
   * `voices[s].bloom`). A real pluck excites a burst of bright transient energy
   * that decays over the first second while the fundamental settles into its
   * sustained tone — measured vs live recordings, the high strings sit 10..25 dB
   * below their peak within a second. Two effects share one envelope:
   * `startDamp` makes the loop start brighter (a lower damping coefficient) and
   * glide up to the string's sustained `damping`, and the per-string `bloom`
   * amount is extra early level that settles away. Both fade as `e^(-t/τ)`.
   */
  bloom: {
    /** Loop-damping coefficient the note starts at (0..1; small = bright onset). */
    startDamp: number;
    /** Settle time constant in ms (how long the bloom takes to fade). */
    ms: number;
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

/**
 * One endpoint of the piano register interpolation: the full per-note character
 * (same knobs as a guitar `voices` entry, holding their own meaning for a key).
 */
export interface PianoRegisterProfile {
  /** MIDI note this profile anchors; keys beyond it clamp to it. */
  midi: number;
  /** Excitation loudness (0..1): amplitude of the seeded pluck (0..1). */
  brightness: number;
  /** Loop lowpass (0..1): 1 = dull, 0 = bright. */
  damping: number;
  /** Loop gain per sample (0..1): higher = longer ring. */
  sustain: number;
  /** Attack scoop in cents (bass grazes sharp, treble strikes clean). */
  scoopCents: number;
  /** Pick-scrape transient level (0..1). */
  pick: number;
  /** Host-side gain ramp in ms: lows thump, highs snap. */
  attackMs: number;
  /** Register tone EQ (a grand's low-mid warmth vs high sparkle). */
  eq?: {
    lowpassHz?: number;
    peakHz?: number;
    peakGainDb?: number;
    peakQ?: number;
  };
}

export const DEFAULT_CONFIG: PluckAudioConfig = {
  string: {
    /**
     * Loop gain (0..1), per sample. Tuned so the level follows a real decay
     * curve (see progress 17): ~0.99x, not 0.9999x — a K–S loop at 0.9999+
     * holds the tone flat and then hits the ring cutoff like a switch instead
     * of actually decaying. Per-string values in `voices[].sustain` were
     * measured against a real E2 pluck.
     */
    sustain: 0.99985,
    brightness: 0.85,
    damping: 0.32,
  },
  voices: [
    // Low E (wound): dark body, slow thump, long ring, big attack scoop.
    // Plucked far toward the nut (0.75) so its harmonic set is fat; the heavy
    // decay (0.5) lets the wound string's highs burn off fast. Shakes the box
    // hardest (thump 0.35). Sustain measured from a real E2 pluck: -20 dB at
    // ~4.4s, -40 at ~9.4s (progress 17).
    {
      brightness: 0.34,
      damping: 0.82,
      decay: 0.5,
      sustain: 0.99433,
      bloom: 0.03,
      scoopCents: 28,
      pick: 0.12,
      pickBright: 0.18,
      pickDecayMs: 4.5,
      attackMs: 11,
      pickPos: 0.75,
      thump: 0.35,
      eq: { lowpassHz: 1000, peakHz: 180, peakGainDb: 9, peakQ: 1.4 },
    },
    // A (wound): still dark/thumpy, slightly less so.
    {
      brightness: 0.48,
      damping: 0.7,
      decay: 0.45,
      sustain: 0.99493,
      bloom: 0.06,
      scoopCents: 20,
      pick: 0.16,
      pickBright: 0.28,
      pickDecayMs: 4.0,
      attackMs: 9,
      pickPos: 0.7,
      thump: 0.28,
      eq: { lowpassHz: 1250, peakHz: 200, peakGainDb: 7, peakQ: 1.2 },
    },
    // D (wound): the start of the "plain" mid range; clearer body, no scoop.
    {
      brightness: 0.64,
      damping: 0.56,
      decay: 0.4,
      sustain: 0.99592,
      bloom: 0.1,
      scoopCents: 2,
      pick: 0.22,
      pickBright: 0.45,
      pickDecayMs: 3.2,
      attackMs: 6,
      pickPos: 0.6,
      thump: 0.18,
      eq: { lowpassHz: 1800, peakHz: 260, peakGainDb: 5, peakQ: 1 },
    },
    // G (plain): snappy, warm presence around the guitar's mid "honk".
    {
      brightness: 0.82,
      damping: 0.4,
      decay: 0.28,
      sustain: 0.99605,
      bloom: 0.16,
      scoopCents: 0,
      pick: 0.3,
      pickBright: 0.6,
      pickDecayMs: 2.6,
      attackMs: 4,
      pickPos: 0.45,
      thump: 0.09,
      eq: { peakHz: 700, peakGainDb: 4, peakQ: 1.2 },
    },
    // B (plain): bright and quick, presence up around 1.8 kHz.
    {
      brightness: 0.94,
      damping: 0.3,
      decay: 0.22,
      sustain: 0.99667,
      bloom: 0.22,
      scoopCents: 0,
      pick: 0.4,
      pickBright: 0.8,
      pickDecayMs: 2.0,
      attackMs: 3,
      pickPos: 0.35,
      thump: 0.04,
      eq: { peakHz: 1800, peakGainDb: 6, peakQ: 1 },
    },
    // High E (plain): thin, glassy, aggressive scrape; presence 3.6 kHz,
    // minimal extra decay so the tail stays sparkly. Barely touches the box.
    {
      brightness: 1.0,
      damping: 0.22,
      decay: 0.18,
      sustain: 0.99713,
      bloom: 0.3,
      scoopCents: 0,
      pick: 0.5,
      pickBright: 0.95,
      pickDecayMs: 1.5,
      attackMs: 2,
      pickPos: 0.3,
      thump: 0.02,
      eq: { peakHz: 3600, peakGainDb: 8, peakQ: 0.9 },
    },
  ],
  // Piano "strings": the register itself is the identity. Bass keys are dark,
  // felted, damped and long; treble keys bright, snappy and short. Everything
  // between them is interpolated by MIDI note, so no two keys share a profile.
  piano: {
    // C2: dark, warm low-mid body, slow-ish hammer, long ring, slight scoop.
    low: {
      midi: 36,
      brightness: 0.5,
      damping: 0.68,
      sustain: 0.99992,
      scoopCents: 12,
      pick: 0.18,
      attackMs: 8,
      eq: { lowpassHz: 1100, peakHz: 220, peakGainDb: 6, peakQ: 1.2 },
    },
    // C7: thin and glassy, fast hammer, shorter ring, bright presence.
    high: {
      midi: 96,
      brightness: 1.0,
      damping: 0.18,
      sustain: 0.99978,
      scoopCents: 0,
      pick: 0.55,
      attackMs: 2,
      eq: { lowpassHz: 14000, peakHz: 3200, peakGainDb: 8, peakQ: 0.9 },
    },
  },
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
    pickBright: 0.6,
    pickMs: 6,
  },
  life: {
    // Deliberately small: a hair of swell, not a tremolo or chorus.
    amt: 0.006,
    hz: 1.7,
    hzSpread: 0.7,
    bloomMs: 600,
    pitchCents: 2.2,
  },
  // Shared body-mode knobs; each string's *how much* lives in `voices[].thump`.
  thump: {
    hz: 106,
    decayMs: 90,
  },
  // Recorded body IR (progress 19): wet level in the mix, and the length cap
  // applied to imported IRs. The IR itself comes from the debug harness or a
  // committed `assets/body-ir.wav` — never synthesized (progress 13).
  ir: {
    level: 0.5,
    maxMs: 1200,
    smoothHz: 2000,
    attackMs: 2,
  },
  // Which engine plays guitar voicings (progress 21): the smplr sampled kit
  // by default (real recordings, per-string instances, done once), with the
  // recorded-string bank and the K–S synth selectable for A/B. `kit` picks
  // which real guitar the kit plays; both kits ship under `assets/`.
  engine: {
    mode: "smplr",
    kit: "steel",
    kits: {
      steel: "assets/guitar-steel-ogg.js",
      nylon: "assets/guitar-nylon-ogg.js",
    },
    gain: 1,
    attackMs: 6,
    velocity: 100,
  },
  // Real-guitar sample playback (progress 20): see the interface docs. These
  // are playback-only knobs; the samples themselves are recordings.
  samples: {
    enabled: true,
    gain: 1,
    // Bias toward the real attack: a short ramp just de-clicks the gate.
    attackMs: 4,
    // With all six strings recorded the nearest sample is within ~±2-4 st;
    // 12 keeps partial banks sane (a lone E2 sample stops being stretched
    // into B3 territory).
    maxShift: 12,
    maxMs: 9000,
    minMs: 3000,
  },
  // Attack bloom (progress 17): the onset starts brighter and settles into the
  // sustained tone; how much each string blooms is its `voices[s].bloom`.
  bloom: {
    startDamp: 0.07,
    // ~e-fold of the settle; by ~1s the bloom is gone and the note sings plain.
    ms: 420,
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
    guitarMs: 140,
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
    /**
     * How long a note may keep sounding: `(baseMs - perKHzMs·Hz/1000)/1000`.
     * Must outlast every string's natural decay — progress 17: baseMs 3400 was
     * cutting the low E off at ~3.3s while it was still only -4 dB (the 
     * "flat tone then sudden stop" tell). Lows decay slowest, so base 12800
     * rings them past -50 dB; highs die by real decay long before the cutoff.
     */
    baseMs: 12800,
    perKHzMs: 900,
  },
};