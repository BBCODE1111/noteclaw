// Tempo, beats and bar lines from a recording, so notes heard in a video can be put on a grid and the
// video can follow the score bar by bar.
//
// onsetEnvelope: how much new sound starts in each ~23 ms frame (spectral flux on a log spectrum).
// estimateTempo: the beat period that best explains that envelope (autocorrelation with a mild preference
//   for moderate tempos).
// trackBeats: beat times that sit on onsets while keeping a steady pulse (dynamic programming, after
//   D. Ellis, "Beat tracking by dynamic programming", 2007). A player who drifts is followed beat by beat.
// findDownbeat: which of the beats is "1": the one where the bass and the most notes tend to start.

export const ENV_HOP = 256;
const FFT_SIZE = 1024;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * @returns {{env: Float32Array, low: Float32Array, rate: number}} onset strength per frame (all bands, and
 * below ~250 Hz), and frames per second.
 */
export function onsetEnvelope(samples, sampleRate) {
  const hop = Math.round(ENV_HOP * sampleRate / 22050), size = FFT_SIZE * Math.max(1, Math.round(sampleRate / 22050));
  const frames = Math.max(0, Math.floor((samples.length - size) / hop) + 1);
  const bins = size / 2, lowBins = Math.max(2, Math.round(250 / (sampleRate / size)));
  const win = new Float32Array(size).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const env = new Float32Array(frames), low = new Float32Array(frames);
  let prev = new Float32Array(bins);
  const re = new Float32Array(size), im = new Float32Array(size);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < size; i++) { re[i] = samples[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(bins);
    let all = 0, lo = 0;
    for (let k = 1; k < bins; k++) {
      mag[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) { all += d; if (k < lowBins) lo += d; }
    }
    env[f] = all; low[f] = lo; prev = mag;
  }
  // Frame i covers i·hop … i·hop+size, and its flux peaks as soon as an attack enters that window, which is
  // before the attack is heard at its full level; delay the envelope so frame i means time i·hop.
  const lag = Math.round(0.75 * size / hop);
  const shift = x => { const out = new Float32Array(x.length); out.set(x.subarray(0, x.length - lag), lag); return out; };
  return { env: normalise(shift(env)), low: normalise(shift(low)), rate: sampleRate / hop };
}

/** Remove the slowly changing level and scale to unit spread, so only the starts stand out. */
function normalise(x) {
  const out = new Float32Array(x.length), w = 16;
  for (let i = 0; i < x.length; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(x.length - 1, i + w); k++) { s += x[k]; n++; }
    out[i] = Math.max(0, x[i] - s / n);
  }
  let sd = 0; for (const v of out) sd += v * v; sd = Math.sqrt(sd / Math.max(1, out.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return out;
}

/** Beats per minute that best fit the envelope, between `min` and `max`. */
export function estimateTempo(env, rate, { min = 50, max = 200, prefer = 100 } = {}) {
  const lo = Math.floor(rate * 60 / max), hi = Math.ceil(rate * 60 / min);
  const score = lag => {
    let s = 0; for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    return s / (env.length - lag);
  };
  let best = { bpm: prefer, value: -Infinity };
  const ac = [];
  for (let lag = lo; lag <= hi + 2; lag++) ac[lag] = score(lag);
  for (let lag = lo; lag <= hi; lag++) {
    // A beat period also shows up at twice and half its length; add those so the true pulse wins.
    const at = l => (ac[Math.round(l)] ?? (Math.round(l) < ac.length ? score(Math.round(l)) : 0));
    const value = ac[lag] + 0.5 * at(lag * 2) + 0.25 * (at(lag / 2) + at(lag * 1.5));
    const bpm = 60 * rate / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / prefer) / 0.9) ** 2);
    if (value * weight > best.value) best = { bpm, value: value * weight, lag };
  }
  // Refine between whole frames.
  const l = best.lag, a = ac[l - 1] ?? 0, b = ac[l], c = ac[l + 1] ?? 0, d = a - 2 * b + c;
  const exact = d < 0 ? l + 0.5 * (a - c) / d : l;
  return 60 * rate / exact;
}

/** Beat times in seconds, following onsets while keeping close to `bpm`. */
export function trackBeats(env, rate, bpm, { tightness = 100 } = {}) {
  const period = 60 * rate / bpm, n = env.length;
  if (!n) return [];
  const score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, from = -1;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (from < 0 || v > best) { best = v; from = p; }
    }
    score[t] = env[t] + (from >= 0 ? Math.max(0, best) : 0);
    back[t] = from >= 0 && best > 0 ? from : -1;
  }
  // End on the best-scoring frame within the last beat.
  let t = n - 1;
  for (let k = Math.max(0, n - Math.round(period)); k < n; k++) if (score[k] > score[t]) t = k;
  const beats = [];
  while (t >= 0) { beats.push(t); t = back[t]; }
  beats.reverse();
  // Stretches with no sound leave gaps; fill them at the local pulse.
  const out = [];
  for (let i = 0; i < beats.length; i++) {
    out.push(beats[i]);
    const gap = beats[i + 1] - beats[i];
    if (gap > period * 1.5) { const k = Math.round(gap / period); for (let j = 1; j < k; j++) out.push(beats[i] + gap * j / k); }
  }
  return out.map(f => f / rate);
}

/**
 * Index (0…beatsPerBar-1) of the first beat that is a "1". Chords change most often on the downbeat, so a
 * new bass note weighs most; bass attacks and note starts in general help when there is no bass.
 */
export function findDownbeat(beats, { low, env, rate }, notes = [], beatsPerBar = 4) {
  const scores = phaseScores(beats, { low, env, rate }, notes, beatsPerBar);
  return scores.indexOf(Math.max(...scores));
}
export function phaseScores(beats, { low, env, rate }, notes = [], beatsPerBar = 4) {
  const at = (arr, t) => { const i = Math.round(t * rate); let m = 0; for (let k = i - 2; k <= i + 2; k++) m = Math.max(m, arr[k] ?? 0); return m; };
  // Bass line: the lowest note sounding, sampled on each beat; a change of bass note marks a chord change.
  const bassAt = t => { let best = null; for (const n of notes) if (n.pitch < 52 && n.start <= t + 0.08 && n.end > t + 0.1 && (!best || n.pitch < best.pitch)) best = n; return best?.pitch ?? null; };
  const scores = Array(beatsPerBar).fill(0);
  let lastBass = null;
  beats.forEach((t, i) => {
    const near = notes.filter(n => Math.abs(n.start - t) < 0.07);
    const bass = bassAt(t);
    const change = bass !== null && lastBass !== null && bass % 12 !== lastBass % 12;
    if (bass !== null) lastBass = bass;
    scores[i % beatsPerBar] += 3 * (change ? 1 : 0) + 0.5 * at(low, t) + 0.2 * at(env, t) + 0.15 * near.length;
  });
  return scores;
}

/**
 * Map a time in seconds to a position in beats (beat 0 = `beats[0]`), interpolating between beats and
 * extrapolating at the ends with the nearest beat length.
 */
export function timeToBeat(t, beats) {
  const n = beats.length;
  if (n < 2) return 0;
  if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0]);
  if (t >= beats[n - 1]) return n - 1 + (t - beats[n - 1]) / (beats[n - 1] - beats[n - 2]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] <= t) lo = m; else hi = m; }
  return lo + (t - beats[lo]) / (beats[hi] - beats[lo]);
}
