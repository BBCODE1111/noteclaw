// Monophonic analysis: audio samples → pitch frames → notes with techniques.
// Pure functions with no browser APIs, so the whole chain runs offline on synthetic audio and on saved takes.
//
// What is measured and what is guessed:
//   measured  — pitch over time, where notes start and stop, loudness
//   inferred  — bend / vibrato (from the pitch curve), legato (pitch change with no new pick attack)
//   not known — which string and fret was used; that is chosen later by the fingering optimiser
//
// Thresholds are relative to the take itself (its own noise floor and its own loudest attacks), because a
// DI signal can be anywhere from very quiet to clipped and a distorted amp has almost no dynamics.

export const HOP = 512;
export const WINDOW = 2048;
const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
const percentile = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

/**
 * Background level of a take. Normally the quietest tenth of it is silence between phrases. A take with no
 * pauses at all has no silence to measure, and its quietest moments are decaying notes, so a level well below
 * the loud notes is assumed instead.
 */
function noiseFloor(levels) {
  const low = percentile(levels, 0.1), loud = percentile(levels, 0.95);
  return low < loud * 0.25 ? low : loud * 0.03;
}

/** Instrument ranges. Bass is analysed at half the sample rate so its long periods fit the same window. */
export const RANGES = {
  guitar: { minHz: 60, maxHz: 1400, decimate: 1, lowest: 35, highest: 96 },
  bass: { minHz: 28, maxHz: 520, decimate: 2, lowest: 21, highest: 72 }
};

/** YIN pitch estimate for one window. `hz` is null for silence or unpitched sound. */
export function detectPitchHz(buf, sampleRate, { minHz = 60, maxHz = 1400, threshold = 0.15, minRms = 0.0006 } = {}) {
  const half = buf.length >> 1;
  let energy = 0;
  for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i];
  const rms = Math.sqrt(energy / buf.length);
  if (rms < minRms) return { hz: null, rms, clarity: 0 };
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(Math.floor(sampleRate / minHz), half - 1);
  const cmnd = new Float32Array(maxLag + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    let diff = 0;
    for (let i = 0; i < half; i++) { const d = buf[i] - buf[i + tau]; diff += d * d; }
    running += diff;
    cmnd[tau] = running > 0 ? diff * tau / running : 1;
  }
  // First dip under the threshold, followed down to its local minimum: the fundamental rather than a sub-octave.
  let lag = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < threshold) { while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++; lag = tau; break; }
  }
  if (lag < 0) {
    let best = minLag;
    for (let tau = minLag; tau <= maxLag; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
    if (cmnd[best] > 0.35) return { hz: null, rms, clarity: 0 };
    lag = best;
  }
  // Parabolic interpolation between lags for sub-sample accuracy (needed to see bends and vibrato).
  const a = cmnd[lag - 1] ?? cmnd[lag], b = cmnd[lag], c = cmnd[lag + 1] ?? cmnd[lag];
  const denom = a - 2 * b + c;
  const refined = lag + (denom ? (a - c) / (2 * denom) : 0);
  return { hz: sampleRate / refined, rms, clarity: Math.max(0, 1 - b) };
}

/** Level and brightness of the newest hop. A pick stroke is a broadband click: `flux` (second-difference energy)
 *  spikes on it even when the note and its loudness stay the same, and barely reacts to the ringing note. */
function hopStats(buf, end) {
  let flux = 0, sum = 0;
  const from = Math.max(2, end - HOP);
  for (let i = from; i < end; i++) { const d = buf[i] - 2 * buf[i - 1] + buf[i - 2]; flux += d * d; sum += buf[i] * buf[i]; }
  return { flux: flux / HOP, level: Math.sqrt(sum / (end - from)) };
}
const makeFrame = (r, endSample, sampleRate, stats) => ({
  // The pitch window is centred half a window before the newest sample.
  t: (endSample - WINDOW / 2) / sampleRate, m: r.hz ? hzToMidi(r.hz) : null, hz: r.hz, rms: r.rms, clarity: r.clarity,
  flux: stats.flux, level: stats.level
});
function decimate(samples, factor) {
  if (factor === 1) return samples;
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < factor; k++) s += samples[i * factor + k]; out[i] = s / factor; }
  return out;
}

