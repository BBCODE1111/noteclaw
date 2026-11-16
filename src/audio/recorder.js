// Live capture from an audio interface. Samples are tapped in an AudioWorklet, so timing comes from the
// sample count rather than from screen refreshes, and every input channel is kept until recording stops.
import { StreamAnalyzer, segmentNotes, analyzeBuffer, transcribe, fitGrid, HOP, WINDOW } from './analysis.js';

const TAP = `class GsTap extends AudioWorkletProcessor {
  process(inputs) { const input = inputs[0]; if (input && input.length) this.port.postMessage(input.map(c => c.slice())); return true; }
}
registerProcessor('gs-tap', GsTap);`;

export class GuitarRecorder {
  constructor({ onFrame = () => {}, onLevels = () => {}, onNotes = () => {} } = {}) {
    this.onFrame = onFrame; this.onLevels = onLevels; this.onNotes = onNotes;
    this.running = false; this.channel = 'auto';
  }
  /**
   * @param {object} o
   * @param {string} [o.deviceId]
   * @param {number|'auto'} [o.channel] input channel index, or 'auto' for the loudest
   * @param {number} [o.bpm] @param {number} [o.beatsPerBar]
   * @param {boolean} [o.countIn] one bar of clicks before beat one
   * @param {boolean} [o.metronome] keep clicking while recording
   * @param {number} [o.latencyMs] extra delay between the click and the recorded note (interface round trip)
   */
  async start({ deviceId, channel = 'auto', bpm = 110, beatsPerBar = 4, countIn = true, metronome = true, latencyMs = 0, range = 'guitar', keepSeconds = Infinity } = {}) {
    if (this.running) return;
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 32 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    const settings = this.stream.getAudioTracks()[0]?.getSettings?.() ?? {};
    this.context = new AudioContext({ latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }));
    try { await this.context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    this.source = this.context.createMediaStreamSource(this.stream);
    const channels = Math.max(1, settings.channelCount || this.source.channelCount || 1);
    // 'discrete' keeps each interface input on its own channel instead of mixing them down.
    this.tap = new AudioWorkletNode(this.context, 'gs-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    this.source.connect(this.tap); // never routed to the speakers: no feedback
    this.channels = channels; this.channel = channel;
    this.chunks = Array.from({ length: channels }, () => []);
    this.energy = new Float64Array(channels);
    this.samples = 0; this.startTime = null; this.keepSeconds = keepSeconds;
    this.range = range; this.bpm = bpm;
    this.live = new StreamAnalyzer(this.context.sampleRate, { range });
    this.liveChannel = null;
    this.clicks = []; // scheduled clicks, in audio-clock time
    this.noise = this.makeClickBuffer();
    this.running = true;
    // Beat one, measured in recorded samples: the click leaves late (output latency) and the guitar arrives late (input latency).
    const beat = 60 / bpm;
    const firstClick = this.context.currentTime + 0.15;
    const downbeat = firstClick + (countIn ? beatsPerBar * beat : 0);
    this.useGrid = countIn || metronome;
    const roundTrip = (this.context.outputLatency || this.context.baseLatency || 0) + (settings.latency || 0) + latencyMs / 1000;
    this.roundTrip = roundTrip;
    this.tap.port.onmessage = e => {
      const block = e.data;
      if (this.startTime === null) { this.startTime = this.context.currentTime; this.origin = downbeat - this.startTime + roundTrip; }
      const peaks = [];
      for (let c = 0; c < this.channels; c++) {
        const data = block[c] ?? block[0];
        this.chunks[c].push(data);
        let peak = 0, sum = 0;
        for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; sum += v * v; }
        this.energy[c] += sum; peaks.push(peak);
      }
      this.samples += block[0].length;
      // Always-listening mode keeps only the last few minutes.
      const limit = this.keepSeconds * this.context.sampleRate;
      while (this.samples - (this.chunks[0][0]?.length ?? 0) > limit && this.chunks[0].length > 1) {
        const n = this.chunks[0][0].length;
        for (const list of this.chunks) list.shift();
        this.samples -= n;
      }
      const active = this.activeChannel();
      if (active !== this.liveChannel) { this.liveChannel = active; this.live = new StreamAnalyzer(this.context.sampleRate, { range: this.range }); }
      const frames = this.live.push(block[active] ?? block[0]);
      this.onLevels(peaks, active);
      if (frames.length) this.onFrame(frames[frames.length - 1]);
    };
    // Metronome: schedule clicks a little ahead of time so they stay sample-accurate.
    let n = 0;
    const schedule = () => {
      while (this.running) {
        const at = firstClick + n * beat;
        if (at > this.context.currentTime + 0.2) break;
        const counting = at < downbeat - 1e-6;
        if (counting || metronome) { this.click(at, n % beatsPerBar === 0); this.clicks.push({ at, counting }); }
        n++;
      }
    };
    schedule();
    this.clickTimer = setInterval(schedule, 50);
    this.notesTimer = setInterval(() => {
      // Only recent frames are needed for the live view; long sessions would otherwise slow down.
      if (this.live.frames.length > 4000) this.live.frames.splice(0, this.live.frames.length - 3000);
      this.onNotes(segmentNotes(this.live.frames), this.origin);
    }, 400);
    return { channels, sampleRate: this.context.sampleRate, countInSeconds: downbeat - firstClick + 0.15 };
  }
  /** The click is a burst of noise, not a tone: if it leaks into the input it can never be read as a note. */
  makeClickBuffer() {
    const length = Math.round(this.context.sampleRate * 0.03);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length * 0.18));
    return buffer;
  }
  click(at, accent) {
    const src = this.context.createBufferSource(), filter = this.context.createBiquadFilter(), gain = this.context.createGain();
    src.buffer = this.noise;
    filter.type = 'bandpass'; filter.frequency.value = accent ? 4200 : 2600; filter.Q.value = 1.2;
    gain.gain.value = accent ? 0.9 : 0.55;
    src.connect(filter).connect(gain).connect(this.context.destination);
    src.start(at);
  }
  /** The chosen channel, or the one that has carried the most signal so far. */
  activeChannel() {
    if (this.channel !== 'auto' && this.channel < this.channels) return this.channel;
    let best = 0;
    for (let c = 1; c < this.channels; c++) if (this.energy[c] > this.energy[best]) best = c;
    return best;
  }
  setChannel(channel) { this.channel = channel; }
  /** The last `seconds` of the active input, without stopping. Used by "write down what I just played". */
  snapshot(seconds) {
    if (!this.running) return null;
    const channel = this.activeChannel(), want = Math.min(this.samples, Math.round(seconds * this.context.sampleRate));
    const out = new Float32Array(want);
    let filled = 0;
    const list = this.chunks[channel];
    for (let i = list.length - 1; i >= 0 && filled < want; i--) {
      const chunk = list[i], take = Math.min(chunk.length, want - filled);
      out.set(chunk.subarray(chunk.length - take), want - filled - take);
      filled += take;
    }
    return { samples: out, sampleRate: this.context.sampleRate, channel };
  }
  async stop() {
    if (!this.running) return null;
    this.running = false;
    clearInterval(this.clickTimer); clearInterval(this.notesTimer);
    this.tap.port.onmessage = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.source?.disconnect();
    const sampleRate = this.context.sampleRate;
    await this.context.close();
    const channel = this.activeChannel();
    const samples = new Float32Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks[channel]) { samples.set(chunk, offset); offset += chunk.length; }
    this.chunks = [];
    const seconds = samples.length / sampleRate;
    const frames = analyzeBuffer(samples, sampleRate, { range: this.range });
    // Scheduled click times on the recording's own clock, before any latency.
    const scheduled = this.clicks.map(c => ({ t: c.at - this.startTime, counting: c.counting })).filter(c => c.t < seconds);
    const grid = alignGrid(frames, scheduled, this.origin, this.roundTrip);
    const notes = transcribe(samples, sampleRate, { range: this.range, frames, clicks: scheduled.map(c => c.t + grid.delay) });
    let origin, alignment = { method: 'none', ms: 0 };
    if (this.useGrid) {
      origin = grid.origin; alignment = { method: grid.measured ? 'click' : 'estimate', ms: Math.round(grid.delay * 1000) };
      if (!grid.measured) {
        // No reference in the recording: slide the grid (under half a step) to where the playing sits best.
        const fit = fitGrid(notes, origin, 60 / this.bpm / 4);
        if (fit.shift) { origin += fit.shift; alignment = { method: 'fit', ms: Math.round((grid.delay + fit.shift) * 1000) }; }
      }
    }
    return { samples, notes, origin, alignment, channel, channels: this.channels, sampleRate, seconds };
  }
}

