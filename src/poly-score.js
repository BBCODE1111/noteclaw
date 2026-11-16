// Polyphonic notes → score: group simultaneous notes into chords on the beat grid, find playable chord
// shapes, and write alphaTex (tablature for guitar/bass, standard notation for piano and other instruments).
import { OPEN_STRINGS, possiblePositions, quantizeStarts } from './fingering.js';

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = midi => `${NOTE[midi % 12]}${Math.floor(midi / 12) - 1}`;

/**
 * Gather notes that start together (a strum is spread over a few tens of milliseconds) into chords and put
 * them on the grid. One chord per grid step; each lasts until the next chord, or until its notes stop.
 */
export function groupChords(notes, { origin, unit, strum = 0.06 }) {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const clusters = [];
  for (const n of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && n.start - last.start <= strum) last.notes.push(n);
    else clusters.push({ start: n.start, notes: [n] });
  }
  // The model sometimes reports one note of a chord a little early, on its own. A lone lead-in whose pitches
  // all reappear in the chord right after it is that chord starting, not a separate stroke.
  for (let i = clusters.length - 2; i >= 0; i--) {
    const c = clusters[i], next = clusters[i + 1];
    const repeats = c.notes.every(n => next.notes.some(m => m.pitch === n.pitch) || n.end > next.start);
    if (next.start - c.start < 0.16 && c.notes.length < next.notes.length && repeats) {
      for (const n of c.notes) if (!next.notes.some(m => m.pitch === n.pitch)) next.notes.push(n);
      clusters.splice(i, 1);
    }
  }
  const base = origin ?? clusters[0]?.start ?? 0;
  const kept = clusters.filter(c => c.start - base > -unit / 2);
  const steps = quantizeStarts(kept.map(c => c.start), base, unit);
  const chords = [];
  kept.forEach((c, i) => {
    const prev = chords[chords.length - 1];
    if (prev && prev.step === steps[i]) { prev.notes.push(...c.notes); prev.end = Math.max(prev.end, ...c.notes.map(n => n.end)); return; }
    chords.push({ step: steps[i], start: c.start, end: Math.max(...c.notes.map(n => n.end)), notes: [...c.notes] });
  });
  chords.forEach((c, i) => {
    const next = chords[i + 1];
    // Still ringing when the next chord arrives (or nearly): held, not followed by a rest.
    const ringsOn = next && next.start - c.end < Math.max(unit * 0.6, 0.12);
    const own = Math.max(1, Math.round(Math.max(c.end - c.start, unit * 0.8) / unit));
    c.length = next ? (ringsOn ? next.step - c.step : Math.min(own, next.step - c.step)) : own;
    c.pitches = [...new Set(c.notes.map(n => n.pitch))].sort((a, b) => a - b);
  });
  return chords;
}

/**
 * Every way to play a set of pitches at once: one note per string, lower notes on lower strings, and all
 * fretted notes within a four-fret hand span. Cheapest shapes first.
 */
export function chordShapes(pitches, { tuning = OPEN_STRINGS, maxFret = 19, limit = 10 } = {}) {
  const options = pitches.map(p => possiblePositions(p, maxFret, tuning));
  const out = [];
  const walk = (i, used, lastString) => {
    if (i === pitches.length) {
      const fretted = used.filter(u => u.fret > 0).map(u => u.fret);
      const low = fretted.length ? Math.min(...fretted) : 0, span = fretted.length ? Math.max(...fretted) - low : 0;
      // Four fingers: a barre lets one finger hold several strings at the lowest fret.
      const fingers = fretted.filter(f => f !== low).length + (fretted.length ? 1 : 0);
      if (fingers > 4) return;
      out.push({ notes: used.map((u, k) => ({ ...u, pitch: pitches[k] })), hand: low, cost: span * 0.5 + low * 0.06 + fingers * 0.1 });
      return;
    }
    for (const o of options[i]) {
      if (o.string <= lastString) continue;
      const fretted = [...used.filter(u => u.fret > 0).map(u => u.fret), ...(o.fret > 0 ? [o.fret] : [])];
      if (fretted.length && Math.max(...fretted) - Math.min(...fretted) > 4) continue;
      walk(i + 1, [...used, o], o.string);
    }
  };
  walk(0, [], 0);
  return out.sort((a, b) => a.cost - b.cost).slice(0, limit);
}

