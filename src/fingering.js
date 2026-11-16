// MIDI open-string pitches, alphaTab's numbering is 1=lowest pitched string, 6=highest.
export const OPEN_STRINGS = [40, 45, 50, 55, 59, 64];
export const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const texNote = midi => `${['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][midi % 12]}${Math.floor(midi / 12) - 1}`;
export function midiName(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
export const BASS_STRINGS = [28, 33, 38, 43];
/** Every string/fret that produces `pitch`. `open` lists the open strings from lowest to highest. */
export function possiblePositions(pitch, maxFret = 19, open = OPEN_STRINGS) {
  return open.flatMap((open, i) => {
    const fret = pitch - open;
    return fret >= 0 && fret <= maxFret ? [{ string: i + 1, fret }] : [];
  });
}
// Fingering modes:
//   smooth   — stay in position, few shifts (default)
//   solo     — favour the plain strings and the middle of the neck, where bends and vibrato work
//   low/high — pull towards the nut / towards the 12th fret
//   position — only frets minFret..maxFret (open strings allowed when minFret is 0)
function staticCost(p, bias, hint, strings = 6) {
  let cost = p.fret === 0 ? 0.35 : 0;
  if (bias === 'low') cost += p.fret * 0.4;
  else if (bias === 'high') cost += Math.abs(p.fret - 12) * 0.3;
  else if (bias === 'solo') cost += (strings - p.string) * 0.45 + (p.fret < 5 ? (5 - p.fret) * 0.35 : 0) + (p.fret > 17 ? (p.fret - 17) * 0.3 : 0) + (p.fret === 0 ? 2 : 0);
  else cost += Math.abs(p.fret - 5) * 0.06;
  // A bend needs a fretted note, and is far easier on the plain strings away from the nut.
  if (hint?.bend) cost += (p.fret === 0 ? 8 : p.fret < 3 ? 1.2 : 0) + (p.string <= 3 ? 1.5 : 0);
  if (hint?.vibrato && p.fret === 0) cost += 3;
  return cost;
}
// The search tracks the hand, not just the fingertip: each state is a string/fret plus the fret the index
// finger sits at. Four fingers cover four frets (a fifth with a stretch), so notes inside that span are free
// and only moving the whole hand costs. Without this the cheapest path creeps up one string fret by fret.
function handStates(candidate) {
  if (candidate.fret === 0) return Array.from({ length: 20 }, (_, i) => ({ ...candidate, hand: i + 1, stretch: 0 }));
  const out = [];
  for (let hand = Math.max(1, candidate.fret - 4); hand <= candidate.fret; hand++) out.push({ ...candidate, hand, stretch: candidate.fret - hand === 4 ? 0.8 : 0 });
  return out;
}
function changeCost(a, b, legato) {
  const strings = Math.abs(a.string - b.string);
  const shift = Math.abs(a.hand - b.hand);
  let cost = strings * 0.2 + (strings >= 3 ? 0.4 : 0) + (shift ? 0.5 + shift * 0.35 : 0);
  // Hammer-ons, pull-offs and slides happen along one string.
  if (legato && strings !== 0) cost += 4;
  return cost;
}
/**
 * Dynamic-programming fretboard path for a monophonic phrase.
 * `hints[i]` may carry { legato, bend, vibrato } for note i (legato = slurred from the previous note).
 */
export function optimizeFingering(pitches, { maxFret = 19, minFret = 0, bias = 'smooth', hints = [], tuning = OPEN_STRINGS } = {}) {
  if (!pitches.length) return [];
  const candidates = pitches.map(p => {
    const all = possiblePositions(p, bias === 'position' ? Math.max(maxFret, minFret) : maxFret, tuning);
    if (bias !== 'position') return all;
    const inside = all.filter(c => c.fret >= minFret);
    if (inside.length) return inside;
    // The note does not exist inside the chosen position: write it at the spot closest to that position.
    const anywhere = possiblePositions(p, 24, tuning);
    const off = c => (c.fret < minFret ? minFret - c.fret : c.fret > maxFret ? c.fret - maxFret : 0);
    const nearest = Math.min(...anywhere.map(off));
    return anywhere.filter(c => off(c) === nearest);
  });
  if (candidates.some(x => !x.length)) {
    throw new Error('至少一個音超出這個樂器的可演奏音域，請調整最高格數或確認選對樂器。');
  }
  const states = candidates.map(list => list.flatMap(handStates));
  const costs = [];
  for (let index = 0; index < states.length; index++) {
    costs.push(states[index].map(p => {
      const base = staticCost(p, bias, hints[index], tuning.length) + p.stretch;
      if (!index) return { cost: base, prev: -1 };
      let best = { cost: Infinity, prev: 0 };
      states[index - 1].forEach((from, j) => {
        const c = costs[index - 1][j].cost + changeCost(from, p, hints[index]?.legato) + base;
        if (c < best.cost) best = { cost: c, prev: j };
      });
      return best;
    }));
  }
  let j = costs.at(-1).reduce((best, item, i, all) => item.cost < all[best].cost ? i : best, 0);
  const path = Array(pitches.length);
  for (let i = pitches.length - 1; i >= 0; i--) {
    const st = states[i][j];
    path[i] = { string: st.string, fret: st.fret, pitch: pitches[i] };
    j = costs[i][j].prev;
  }
  return path;
}

/**
 * Snap note starts to grid steps the way a listener would: by following the player.
 * People push and drag against the click by tens of milliseconds for whole phrases, so each start is judged
 * against where the player currently is (a slowly updated offset), not against the bare metronome.
 */
export function quantizeStarts(starts, origin, unit) {
  let drift = 0;
  return starts.map(t => {
    const exact = (t - origin - drift) / unit;
    const step = Math.max(0, Math.round(exact));
    drift = Math.max(-0.45 * unit, Math.min(0.45 * unit, drift + 0.3 * (exact - step) * unit));
    return step;
  });
}

/**
 * Convert monophonic notes to alphaTex bars.
 * Notes may carry { legato, bend (quarter tones), bendRelease, vibrato }; these are written as techniques.
 * `origin` is the time of beat one. Without it the first note is taken as beat one.
 */
export function notesToAlphaTex(events, { bpm = 110, subdivision = 16, bias = 'smooth', maxFret = 19, minFret = 0, title = 'Recorded Guitar', timeSignature = 4, origin, tuning = OPEN_STRINGS, trackName = 'Guitar' } = {}) {
  if (!events.length) throw new Error('還沒有可以轉譜的音符。');
  const unit = 60 / bpm * (4 / subdivision);
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const baseTime = origin ?? sorted[0].start;
  const kept = sorted.filter(e => e.start - baseTime > -unit / 2);
  const steps = quantizeStarts(kept.map(e => e.start), baseTime, unit);
  const quantized = kept.map((e, i) => {
    // A string that is still ringing when the next note starts is one held note, not a note and a rest:
    // small gaps are the hand moving, not silence the player meant.
    const next = kept[i + 1];
    const end = next && next.start - e.end < Math.max(unit * 0.6, 0.12) ? next.start : e.end;
    // Length is counted on the grid too: up to the next note's step when the note rings into it.
    const length = next && end === next.start ? Math.max(1, steps[i + 1] - steps[i]) : Math.max(1, Math.round(Math.max(end - e.start, unit * 0.8) / unit));
    return { ...e, start: steps[i], length };
  });
  if (!quantized.length) throw new Error('預備拍結束後沒有錄到音符。');
  const positions = optimizeFingering(quantized.map(n => n.pitch), { bias, maxFret, minFret, hints: quantized, tuning });
  const barUnits = subdivision * timeSignature / 4;
  const tokens = [];
  let at = 0;
  const beat = (token) => tokens.push(token);
  /** Write `numberOfUnits` grid steps; a note longer than one written value continues as tied notes. */
  const putUnits = (first, rest, numberOfUnits) => {
    let remaining = numberOfUnits, token = first;
    const options = [16, 8, 4, 2, 1].filter(v => v <= barUnits);
    while (remaining > 0) {
      const inBar = barUnits - at % barUnits;
      const max = Math.min(remaining, inBar);
      const chunk = options.find(v => v <= max && (at % v === 0 || v === 1)) || 1;
      const denom = subdivision / chunk;
      if (denom >= 1 && denom <= 256) beat(`${token}.${denom}`);
      token = rest;
      at += chunk;
      remaining -= chunk;
      if (at % barUnits === 0) beat('|');
    }
  };
  quantized.forEach((n, i) => {
    const start = Math.max(at, n.start);
    if (start > at) putUnits('r', 'r', start - at);
    // A note cannot run into the next one.
    const next = quantized[i + 1];
    const length = next ? Math.max(1, Math.min(n.length, Math.max(next.start, start + 1) - start)) : n.length;
    // Model numbering is 1 = lowest string, but alphaTex numbers 1 = highest string.
    const texString = tuning.length + 1 - positions[i].string;
    const fx = [];
    if (n.bend) fx.push(n.bendRelease ? `b (0 ${n.bend} 0)` : `b (0 ${n.bend})`);
    if (n.vibrato) fx.push('v');
    if (next?.legato && positions[i + 1].string === positions[i].string && next.start <= start + length) fx.push('h');
    putUnits(`${positions[i].fret}.${texString}${fx.length ? `{${fx.join(' ')}}` : ''}`, `-.${texString}`, length);
  });
  if (at % barUnits) putUnits('r', 'r', barUnits - (at % barUnits));
  return `\\title "${String(title).replaceAll('"', "'")}"
\\tempo ${Math.round(bpm)}
\\track "${trackName}"${tuning === OPEN_STRINGS ? '' : ` \\tuning (${[...tuning].reverse().map(texNote).join(' ')})`}
. 
${tokens.join(' ')}`;
}
