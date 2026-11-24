// Polyphonic transcription (chords, double stops, piano) with Spotify's open-source Basic Pitch model.
// The model runs locally through TensorFlow.js; nothing is uploaded. It is loaded only when first used
// because it is large.
//
// What comes out is measured from the sound: which pitches sound, and when. It carries no bends, vibrato
// or legato marks, and (as always) no string or fret — those are chosen afterwards.

export const MODEL_RATE = 22050;

/** Resample to the rate the model expects. A box filter before decimation keeps aliasing out of the way. */
export function resample(samples, from, to = MODEL_RATE) {
  if (from === to) return samples;
  const ratio = from / to, out = new Float32Array(Math.floor(samples.length / ratio));
  const width = Math.max(1, Math.round(ratio));
  for (let i = 0; i < out.length; i++) {
    const centre = i * ratio, start = Math.max(0, Math.floor(centre - width / 2));
    let sum = 0, n = 0;
    for (let k = start; k < Math.min(samples.length, start + width); k++) { sum += samples[k]; n++; }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

/**
 * Remove what the model hears that the player did not play: overtones of a louder note reported as notes of
 * their own (an octave, a twelfth, two octaves above it), and very short, faint blips.
 */
export function cleanPolyNotes(notes, { minLength = 0.07, minLevel = 0.3 } = {}) {
  const kept = notes.filter(n => n.end - n.start >= minLength && n.level >= minLevel);
  const sounding = (o, t) => o.start <= t + 0.03 && o.end > t + 0.02;
  const ghost = n => kept.some(o => {
    if (o === n) return false;
    const up = n.pitch - o.pitch;
    // An overtone of a louder note, reported together with it…
    if ([12, 19, 24, 28].includes(up) && o.level > n.level * 1.25 && Math.abs(n.start - o.start) < 0.12) return true;
    // …or surfacing later while that note is still ringing (short and clearly weaker).
    if ([12, 19, 24, 28].includes(up) && o.level > n.level * 1.5 && sounding(o, n.start) && n.end - n.start < 0.4) return true;
    // A weaker note one or two octaves below a note already sounding: the model hearing a sub-harmonic.
    if ([-12, -24].includes(up) && o.level > n.level * 1.25 && sounding(o, n.start)) return true;
    // The same pitch reported again inside a note that is still sounding.
    return o.pitch === n.pitch && o.start <= n.start && o.end > n.start + 0.02 && o.level >= n.level && o.start !== n.start;
  });
  return kept.filter(n => !ghost(n)).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

let cached = null;
/**
 * @param {Float32Array} samples mono audio
 * @param {number} sampleRate
 * @param {object} o
 * @param {string|object} o.model URL of model.json, or an already loaded TensorFlow.js graph model
 * @param {(fraction:number)=>void} [o.onProgress]
 * @returns {Promise<{pitch:number,start:number,end:number,level:number}[]>}
 */
export async function transcribePoly(samples, sampleRate, { model, onProgress = () => {}, lowest = 21, highest = 108, onsetThreshold = 0.5, frameThreshold = 0.3, onFallback = () => {} } = {}) {
  const mod = await import('@spotify/basic-pitch');
  const api = mod.BasicPitch ? mod : mod.default;
  if (!cached || cached.source !== model) cached = { source: model, basic: new api.BasicPitch(model) };
  const audio = resample(samples, sampleRate);
  // The model expects roughly full-scale audio; a quiet DI would otherwise fall under its thresholds.
  let peak = 0; for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  const gain = peak > 0.001 ? Math.min(40, 0.8 / peak) : 1;
  const scaled = gain === 1 ? audio : audio.map(v => v * gain);
  let frames = [], onsets = [], contours = [];
  const run = () => cached.basic.evaluateModel(scaled, (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, onProgress);
  try { await run(); }
  catch (err) {
    // Some graphics drivers fail to compile one of TensorFlow's WebGL shaders for certain audio lengths.
    // The CPU backend is slower but always works: switch to it and start over.
    const tf = await import('@tensorflow/tfjs');
    if (tf.getBackend() === 'cpu') throw err;
    console.warn('Basic Pitch on WebGL failed, retrying on the CPU', err);
    onFallback();
    await tf.setBackend('cpu');
    cached = { source: model, basic: new api.BasicPitch(model) };
    frames = []; onsets = []; contours = [];
    await run();
  }
  const events = api.noteFramesToTime(api.outputToNotesPoly(frames, onsets, onsetThreshold, frameThreshold, 5));
  return cleanPolyNotes(events.map(e => ({ pitch: e.pitchMidi, start: e.startTimeSeconds, end: e.startTimeSeconds + e.durationSeconds, level: e.amplitude })))
    .filter(n => n.pitch >= lowest && n.pitch <= highest);
}