/**
 * Choose a shape for every chord so the hand moves as little as possible from one to the next.
 * A chord that cannot be played as written loses its quietest inner notes until it can; `dropped` counts them.
 */
export function fingerChords(chords, options = {}) {
  let dropped = 0, simplified = 0;
  const candidates = chords.map(c => {
    let pitches = [...c.pitches].slice(0, 12), shapes = chordShapes(pitches, options);
    const level = p => Math.max(...c.notes.filter(n => n.pitch === p).map(n => n.level ?? 1));
    let removed = 0;
    while (!shapes.length && pitches.length > 1) {
      // Keep the bass and the top note (what the ear follows); thin out the middle, quietest first.
      const inner = pitches.length > 2 ? pitches.slice(1, -1) : [pitches[0]];
      const victim = inner.reduce((a, b) => (level(b) < level(a) ? b : a));
      pitches = pitches.filter(p => p !== victim); removed++;
      shapes = chordShapes(pitches, options);
    }
    if (removed) { dropped += removed; simplified++; }
    return shapes;
  });
  const costs = [];
  candidates.forEach((shapes, i) => {
    costs.push(shapes.map(s => {
      if (!i || !candidates[i - 1].length) return { cost: s.cost, prev: -1 };
      let best = { cost: Infinity, prev: 0 };
      candidates[i - 1].forEach((from, j) => {
        const shift = s.hand && from.hand ? Math.abs(s.hand - from.hand) : 0;
        const cost = costs[i - 1][j].cost + s.cost + (shift ? 0.5 + shift * 0.35 : 0);
        if (cost < best.cost) best = { cost, prev: j };
      });
      return best;
    }));
  });
  const chosen = Array(chords.length).fill(null);
  let j = -1;
  for (let i = chords.length - 1; i >= 0; i--) {
    if (!candidates[i].length) { j = -1; continue; }
    if (j < 0) j = costs[i].reduce((b, x, k, all) => (x.cost < all[b].cost ? k : b), 0);
    chosen[i] = candidates[i][j].notes;
    j = costs[i][j].prev;
  }
  return { shapes: chosen, dropped, simplified, unplayable: chosen.filter(x => !x).length };
}

/**
 * @param {{pitch:number,start:number,end:number,level?:number}[]} notes
 * @param {object} o
 * @param {'tab'|'score'} [o.staff] tablature (needs `tuning`) or standard notation
 * @returns {{tex:string, chords:number, dropped:number, simplified:number, unplayable:number}}
 */
/** General MIDI drum numbers → alphaTex drum names. Sounds without a kit piece fall back to the closest one. */
export const GM_DRUM_NAMES = {
  35: 'Kick (hit)', 36: 'Kick (hit) 2', 37: 'Snare (side stick)', 38: 'Snare (hit)', 39: 'Snare (hit)', 40: 'Snare (hit)',
  41: 'Very Low Tom (hit)', 42: 'Hi-Hat (closed)', 43: 'Very Low Tom (hit)', 44: 'Pedal Hi-Hat (hit)', 45: 'Low Tom (hit)', 46: 'Hi-Hat (open)',
  47: 'Mid Tom (hit)', 48: 'High Tom (hit)', 49: 'Crash high (hit)', 50: 'High Floor Tom (hit)', 51: 'Ride (middle)', 52: 'China (hit)',
  53: 'Ride (bell)', 54: 'Tambourine (hit)', 55: 'Splash (hit)', 56: 'Cowbell medium (hit)', 57: 'Crash medium (hit)', 59: 'Ride (middle)'
};