/** Feeds arbitrary-size sample blocks and produces one analysis frame every HOP samples (live display). */
export class StreamAnalyzer {
  constructor(sampleRate, { range = 'guitar' } = {}) {
    this.range = RANGES[range] ?? RANGES.guitar;
    this.sampleRate = sampleRate / this.range.decimate;
    // Samples not yet analysed, plus the window's worth before them. Kept small: only one window is ever needed.
    this.buf = new Float32Array(WINDOW * 4); this.len = 0; this.total = 0; this.nextEnd = WINDOW;
    this.frames = [];
  }
  push(block) {
    const samples = decimate(block, this.range.decimate);
    if (this.len + samples.length > this.buf.length) {
      const grown = new Float32Array(Math.max(this.buf.length * 2, this.len + samples.length)); grown.set(this.buf.subarray(0, this.len)); this.buf = grown;
    }
    this.buf.set(samples, this.len); this.len += samples.length;
    const out = [];
    // `total` counts samples dropped from the front of `buf`; a frame ends at absolute sample `nextEnd`.
    while (this.nextEnd <= this.total + this.len) {
      const end = this.nextEnd - this.total;
      const frame = makeFrame(detectPitchHz(this.buf.subarray(end - WINDOW, end), this.sampleRate, this.range), this.nextEnd, this.sampleRate, hopStats(this.buf, end));
      this.frames.push(frame); out.push(frame);
      this.nextEnd += HOP;
    }
    const keep = WINDOW, drop = Math.max(0, this.nextEnd - this.total - keep);
    if (drop > 0) { this.buf.copyWithin(0, drop, this.len); this.len -= drop; this.total += drop; }
    return out;
  }
}
/** Whole-buffer analysis (used when a take is finished, and by the tests). */
export function analyzeBuffer(input, inputRate, { range = 'guitar' } = {}) {
  const r = RANGES[range] ?? RANGES.guitar;
  const samples = decimate(input, r.decimate), sampleRate = inputRate / r.decimate;
  const frames = [];
  for (let end = WINDOW; end <= samples.length; end += HOP) {
    frames.push(makeFrame(detectPitchHz(samples.subarray(end - WINDOW, end), sampleRate, r), end, sampleRate, hopStats(samples, end)));
  }
  return frames;
}

/**
 * Find pick attacks. An attack is a click (a peak in `flux` far above what the ringing note was producing)
 * that is followed by sound. The stroke itself often has a quieter scrape just before it, as the pick
 * touches the string; only the strongest peak of such a cluster counts.
 */
export function findOnsets(frames, { fluxRatio = 6, gap = 0.07, clicks = [] } = {}) {
  if (frames.length < 4) return [];
  const dt = frames[1].t - frames[0].t;
  const near = Math.max(2, Math.round(0.045 / dt)), back = Math.max(4, Math.round(0.1 / dt));
  const floor = noiseFloor(frames.map(f => f.level));
  const loud = percentile(frames.map(f => f.level), 0.95);
  const picks = [];
  for (let i = 1; i < frames.length - 1; i++) {
    const f = frames[i];
    let isPeak = true;
    for (let k = Math.max(0, i - near); k <= Math.min(frames.length - 1, i + near); k++) if (frames[k].flux > f.flux) { isPeak = false; break; }
    if (!isPeak) continue;
    const before = []; for (let k = Math.max(0, i - back); k < i - 1; k++) before.push(frames[k].flux);
    if (before.length < 2 || f.flux < median(before) * fluxRatio) continue;
    // Sound has to follow: louder than the room, and not a tiny blip next to the real notes of this take.
    let after = 0; for (let k = i; k <= Math.min(frames.length - 1, i + near); k++) after = Math.max(after, frames[k].level);
    let prior = Infinity; for (let k = Math.max(0, i - 3); k < i; k++) prior = Math.min(prior, frames[k].level);
    if (after < floor * 3 || after < loud * 0.12) continue;
    // Either the level jumps, or the click is unmistakable (a re-pick at full sustain, or a compressed/distorted tone).
    if (after < prior * 1.2 && f.flux < median(before) * fluxRatio * 4) continue;
    // A metronome click leaking into the input looks like a stroke, but it does not make the string any louder.
    if (after < prior * 1.5 && clicks.some(c => f.t - c > -0.05 && f.t - c < 0.09)) continue;
    picks.push({ i, strength: f.flux });
  }
  // Keep the strongest of any strokes closer together than a hand can pick.
  picks.sort((a, b) => b.strength - a.strength);
  const kept = [];
  for (const p of picks) if (kept.every(k => Math.abs(k.i - p.i) * dt >= gap)) kept.push(p);
  return kept.map(p => p.i).sort((a, b) => a - b);
}

