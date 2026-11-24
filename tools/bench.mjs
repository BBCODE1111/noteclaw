// node tools/bench.mjs dir [name-filter] : grade the automatic transcription against known-good tabs.
// dir holds <name>.wav (22050 Hz mono), <name>.frames.json (tools/poly-frames.mjs) and <name>.truth.json
// (tools/ptb-notes.mjs). Grades what the app would write: the notes after lead filtering and quantising.
// OPTS='{"onset":0.4,...}' changes settings for an experiment; ROWS=1 lists every lick, SD=1 / OFFS=1 show string and timing errors.
// Corpus used so far: 40 Mateus Asato licks (JamTrackCentral) with their .ptb tabs — see tools/ptb-notes.mjs.
import fs from 'node:fs';
import path from 'node:path';
import bp from '@spotify/basic-pitch';
import { cleanPolyNotes } from '../src/audio/poly.js';
import { analyseRhythm, leadNotes, warpNotes } from '../src/audio/video-tab.js';
import { timeToBeat } from '../src/audio/beats.js';
import { groupChords, fingerChords, mixedGrid, TICKS } from '../src/poly-score.js';

const [,, dir, filter = ''] = process.argv;
const opts = JSON.parse(process.env.OPTS || '{}');
function readWav(f) {
  const buf = fs.readFileSync(f); let off = 12, data, rate;
  while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
  const s = new Float32Array(data.length / 2); for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  return { s, rate };
}
export function grade(name) {
  const { s, rate } = readWav(path.join(dir, name + '.wav'));
  const { frames, onsets } = JSON.parse(fs.readFileSync(path.join(dir, name + '.frames.json')));
  const ev = bp.noteFramesToTime(bp.outputToNotesPoly(frames, onsets, opts.onset ?? 0.65, opts.frame ?? 0.2, opts.minLen ?? 5));
  const raw = cleanPolyNotes(ev.map(e => ({ pitch: e.pitchMidi, start: e.startTimeSeconds, end: e.startTimeSeconds + e.durationSeconds, level: e.amplitude })), opts.clean);
  // RHYTHM_DIR: take beats and bar lines from another copy of the audio (e.g. the full mix, when `dir` holds a
  // separated guitar track that has lost the drums and bass).
  const rdir = process.env.RHYTHM_DIR;
  const rhythm = rdir ? (() => {
    const m = readWav(path.join(rdir, name + '.wav')), f = JSON.parse(fs.readFileSync(path.join(rdir, name + '.frames.json')));
    const e = bp.noteFramesToTime(bp.outputToNotesPoly(f.frames, f.onsets, opts.onset ?? 0.65, opts.frame ?? 0.2, opts.minLen ?? 5));
    const mixNotes = cleanPolyNotes(e.map(x => ({ pitch: x.pitchMidi, start: x.startTimeSeconds, end: x.startTimeSeconds + x.durationSeconds, level: x.amplitude })), opts.clean);
    return analyseRhythm(m.s, m.rate, process.env.RHYTHM_NOTES === 'own' ? raw : mixNotes, opts.rhythm);
  })() : analyseRhythm(s, rate, raw, opts.rhythm);
  const notes = opts.noLead ? raw.filter(n => n.pitch >= 40) : leadNotes(raw, opts.lead);
  const truthPos = JSON.parse(fs.readFileSync(path.join(dir, name + '.truth.json')));
  const truth = truthPos.filter(p => !p.rest && !p.grace).flatMap(p => p.notes.filter(n => !(parseInt(n.d, 16) & 1)).map(n => ({ step: p.beat * TICKS, pitch: n.pitch, string: 7 - n.s, fret: n.f })));
  const endStep = Math.round((truthPos[truthPos.length - 1]?.beat ?? 0) * 4) + 4; // in 16ths
  // Write as the app does, for each candidate bar alignment; keep the best (and note which one the app chose).
  const bpm = Math.round(rhythm.bpm), sec = 60 / bpm;
  const evaluate = (shift, finger) => {
    const start = rhythm.downbeat + shift;
    const warped = warpNotes(notes, rhythm, start, { swing: !opts.noSwing }).notes
      .filter(n => n.start > -sec / 4 && n.start / sec * 4 < endStep);
    if (!warped.length) return null;
    const g = opts.noMixed ? null : mixedGrid(warped.map(n => n.start), sec, opts.grid);
    const chords = g ? groupChords(warped, { origin: 0, unit: sec / TICKS, quantize: g.quantize, snapEnd: g.snapEnd })
      : groupChords(warped, { origin: 0, unit: sec / 4 }).map(c => ({ ...c, step: c.step * 3 }));
    // Alignment is chosen on pitches and timing alone; the fingering is worked out once, for the best one.
    const shapes = finger ? fingerChords(chords, { maxFret: 22, lead: true, ...(opts.finger || {}) }).shapes
      : chords.map(c => c.pitches.map(pitch => ({ pitch, string: 0, fret: -1 })));
    const written = chords.flatMap((c, i) => (shapes[i] || []).map(n => ({ step: c.step, pitch: n.pitch, string: n.string, fret: n.fret, raw: c.start / sec * TICKS })));
    const used = new Set(); let hit = 0, exact = 0, fing = 0; const offs = [];
    for (const t of truth) {
      let k = written.findIndex((w, i) => !used.has(i) && w.pitch === t.pitch && Math.abs(w.step - t.step) < 0.2);
      if (k < 0) k = written.findIndex((w, i) => !used.has(i) && w.pitch === t.pitch && Math.abs(w.step - t.step) <= 3.2);
      if (k < 0) continue;
      used.add(k); hit++; offs.push([written[k].raw - t.step, name]);
      if (Math.abs(written[k].step - t.step) < 0.2) exact++;
      if (written[k].string === t.string && written[k].fret === t.fret) fing++;
      if (finger) (globalThis.SD ??= []).push(written[k].string - t.string);
    }
    return { shift, f1: 2 * hit / (truth.length + written.length), hit, exact, fing, written: written.length, offs };
  };
  let best = null;
  for (let shift = -24; shift <= 24; shift++) { const r = evaluate(shift, false); if (r && (!best || r.f1 > best.f1)) best = r; }
  if (best) best = evaluate(best.shift, true);
  return { name, bpm: rhythm.bpm, truth: truth.length, ...best };
}
const names = fs.readdirSync(dir).filter(f => f.endsWith('.truth.json')).map(f => f.replace('.truth.json', ''))
  .filter(n => n.includes(filter) && fs.existsSync(path.join(dir, n + '.frames.json')));