export function polyToAlphaTex(notes, { bpm = 110, subdivision = 16, origin, staff = 'tab', tuning = OPEN_STRINGS, maxFret = 19, title = 'Recorded', trackName = 'Guitar', timeSignature = 4, timeSignatureDenominator = 4 } = {}) {
  if (!notes.length) throw new Error('還沒有可以轉譜的音符。');
  const unit = 60 / bpm * (4 / subdivision);
  const chords = groupChords(notes, { origin, unit });
  if (!chords.length) throw new Error('預備拍結束後沒有錄到音符。');
  const report = staff === 'tab' ? fingerChords(chords, { tuning, maxFret }) : { shapes: [], dropped: 0, simplified: 0, unplayable: 0 };
  const barUnits = Math.round(subdivision * timeSignature / timeSignatureDenominator);
  const tokens = timeSignature === 4 && timeSignatureDenominator === 4 ? [] : [`\\ts ${timeSignature} ${timeSignatureDenominator}`];
  let skipped = 0;
  let at = 0;
  const put = (first, rest, units) => {
    let remaining = units, token = first;
    const sizes = [16, 8, 4, 2, 1].filter(v => v <= barUnits);
    while (remaining > 0) {
      const max = Math.min(remaining, barUnits - at % barUnits);
      const chunk = sizes.find(v => v <= max && (at % v === 0 || v === 1)) || 1;
      tokens.push(`${token}.${subdivision / chunk}`);
      token = rest; at += chunk; remaining -= chunk;
      if (at % barUnits === 0) tokens.push('|');
    }
  };
  chords.forEach((c, i) => {
    const start = Math.max(at, c.step);
    if (start > at) put('r', 'r', start - at);
    const next = chords[i + 1];
    const length = next ? Math.max(1, Math.min(c.length, Math.max(next.step, start + 1) - start)) : c.length;
    if (staff === 'drums') {
      const names = [...new Set(c.pitches.map(p => GM_DRUM_NAMES[p]).filter(Boolean))];
      skipped += c.pitches.filter(p => !GM_DRUM_NAMES[p]).length;
      if (!names.length) { put('r', 'r', length); return; }
      put(`(${names.map(n => `"${n}"`).join(' ')})`, 'r', length); // a drum hit does not sustain: the rest of its length is silence
      return;
    }
    if (staff === 'tab') {
      const shape = report.shapes[i];
      if (!shape) { put('r', 'r', length); return; } // nothing in this chord fits the instrument
      const s = n => tuning.length + 1 - n.string; // alphaTex counts strings from the highest
      put(`(${shape.map(n => `${n.fret}.${s(n)}`).join(' ')})`, `(${shape.map(n => `-.${s(n)}`).join(' ')})`, length);
    } else {
      put(`(${c.pitches.map(noteName).join(' ')})`, `(${c.pitches.map(p => `${noteName(p)}{t}`).join(' ')})`, length);
    }
  });
  if (at % barUnits) put('r', 'r', barUnits - at % barUnits);
  const header = staff === 'drums' ? `\\track "${trackName}" \\instrument percussion \\articulation defaults` : staff === 'tab'
    ? `\\track "${trackName}"${tuning === OPEN_STRINGS ? '' : ` \\tuning (${[...tuning].reverse().map(noteName).join(' ')})`}`
    : `\\track "${trackName}" \\staff {score} \\tuning piano \\instrument piano`;
  const body = `${header}\n${tokens.join(' ')}`;
  const tex = `\\title "${String(title).replaceAll('"', "'")}"\n\\tempo ${Math.round(bpm)}\n${body}`;
  return { tex, body, chords: chords.length, dropped: report.dropped, simplified: report.simplified, unplayable: report.unplayable, skipped };
}