/**
 * Turn pitch frames into notes.
 * A note starts at a pick attack, or where sound begins after silence, or at a fast jump to another pitch.
 * A jump without an attack is reported as legato (hammer-on / pull-off / slide — the audio cannot tell which).
 * A note lasts for as long as the string is still sounding above the take's noise floor.
 */
export function segmentNotes(frames, { minNote = 0.05, jump = 0.85, minClarity = 0.8, lowest = 35, highest = 96, clicks = [] } = {}) {
  if (frames.length < 4) return [];
  const dt = frames[1].t - frames[0].t;
  const span = seconds => Math.max(1, Math.round(seconds / dt));
  const gate = Math.max(noiseFloor(frames.map(f => f.rms)) * 2.2, 0.0012);
  const sounding = frames.map(f => f.rms >= gate);
  const pitched = frames.map((f, i) => sounding[i] && f.m !== null && f.clarity >= minClarity);
  // The click is seen in the newest hop, which lies ahead of the centre of the pitch window.
  const lead = Math.round((WINDOW - HOP) / 2 / HOP);
  const onsets = findOnsets(frames, { clicks }).map(i => Math.min(frames.length - 1, i + lead));

  // 1. regions of continuous sound (short dropouts bridged), cut at pick attacks
  const regions = [];
  let from = -1, quiet = 0;
  const close = to => { if (from >= 0) regions.push([from, to]); from = -1; };
  frames.forEach((_, i) => {
    if (sounding[i]) { if (from < 0) from = i; quiet = 0; }
    else if (from >= 0 && ++quiet > span(0.06)) close(i - quiet);
  });
  close(frames.length - 1 - quiet);
  const pieces = [];
  for (const [a, b] of regions) {
    const cuts = [a, ...onsets.filter(o => o > a + span(0.03) && o < b - 1), b + 1];
    for (let c = 0; c + 1 < cuts.length; c++) pieces.push({ from: cuts[c], to: cuts[c + 1] - 1 });
  }

  // 2. inside a piece, split where the pitch jumps quickly and then settles on a new level
  const notes = [];
  for (const piece of pieces) {
    const idx = []; for (let i = piece.from; i <= piece.to; i++) if (pitched[i]) idx.push(i);
    if (idx.length < 3) continue; // a scrape, a thump, a pick noise: no note
    const m = idx.map((_, k) => median(idx.slice(Math.max(0, k - 1), k + 2).map(i => frames[i].m)));
    const cuts = [0];
    const w = span(0.035), settle = span(0.045);
    for (let k = settle; k + w + settle <= m.length; k++) {
      if (k - cuts[cuts.length - 1] < span(0.05)) continue;
      const before = m.slice(k - settle, k), after = m.slice(k + w, k + w + settle);
      const spread = list => Math.max(...list) - Math.min(...list);
      if (Math.abs(median(after) - median(before)) >= jump && spread(before) < 0.35 && spread(after) < 0.35) { cuts.push(k + Math.ceil(w / 2)); k += w; }
    }
    cuts.push(m.length);
    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c], b = cuts[c + 1];
      const part = idx.slice(a, b), curve = m.slice(a, b);
      if (part.length < 2) continue;
      // The note starts at the attack (even if the first frames are too noisy to pitch) and rings to the end of its piece.
      const startFrame = c === 0 ? piece.from : part[0];
      const endFrame = c + 2 === cuts.length ? piece.to : part[part.length - 1];
      const start = frames[startFrame].t - dt / 2, end = frames[endFrame].t + dt / 2;
      if (end - start < minNote) continue;
      const head = curve.slice(Math.min(1, curve.length - 1), Math.min(curve.length, 1 + span(0.06)));
      const pitch = Math.round(median(head));
      notes.push({ pitch, start, end, legato: c > 0, clarity: part.reduce((s, i) => s + frames[i].clarity, 0) / part.length,
        level: Math.max(...part.map(i => frames[i].rms)), ...classifyCurve(curve.map(v => v - pitch), dt) });
    }
  }
  return tidy(notes).filter(n => n.pitch >= lowest && n.pitch <= highest)
    // What is left of a leaked click: a very short, very high blip right on a click.
    .filter(n => !(n.end - n.start < 0.14 && clicks.some(c => Math.abs(n.start - c) < 0.09)));
}

/**
 * Remove artefacts of the attack. The first few milliseconds of a stroke are noisy and are often read an octave
 * off, or as a separate blip of the same note; those fragments belong to the note they touch.
 */