/**
 * Work out where beat one falls in the recording.
 * If the count-in clicks leaked into the input (speakers near the pickups, or a loopback), their recorded
 * positions are exactly where a note played in time with the click would land, so the delay is measured.
 * Otherwise the delay reported by the audio system is used.
 */
export function alignGrid(frames, scheduled, estimatedOrigin, estimatedDelay = 0) {
  const fallback = { origin: estimatedOrigin, delay: estimatedDelay, measured: false };
  const counting = scheduled.filter(c => c.counting);
  if (counting.length < 2 || frames.length < 8) return fallback;
  const dt = frames[1].t - frames[0].t, lead = Math.round((WINDOW - HOP) / 2 / HOP);
  const last = counting[counting.length - 1].t + 0.3;
  const during = frames.filter(f => f.t < last).map(f => f.flux).sort((a, b) => a - b);
  const typical = during[during.length >> 1] || 0;
  const delays = [];
  for (const c of counting) {
    let best = -1;
    frames.forEach((f, i) => { if (f.t - c.t > -0.06 && f.t - c.t < 0.22 && (best < 0 || f.flux > frames[best].flux)) best = i; });
    if (best >= 0 && frames[best].flux > typical * 8 && frames[best].flux > 1e-9) delays.push(frames[Math.min(frames.length - 1, best + lead)].t - dt / 2 - c.t);
  }
  if (delays.length < 2) return fallback;
  delays.sort((a, b) => a - b);
  const mid = delays[delays.length >> 1];
  const agreeing = delays.filter(d => Math.abs(d - mid) < 0.02);
  if (agreeing.length < Math.max(2, counting.length - 1)) return fallback; // someone was playing during the count-in
  return { origin: estimatedOrigin - estimatedDelay + mid, delay: mid, measured: true };
}

/** 16-bit mono WAV of a recording, so a take can be kept and re-analysed later. */
export function encodeWav(samples, sampleRate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, str) => { for (let i = 0; i < str.length; i++) view.setUint8(at + i, str.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(view.buffer);
}
