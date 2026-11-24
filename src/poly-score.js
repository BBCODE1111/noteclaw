// Polyphonic notes → score: group simultaneous notes into chords on the beat grid, find playable chord
// shapes, and write alphaTex (tablature for guitar/bass, standard notation for piano and other instruments).
import { OPEN_STRINGS, possiblePositions, quantizeStarts } from './fingering.js';

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = midi => `${NOTE[midi % 12]}${Math.floor(midi / 12) - 1}`;

/**
 * Gather notes that start together (a strum is spread over a few tens of milliseconds) into chords and put
 * them on the grid. One chord per grid step; each lasts until the next chord, or until its notes stop.
 */
export function groupChords(notes, { origin, unit, strum = 0.06, quantize, snapEnd } = {}) {
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
  const steps = quantize ? kept.map(c => quantize(c.start - base)) : quantizeStarts(kept.map(c => c.start), base, unit);
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
    if (snapEnd) c.length = Math.max(1, Math.min(snapEnd(c.step + c.length, c.step) - c.step, next ? next.step - c.step : Infinity));
    c.pitches = [...new Set(c.notes.map(n => n.pitch))].sort((a, b) => a - b);
  });
  return chords;
}

/** Grid ticks per beat in the mixed grid: 3 per straight 16th, 2 per 16th-note triplet. */
export const TICKS = 12;
/**
 * Choose, beat by beat, whether the notes in it are straight 16ths or 16th-note triplets (only when the
 * triplet grid fits clearly better), and return how to place a start time (seconds from beat one) on that grid.
 */
export function mixedGrid(starts, beatSeconds, { bias = 0.6 } = {}) {
  const byBeat = new Map();
  for (const t of starts) {
    const b = t / beatSeconds, i = Math.floor(b + 1 / 24);
    if (!byBeat.has(i)) byBeat.set(i, []);
    byBeat.get(i).push(b - i);
  }
  const triplet = new Set();
  const err = (fr, div) => fr.reduce((sum, f) => sum + Math.abs(f - Math.round(f * div) / div), 0);
  for (const [i, fr] of byBeat) {
    const off = fr.filter(f => Math.abs(f * 4 - Math.round(f * 4)) > 0.22).length;
    if (fr.length >= 2 && off >= 1 && err(fr, 6) < bias * err(fr, 4)) triplet.add(i);
  }
  const quantize = t => {
    const b = Math.max(0, t / beatSeconds), i = Math.floor(b + 1 / 24), div = triplet.has(i) ? 6 : 4;
    return Math.max(0, Math.round(Math.round((b - i) * div) / div * TICKS) + i * TICKS);
  };
  // A note ends on the grid of the beat it ends in.
  const snapEnd = (end, start) => {
    const i = Math.floor(end / TICKS), g = triplet.has(i) ? 2 : 3, r = Math.round((end - i * TICKS) / g) * g + i * TICKS;
    return Math.max(r, start + (triplet.has(Math.floor(start / TICKS)) ? 2 : 3));
  };
  return { triplet, quantize, snapEnd };
}

/**
 * Every way to play a set of pitches at once: one note per string, lower notes on lower strings, and all
 * fretted notes within a four-fret hand span. Cheapest shapes first.
 */