function tidy(notes) {
  const out = [];
  const touching = (a, b) => b.start - a.end < 0.03;
  const sameClass = (a, b) => (a.pitch - b.pitch) % 12 === 0;
  const short = x => x.end - x.start < 0.12;
  for (const n of notes) {
    const prev = out[out.length - 1];
    if (prev && touching(prev, n) && sameClass(prev, n)) {
      // A lead-in fragment joins the note that follows it: short, or flickering between octaves (an unsettled reading).
      const octaveFlicker = prev.pitch !== n.pitch;
      if ((short(prev) || prev.unsettled) && (octaveFlicker || !n.legato)) {
        const merged = { ...n, start: prev.start, legato: prev.legato };
        if (octaveFlicker && n.end - n.start < 0.25) { merged.unsettled = true; merged.level = Math.max(prev.level, n.level); }
        out[out.length - 1] = merged; continue;
      }
      // A short tail that is no louder joins the note before it.
      if (short(n) && n.level <= prev.level * 1.3 && (prev.pitch === n.pitch || n.legato)) { prev.end = n.end; continue; }
    }
    out.push({ ...n });
  }
  return out.map(({ unsettled, ...n }) => n);
}

/** Times (seconds) of the pick attacks in a set of frames. */
export function onsetTimes(frames, options) {
  const lead = Math.round((WINDOW - HOP) / 2 / HOP);
  return findOnsets(frames, options).map(i => frames[Math.min(frames.length - 1, i + lead)].t);
}

/**
 * Line the recording up with the beat grid.
 * Without a reference we do not know the interface delay, so the grid is slid (by less than half a step) to where
 * the note starts fit it best. Returns the shift in seconds and how tightly the playing sits on the grid (0–1).
 */
export function fitGrid(notes, origin, step) {
  if (notes.length < 3) return { shift: 0, tightness: 0 };
  let x = 0, y = 0;
  for (const n of notes) { const phase = 2 * Math.PI * ((n.start - origin) / step); x += Math.cos(phase); y += Math.sin(phase); }
  const tightness = Math.hypot(x, y) / notes.length;
  return { shift: tightness > 0.3 ? Math.atan2(y, x) / (2 * Math.PI) * step : 0, tightness };
}

/** Read bend and vibrato from a note's pitch deviation curve (semitones relative to its fretted pitch). */
export function classifyCurve(dev, dt) {
  const out = { bend: 0, bendRelease: false, vibrato: false };
  if (dev.length < 4) return out;
  const win = Math.max(1, Math.round(0.03 / dt));
  const smooth = dev.map((_, i) => median(dev.slice(Math.max(0, i - win), i + win + 1)));
  const peak = Math.max(...smooth);
  const held = smooth.filter(v => v >= peak - 0.3).length * dt;
  // Vibrato: the curve crosses its own slow trend several times a second.
  const slow = Math.max(2, Math.round(0.11 / dt));
  const trend = smooth.map((_, i) => { const s = smooth.slice(Math.max(0, i - slow), i + slow + 1); return s.reduce((a, b) => a + b, 0) / s.length; });
  const wobble = smooth.map((v, i) => v - trend[i]);
  let crossings = 0;
  for (let i = 1; i < wobble.length; i++) if ((wobble[i - 1] < 0) !== (wobble[i] < 0)) crossings++;
  const seconds = dev.length * dt, rate = crossings / 2 / seconds;
  const depth = Math.max(...wobble) - Math.min(...wobble);
  if (seconds >= 0.28 && depth >= 0.16 && rate >= 3 && rate <= 10) out.vibrato = true;
  // Bend: pitch rises well above the fretted note and stays there. Wide vibrato alone is not a bend.
  if (peak >= 0.7 && held >= 0.05 && !(out.vibrato && peak < 1.3 && Math.max(...trend) < 0.6)) {
    out.bend = Math.min(8, Math.max(2, Math.round(peak * 2))); // quarter tones: 2 = half step, 4 = whole step
    const tail = median(smooth.slice(-Math.max(2, Math.round(0.05 / dt))));
    const peakAt = smooth.indexOf(peak);
    out.bendRelease = peakAt < smooth.length * 0.75 && tail < peak * 0.4;
  }
  return out;
}

/** Whole pipeline for a recorded buffer. */
export function transcribe(samples, sampleRate, { range = 'guitar', frames, ...options } = {}) {
  const r = RANGES[range] ?? RANGES.guitar;
  return segmentNotes(frames ?? analyzeBuffer(samples, sampleRate, { range }), { lowest: r.lowest, highest: r.highest, ...options });
}
