// Standard MIDI file → score. Every track is kept: chords stay chords, drums go to a drum staff, guitar and bass
// become tablature with playable fingerings, everything else standard notation. The key is read from the file,
// or worked out from the notes, so numbered notation (簡譜) shows the right "1 =".
import { polyToAlphaTex } from './poly-score.js';
import { OPEN_STRINGS, BASS_STRINGS } from './fingering.js';
import { GM_INSTRUMENTS } from './ui/gm.js';

const decode = (bytes, from, n) => String.fromCharCode(...bytes.slice(from, from + n));
function readVar(b, cursor) {
  let num = 0;
  for (let i = 0; i < 4; i++) {
    if (cursor.pos >= b.length) throw new Error('MIDI 檔案不完整');
    const v = b[cursor.pos++];
    num = (num << 7) | (v & 127);
    if (!(v & 128)) return num;
  }
  throw new Error('MIDI delta time 格式錯誤');
}

/** Parse a Type 0/1 file into notes per (track, channel), plus tempo, time and key signatures. */
export function parseMidi(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (decode(b, 0, 4) !== 'MThd') throw new Error('不是 Standard MIDI 檔案');
  const hdSize = dv.getUint32(4);
  const format = dv.getUint16(8), numTracks = dv.getUint16(10), division = dv.getUint16(12);
  if (format > 1 || (division & 0x8000)) throw new Error('目前僅支援 MIDI Type 0/1（PPQ 時基）');
  let at = 8 + hdSize;
  const parts = new Map(), tempos = [], timeSigs = [], keySigs = [];
  for (let track = 0; track < numTracks; track++) {
    if (decode(b, at, 4) !== 'MTrk') throw new Error('MIDI 軌道格式錯誤');
    const length = dv.getUint32(at + 4); const end = at + 8 + length;
    if (end > b.length) throw new Error('MIDI 軌道長度不正確');
    const cursor = { pos: at + 8 };
    let tick = 0, status = 0, name = '';
    const active = new Map(), programs = new Map();
    while (cursor.pos < end) {
      tick += readVar(b, cursor);
      let code = b[cursor.pos];
      if (code < 0x80) { if (!status) throw new Error('MIDI running status 缺失'); code = status; }
      else { cursor.pos++; if (code < 0xf0) status = code; }
      if (code === 0xff) {
        const type = b[cursor.pos++]; const len = readVar(b, cursor);
        if (cursor.pos + len > end) throw new Error('MIDI meta 長度錯誤');
        if (type === 0x51 && len === 3) tempos.push({ tick, us: (b[cursor.pos] << 16) | (b[cursor.pos + 1] << 8) | b[cursor.pos + 2] });
        if (type === 0x58 && len >= 2) timeSigs.push({ tick, num: b[cursor.pos], den: 2 ** b[cursor.pos + 1] });
        if (type === 0x59 && len === 2) keySigs.push({ tick, sharps: (b[cursor.pos] << 24) >> 24, minor: b[cursor.pos + 1] === 1 });
        if (type === 0x03 && !name) name = new TextDecoder().decode(b.slice(cursor.pos, cursor.pos + len)).trim();
        cursor.pos += len; continue;
      }
      if (code === 0xf0 || code === 0xf7) { const n = readVar(b, cursor); cursor.pos += n; continue; }
      const cmd = code & 0xf0, ch = code & 15;
      const p1 = b[cursor.pos++]; const p2 = (cmd === 0xc0 || cmd === 0xd0) ? 0 : b[cursor.pos++];
      if (cmd === 0xc0) { programs.set(ch, p1); continue; }
      const key = `${ch}-${p1}`;
      if (cmd === 0x90 && p2 > 0) {
        if (!active.has(key)) active.set(key, []);
        active.get(key).push({ tick, velocity: p2 });
      } else if (cmd === 0x80 || (cmd === 0x90 && p2 === 0)) {
        const start = active.get(key)?.shift();
        if (!start || tick <= start.tick) continue;
        const id = `${track}:${ch}`;
        if (!parts.has(id)) parts.set(id, { track, channel: ch, name, notes: [] });
        parts.get(id).notes.push({ pitch: p1, startTick: start.tick, endTick: tick, level: start.velocity / 127 });
      }
    }
    for (const part of parts.values()) if (part.track === track) { part.name = part.name || name; part.program = programs.get(part.channel) ?? 0; }
    at = end;
  }
  tempos.sort((x, y) => x.tick - y.tick);
  return { division, parts: [...parts.values()].filter(p => p.notes.length), tempos, timeSig: timeSigs.sort((x, y) => x.tick - y.tick)[0], keySig: keySigs.sort((x, y) => x.tick - y.tick)[0], trackCount: numTracks };
}