/** Lead-playing preferences (tuned on transcribed solos with known fingering; see tools/bench.mjs). */
export const LEAD_COST = { fret: 0.04, zoneLo: 5, zoneHi: 15, zone: 0.15, top: 0.3, open: 2, skip: 0, str: 0 };
export function chordShapes(pitches, { tuning = OPEN_STRINGS, maxFret = 19, limit = 10, lead = false, leadCost = LEAD_COST } = {}) {
  const L = { ...LEAD_COST, ...leadCost };
  const options = pitches.map(p => possiblePositions(p, maxFret, tuning));
  const out = [];
  const walk = (i, used, lastString) => {
    if (i === pitches.length) {
      const fretted = used.filter(u => u.fret > 0).map(u => u.fret);
      const low = fretted.length ? Math.min(...fretted) : 0, span = fretted.length ? Math.max(...fretted) - low : 0;
      // Four fingers: a barre lets one finger hold several strings at the lowest fret.
      const fingers = fretted.filter(f => f !== low).length + (fretted.length ? 1 : 0);
      if (fingers > 4) return;
      // Lead playing stays in a fretted position; an open string is the exception (except the low strings).
      let extra = low * 0.06;
      if (lead) {
        const open = used.filter((u, k) => u.fret === 0 && pitches[k] > tuning[1]).length;
        const zone = !fretted.length ? 0 : low < L.zoneLo ? L.zoneLo - low : low > L.zoneHi ? low - L.zoneHi : 0;
        const top = used.filter(u => u.string === tuning.length).length; // notes on the highest string
        const skipped = used.length > 1 ? used[used.length - 1].string - used[0].string + 1 - used.length : 0;
        const height = used.reduce((sum, u) => sum + u.string - 1, 0) / used.length; // 0 = low E … 5 = high e
        extra = low * L.fret + zone * L.zone + top * L.top + open * L.open + skipped * L.skip + height * L.str;
      }
      out.push({ notes: used.map((u, k) => ({ ...u, pitch: pitches[k] })), hand: low, cost: span * 0.5 + fingers * 0.1 + extra });
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
      if (!i || !candidates[i - 1].length) return { cost: s.cost, prev: -1, hand: s.hand };
      let best = { cost: Infinity, prev: 0, hand: s.hand };
      candidates[i - 1].forEach((from, j) => {
        // An open-string shape leaves the hand where it was (for lead playing; chords may reset it).
        const fromHand = options.lead ? costs[i - 1][j].hand : from.hand;
        const shift = s.hand && fromHand ? Math.abs(s.hand - fromHand) : 0;
        const move = !shift ? 0 : options.lead ? (shift <= 2 ? 0.3 * shift : 1 + shift * 0.5) : 0.5 + shift * 0.35;
        const cost = costs[i - 1][j].cost + s.cost + move;
        if (cost < best.cost) best = { cost, prev: j, hand: s.hand || fromHand };
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

export function polyToAlphaTex(notes, { bpm = 110, subdivision = 16, origin, staff = 'tab', tuning = OPEN_STRINGS, maxFret = 19, title = 'Recorded', trackName = 'Guitar', timeSignature = 4, timeSignatureDenominator = 4, lead = false, grid = null } = {}) {
  if (!notes.length) throw new Error('還沒有可以轉譜的音符。');
  // grid 'mixed': straight 16ths or 16th triplets per beat (on TICKS per beat); otherwise a plain `subdivision` grid.
  const mixed = grid === 'mixed' ? mixedGrid(notes.map(n => n.start - (origin ?? 0)), 60 / bpm) : null;
  const unit = mixed ? 60 / bpm / TICKS : 60 / bpm * (4 / subdivision);
  const chords = groupChords(notes, { origin, unit, ...(mixed ? { quantize: mixed.quantize, snapEnd: mixed.snapEnd } : {}) });
  if (!chords.length) throw new Error('預備拍結束後沒有錄到音符。');
  const report = staff === 'tab' ? fingerChords(chords, { tuning, maxFret, lead }) : { shapes: [], dropped: 0, simplified: 0, unplayable: 0 };
  const barUnits = mixed ? TICKS * timeSignature * 4 / timeSignatureDenominator : Math.round(subdivision * timeSignature / timeSignatureDenominator);
  const tokens = timeSignature === 4 && timeSignatureDenominator === 4 ? [] : [`\\ts ${timeSignature} ${timeSignatureDenominator}`];
  let skipped = 0;
  let at = 0;
  const put = (first, rest, units) => mixed ? putMixed(first, rest, units) : putPlain(first, rest, units);
  // Mixed grid: in a triplet beat write 16th / 8th triplets that stay inside the beat; elsewhere straight
  // values (in ticks: 16th 3, 8th 6, quarter 12, half 24, whole 48) that never run into a triplet beat.
  const putMixed = (first, rest, units) => {
    let remaining = units, token = first;
    while (remaining > 0) {
      const beat = Math.floor(at / TICKS), inBeat = at - beat * TICKS;
      let chunk, value, tu = '';
      if (mixed.triplet.has(beat)) {
        const max = Math.min(remaining, TICKS - inBeat);
        chunk = max >= 4 && inBeat % 4 === 0 ? 4 : max >= 2 ? 2 : max; value = chunk === 4 ? 8 : 16; tu = ' {tu 3}';
        if (chunk < 2) { chunk = max; value = 32; tu = ' {tu 3}'; } // leftover tick after rounding
      } else {
        let max = Math.min(remaining, barUnits - at % barUnits);
        for (let b = beat + 1; b * TICKS < at + max; b++) if (mixed.triplet.has(b)) { max = b * TICKS - at; break; }
        chunk = [48, 24, 12, 6, 3].find(v => v <= max && at % v === 0) ?? (max >= 3 ? 3 : max);
        value = { 48: 1, 24: 2, 12: 4, 6: 8, 3: 16 }[chunk] ?? 32;
      }
      tokens.push(`${token}.${value}${tu}`);
      token = rest; at += chunk; remaining -= chunk;
      if (at % barUnits === 0) tokens.push('|');
    }
  };
  const putPlain = (first, rest, units) => {
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
