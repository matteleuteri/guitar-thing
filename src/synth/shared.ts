/**
 * Shared post-string signal path. Notes sum into a single bus, get shaped by
 * the guitar "body" EQ, then split into a dry path and a short room tail.
 */

import type { PluckAudioConfig } from "./config.js";

export interface SharedGraph {
  /** Everything that can be heard feeds through this before the compressor. */
  master: GainNode;
  /** All plucked notes connect here. */
  voiceIn: GainNode;
}

function peaking(c: AudioContext, freq: number, gainDb: number, q: number): BiquadFilterNode {
  const f = c.createBiquadFilter();
  f.type = "peaking";
  f.frequency.value = freq;
  f.gain.value = gainDb;
  f.Q.value = q;
  return f;
}

/** Build the shared bus → body EQ → dry + room → master graph. */
export function buildSharedGraph(c: AudioContext, cfg: PluckAudioConfig): SharedGraph {
  // Master bus (kept low so many voices can stack without clipping).
  const master = c.createGain();
  master.gain.value = 0.7;

  // Body EQ: one chesty low resonance, one presence peak. Notes share this.
  const voiceIn = c.createGain();
  const bodyLow = peaking(c, cfg.body.lowHz, cfg.body.lowGainDb, 1.2);
  const presence = peaking(c, cfg.body.presenceHz, cfg.body.presenceGainDb, 1.3);
  voiceIn.connect(bodyLow);
  bodyLow.connect(presence);

  // Dry path straight to the master.
  const dry = c.createGain();
  dry.gain.value = 1;
  presence.connect(dry);
  dry.connect(master);

  // Room tail: one feedback delay, dampened darkly in its own loop.
  const roomIn = c.createGain();
  const delay = c.createDelay(2);
  delay.delayTime.value = cfg.room.time;
  const damp = c.createBiquadFilter();
  damp.type = "lowpass";
  damp.frequency.value = cfg.room.dampHz;
  const feedback = c.createGain();
  feedback.gain.value = cfg.room.feedback;
  const wet = c.createGain();
  wet.gain.value = cfg.room.wet;
  presence.connect(roomIn);
  roomIn.connect(delay);
  delay.connect(damp);
  damp.connect(feedback);
  feedback.connect(delay);
  damp.connect(wet);
  wet.connect(master);

  // Gentle glue, tuned so the strum stays punchy (heavy ratios squash the
  // per-string attacks together into one fused transient).
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 8;
  comp.ratio.value = 2.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.35;
  master.connect(comp);
  comp.connect(c.destination);

  return { master, voiceIn };
}