// Krumhansl–Schmuckler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
/** Sharps (+) or flats (−) of the major key with tonic pitch class `pc` (F♯ written as G♭ is avoided: F♯ = 6). */
const sharpsOf = pc => { const k = (pc * 7) % 12; return k > 6 ? k - 12 : k; };
/** Most likely key of a set of notes, weighting each pitch class by how long it sounds. */
export function detectKey(notes) {
  const weight = Array(12).fill(0);
  for (const n of notes) weight[n.pitch % 12] += Math.max(1, n.endTick - n.startTick);
  const corr = (profile, tonic) => {
    const xs = weight.map((_, i) => weight[(i + tonic) % 12]);
    const mx = xs.reduce((a, b) => a + b) / 12, my = profile.reduce((a, b) => a + b) / 12;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < 12; i++) { num += (xs[i] - mx) * (profile[i] - my); dx += (xs[i] - mx) ** 2; dy += (profile[i] - my) ** 2; }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  };
  let best = { score: -2, tonic: 0, minor: false };
  for (let t = 0; t < 12; t++) for (const minor of [false, true]) {
    const score = corr(minor ? MINOR : MAJOR, t);
    if (score > best.score) best = { score, tonic: t, minor };
  }
  const majorTonic = best.minor ? (best.tonic + 3) % 12 : best.tonic;
  return { sharps: sharpsOf(majorTonic), minor: best.minor, name: `${NAMES[best.tonic]} ${best.minor ? '小調' : '大調'}`, confidence: best.score };
}
export const keyName = (sharps, minor) => {
  const majorPc = ((sharps * 7) % 12 + 12) % 12;
  return `${NAMES[minor ? (majorPc + 9) % 12 : majorPc]} ${minor ? '小調' : '大調'}`;
};

/** MIDI → alphaTex with every track. */
export function midiToAlphaTex(input, { title = 'Imported MIDI', subdivision = 16 } = {}) {
  const midi = parseMidi(input);
  if (!midi.parts.length) throw new Error('MIDI 裡沒有音符');
  const us = midi.tempos[0]?.us || 500000;
  const bpm = Math.round(60_000_000 / us);
  const secondsPerTick = us / 1_000_000 / midi.division;
  const ts = midi.timeSig ?? { num: 4, den: 4 };
  const bodies = [], summary = [];
  let dropped = 0, simplified = 0, skippedDrums = 0;
  for (const part of midi.parts) {
    const drums = part.channel === 9;
    const program = part.program ?? 0;
    const kind = drums ? 'drums' : program >= 24 && program <= 31 ? 'guitar' : program >= 32 && program <= 39 ? 'bass' : 'score';
    const notes = part.notes.map(n => ({ pitch: n.pitch, start: n.startTick * secondsPerTick, end: n.endTick * secondsPerTick, level: n.level }));
    const name = (part.name || (drums ? 'Drums' : GM_INSTRUMENTS[program]) || `Track ${bodies.length + 1}`).replaceAll('"', "'");
    const out = polyToAlphaTex(notes, { bpm, subdivision, origin: 0, staff: kind === 'drums' ? 'drums' : kind === 'score' ? 'score' : 'tab',
      tuning: kind === 'bass' ? BASS_STRINGS : OPEN_STRINGS, maxFret: 22, trackName: name, timeSignature: ts.num, timeSignatureDenominator: ts.den });
    // Each track keeps its own sound.
    bodies.push(kind === 'drums' ? out.body : out.body.replace(/^(\\track "[^"]*")/, `$1 \\instrument ${program}`).replace('\\instrument piano \\instrument', '\\instrument'));
    dropped += out.dropped; simplified += out.simplified; skippedDrums += out.skipped;
    summary.push({ name, kind, notes: notes.length });
  }
  const pitched = midi.parts.filter(p => p.channel !== 9).flatMap(p => p.notes);
  const key = midi.keySig ? { sharps: midi.keySig.sharps, minor: midi.keySig.minor, name: keyName(midi.keySig.sharps, midi.keySig.minor), fromFile: true }
    : pitched.length ? { ...detectKey(pitched), fromFile: false } : null;
  const tex = `\\title "${title.replaceAll('"', "'")}"\n\\tempo ${bpm}\n${bodies.join('\n')}`;
  return { tex, bpm, key, tracks: summary, trackCount: midi.trackCount, droppedChordNotes: dropped, simplifiedChords: simplified, skippedDrums, tempoChangeWarning: midi.tempos.length > 1 };
}
