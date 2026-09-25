/**
 * Shared post-string signal path. Notes sum into a single bus, get shaped by
 * the guitar "body" EQ, then — when a *recorded* body IR is loaded — get
 * convolved through the real guitar top's impulse response (the recorded-IR
 * body, AGENTS.md progress 19), then split into a dry path and a room tail.
 */

import type { PluckAudioConfig } from "./config.js";

export interface SharedGraph {
  /** Everything that can be heard feeds through this before the compressor. */
  master: GainNode;
  /** All plucked notes connect here. */
  voiceIn: GainNode;
  /** Recorded body-IR convolver. Needs a buffer + wet level set by the host;
   *  with no IR loaded the wet gain stays 0 and the path is pure bypass. */
  ir: { con: ConvolverNode; wet: GainNode };
}

function peaking(context: BaseAudioContext, freq: number, gainDb: number, q: number): BiquadFilterNode {
  const filter = context.createBiquadFilter();
  filter.type = "peaking";
  filter.frequency.value = freq;
  filter.gain.value = gainDb;
  filter.Q.value = q;
  return filter;
}

/** Build the shared bus → body EQ → dry + room → master graph. */
export function buildSharedGraph(context: BaseAudioContext, config: PluckAudioConfig): SharedGraph {
  // Master bus (kept low so many voices can stack without clipping).
  const master = context.createGain();
  master.gain.value = 0.7;

  // Body EQ: one chesty low resonance, one presence peak. Notes share this.
  const voiceIn = context.createGain();
  const bodyLow = peaking(context, config.body.lowHz, config.body.lowGainDb, 1.2);
  const presence = peaking(context, config.body.presenceHz, config.body.presenceGainDb, 1.3);
  voiceIn.connect(bodyLow);
  bodyLow.connect(presence);

  // Every string rings the recorded body (progress 19): a ConvolverNode fed by
  // the real guitar's IR. With no IR loaded the wet gain is 0 and the path is
  // pure bypass, so the approved no-IR sound is untouched. The host (audio.ts)
  // sets `ir.con.buffer` + `ir.wet.gain.value` once the IR is available.
  const afterBody = context.createGain();
  presence.connect(afterBody);
  const irWet = context.createGain();
  irWet.gain.value = 0;
  const irCon = context.createConvolver();
  irCon.normalize = false; // we peak-normalize the IR ourselves; keep levels exact
  presence.connect(irWet);
  irWet.connect(irCon);
  irCon.connect(afterBody);

  // Dry path straight to the master.
  const dry = context.createGain();
  dry.gain.value = 1;
  afterBody.connect(dry);
  dry.connect(master);

  // Room tail: one feedback delay, dampened darkly in its own loop.
  const roomIn = context.createGain();
  const delay = context.createDelay(2);
  delay.delayTime.value = config.room.time;
  const damp = context.createBiquadFilter();
  damp.type = "lowpass";
  damp.frequency.value = config.room.dampHz;
  const feedback = context.createGain();
  feedback.gain.value = config.room.feedback;
  const wet = context.createGain();
  wet.gain.value = config.room.wet;
  afterBody.connect(roomIn);
  roomIn.connect(delay);
  delay.connect(damp);
  damp.connect(feedback);
  feedback.connect(delay);
  damp.connect(wet);
  wet.connect(master);

  // Gentle glue, tuned so the strum stays punchy (heavy ratios squash the
  // per-string attacks together into one fused transient).
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 8;
  compressor.ratio.value = 2.5;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.35;
  master.connect(compressor);
  compressor.connect(context.destination);

  return { master, voiceIn, ir: { con: irCon, wet: irWet } };
}