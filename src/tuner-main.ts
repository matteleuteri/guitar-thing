import { noteLabels } from "./theory.js";
import { detectPitch } from "./pitch.js";

const startBtn = document.getElementById("start") as HTMLButtonElement | null;
const stopBtn = document.getElementById("stop") as HTMLButtonElement | null;
const statusEl = document.getElementById("status") as HTMLParagraphElement | null;
const errorEl = document.getElementById("error") as HTMLParagraphElement | null;
const noteEl = document.getElementById("note") as HTMLDivElement | null;
const octaveEl = document.getElementById("octave") as HTMLSpanElement | null;
const freqEl = document.getElementById("freq") as HTMLSpanElement | null;
const centsEl = document.getElementById("cents") as HTMLSpanElement | null;
const clarityEl = document.getElementById("clarity") as HTMLSpanElement | null;
const rmsEl = document.getElementById("rms") as HTMLSpanElement | null;
const needleEl = document.getElementById("needle") as HTMLDivElement | null;

let audioCtx: AudioContext | null = null;
let stream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let analyserNode: AnalyserNode | null = null;
let inputBuffer: Float32Array | null = null;
let rafId = 0;
let running = false;

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
}

function setError(text: string | null) {
  if (!errorEl) return;
  if (text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
}

function midiToNoteName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  return noteLabels(pc);
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (scriptNode) {
    scriptNode.disconnect();
    scriptNode.onaudioprocess = null;
  }
  scriptNode = null;
  if (analyserNode) analyserNode.disconnect();
  analyserNode = null;
  if (sourceNode) sourceNode.disconnect();
  sourceNode = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
  }
  stream = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
  }
  audioCtx = null;
  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
  setStatus("Stopped");
}

async function start() {
  setError(null);
  if (running) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setError(
      "Microphone access needs a secure page: open the site over https:// or on localhost. " +
        "(Browsers hide the mic on plain http:// addresses.)"
    );
    return;
  }
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    stream = media;
    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    audioCtx = new AudioContextClass();
    await audioCtx!.resume().catch(() => {});
    sourceNode = audioCtx!.createMediaStreamSource(media);
    const bufferSize = 2048;
    scriptNode = audioCtx!.createScriptProcessor(bufferSize, 1, 1);
    analyserNode = audioCtx!.createAnalyser();
    analyserNode.fftSize = 2048;
    inputBuffer = new Float32Array(analyserNode.fftSize);
    sourceNode!.connect(analyserNode!);
    sourceNode!.connect(scriptNode!);
    scriptNode!.connect(audioCtx!.destination);
    running = true;
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    setStatus("Listening...");
    scriptNode.onaudioprocess = () => {};
    loop();
  } catch (e: any) {
    console.error(e);
    stop();
    setError(e?.message || "Could not access microphone");
  }
}

function loop() {
  if (!running || !analyserNode || !inputBuffer || !audioCtx) return;
  analyserNode.getFloatTimeDomainData(inputBuffer as any);
  const res = detectPitch(inputBuffer as any, audioCtx.sampleRate, 60, 1400);
  if (res) {
    const name = midiToNoteName(res.midi);
    if (noteEl) noteEl.textContent = name;
    const octave = Math.floor(res.midi / 12) - 1;
    if (octaveEl) octaveEl.textContent = String(octave);
    if (freqEl) freqEl.textContent = `${res.freq.toFixed(2)} Hz`;
    if (centsEl) centsEl.textContent = `${res.cents > 0 ? "+" : ""}${res.cents}¢`;
    if (clarityEl) clarityEl.textContent = res.clarity.toFixed(2);
    if (rmsEl) rmsEl.textContent = res.rms.toFixed(4);
    if (needleEl) {
      const max = 50;
      const c = Math.max(-max, Math.min(max, res.cents));
      const pct = 50 + (c / max) * 50;
      needleEl.style.left = `${pct}%`;
    }
  } else {
    if (noteEl) noteEl.textContent = "—";
    if (octaveEl) octaveEl.textContent = "—";
    if (freqEl) freqEl.textContent = "— Hz";
    if (centsEl) centsEl.textContent = "—";
    if (clarityEl) clarityEl.textContent = "—";
    if (rmsEl) rmsEl.textContent = "—";
    if (needleEl) needleEl.style.left = "50%";
  }
  rafId = requestAnimationFrame(loop);
}

startBtn?.addEventListener("click", () => {
  start().catch((e) => {
    console.error(e);
    setError(String(e));
  });
});
stopBtn?.addEventListener("click", stop);
window.addEventListener("beforeunload", stop);
