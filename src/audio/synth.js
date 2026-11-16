// Synthetic plucked-string audio (used by the tests and by the in-app demo): harmonic tone, pick attack, natural decay, phase-continuous pitch.
// Each event: { at, dur, midi | (t)=>midi, pick = true }. With pick:false the level carries on from the previous
// note and only the pitch changes, which is what a hammer-on or pull-off does to the signal.
export function synth(events, { sampleRate = 48000, tail = 0.3, noise = 0.0015 } = {}) {
  const end = Math.max(...events.map(e => e.at + e.dur)) + tail;
  const out = new Float32Array(Math.ceil(end * sampleRate));
  let phase = 0, env = 0, seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const e = events.find(x => t >= x.at && t < x.at + x.dur);
    if (e) {
      const local = t - e.at;
      if (e.pick !== false && local < 1 / sampleRate) env = 0.0001;       // new pick: level restarts
      if (e.pick !== false && local < 0.004) env = Math.max(env, 0.5 * local / 0.004);
      const midi = typeof e.midi === 'function' ? e.midi(local) : e.midi;
      phase += 2 * Math.PI * 440 * 2 ** ((midi - 69) / 12) / sampleRate;
      env *= Math.exp(-1 / (0.9 * sampleRate));                           // string decay
    } else env *= Math.exp(-1 / (0.012 * sampleRate));                    // damped
    // Just before a stroke the pick rests on the string and chokes it for a few milliseconds.
    if (events.some(x => x.pick !== false && x.at - t > 0 && x.at - t < 0.006)) env *= Math.exp(-1 / (0.003 * sampleRate));
    let s = 0;
    for (let k = 1; k <= 6; k++) s += Math.sin(k * phase) / k;
    // A pick stroke starts with a short broadband click before the string rings.
    const click = e && e.pick !== false && t - e.at < 0.003 ? 0.12 * rand() : 0;
    out[i] = env * s * 0.6 + noise * rand() + click;
  }
  return { samples: out, sampleRate };
}