const rows = names.map(grade);
let T = 0, H = 0, W = 0, E = 0, F = 0, bars = 0;
for (const r of rows) {
  T += r.truth; H += r.hit; W += r.written; E += r.exact; F += r.fing; if (((r.shift % 4) + 4) % 4 === 0) bars++;
  if (process.env.ROWS) console.log(r.name.replace(/ma_|licks?|soloing|melodicfreedom/g, '').padEnd(14), `bpm ${r.bpm.toFixed(0).padStart(3)}`, `found ${r.hit}/${r.truth}`, `extra ${r.written - r.hit}`, `exact ${r.exact}`, `fret ${r.fing}`, `downbeat ${r.shift}`);
}
if (process.env.SD) { const h = {}; for (const d of globalThis.SD ?? []) h[d] = (h[d] || 0) + 1; console.log('our string − true string (model numbering, + = higher string):', JSON.stringify(h)); }
if (process.env.MISS) { const h = {}; for (const m of globalThis.MISS ?? []) h[m] = (h[m] || 0) + 1; console.log(Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}:${v}`).join(' ')); }
if (process.env.OFFS) {
  const all = rows.flatMap(r => r.offs.map(o => o[0]));
  const h = {}; for (const o of all) { const k = (Math.round(o * 4) / 4).toFixed(2); h[k] = (h[k] || 0) + 1; }
  console.log('detected − true start (16ths):', Object.entries(h).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '));
  for (const r of rows) { const m = r.offs.map(o => o[0]).sort((a, b) => a - b); console.log(r.name.slice(-16), 'median', m[m.length >> 1]?.toFixed(2)); }
}
console.log(`${rows.length} licks · notes found ${(100 * H / T).toFixed(1)}% · correct among written ${(100 * H / W).toFixed(1)}% · on the exact 16th ${(100 * E / H).toFixed(1)}% · same string+fret ${(100 * F / H).toFixed(1)}% · bar lines right ${bars}/${rows.length}`);
