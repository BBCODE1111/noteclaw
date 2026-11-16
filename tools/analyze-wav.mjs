// Run the transcription engine on a saved take:  node tools/analyze-wav.mjs take.wav
// Prints every detected note, plus a per-frame dump with --frames (for tuning thresholds against real playing).
// --bpm 80 also shows where each note falls on the 16th-note grid; --bass analyses the bass range.
import fs from 'node:fs';
import { analyzeBuffer, segmentNotes, fitGrid, RANGES } from '../src/audio/analysis.js';
import { midiName } from '../src/fingering.js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)), flag = args.includes('--frames') ? '--frames' : '';
const bpm = args.includes('--bpm') ? Number(args[args.indexOf('--bpm') + 1]) : 0;
const range = args.includes('--bass') ? 'bass' : 'guitar';
if (!file) { console.error('usage: node tools/analyze-wav.mjs <take.wav> [--frames]'); process.exit(1); }
const buf = fs.readFileSync(file), view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let pos = 12, fmt = null, data = null;
while (pos + 8 <= buf.length) {
  const id = buf.toString('latin1', pos, pos + 4), size = view.getUint32(pos + 4, true);
  if (id === 'fmt ') fmt = { format: view.getUint16(pos + 8, true), channels: view.getUint16(pos + 10, true), rate: view.getUint32(pos + 12, true), bits: view.getUint16(pos + 22, true) };
  if (id === 'data') data = { at: pos + 8, size };
  pos += 8 + size + (size % 2);
}
if (!fmt || !data) throw new Error('not a WAV file');
const step = fmt.bits / 8 * fmt.channels, n = Math.floor(data.size / step);
const samples = new Float32Array(n);
for (let i = 0; i < n; i++) {
  const at = data.at + i * step; // first channel only
  samples[i] = fmt.format === 3 ? view.getFloat32(at, true) : fmt.bits === 16 ? view.getInt16(at, true) / 32768 : fmt.bits === 24 ? ((view.getInt8(at + 2) << 16) | view.getUint16(at, true)) / 8388608 : view.getInt32(at, true) / 2147483648;
}
const frames = analyzeBuffer(samples, fmt.rate, { range });
const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
console.log(`${file}: ${(n / fmt.rate).toFixed(2)} s, ${fmt.rate} Hz, ${fmt.channels} ch, ${fmt.bits}-bit, peak ${peak.toFixed(3)}, pitched frames ${frames.filter(f => f.m !== null).length}/${frames.length}`);
if (flag === '--frames') for (const f of frames) console.log(f.t.toFixed(3), f.m === null ? '   --' : f.m.toFixed(2).padStart(6), 'rms', f.rms.toFixed(4), 'flux', (f.flux * 1e6).toFixed(1), 'clarity', f.clarity.toFixed(2));
const notes = segmentNotes(frames, { lowest: RANGES[range].lowest, highest: RANGES[range].highest });
let origin = 0, grid = 0;
if (bpm && notes.length) {
  grid = 60 / bpm / 4; origin = notes[0].start;
  const fit = fitGrid(notes, origin, grid);
  origin += fit.shift;
  const errors = notes.map(n => { const g = (n.start - origin) / grid; return Math.abs(g - Math.round(g)) * grid * 1000; });
  console.log(`grid: ${bpm} bpm, 16th = ${(grid * 1000).toFixed(0)} ms, shift ${(fit.shift * 1000).toFixed(0)} ms, tightness ${fit.tightness.toFixed(2)}, median distance from grid ${errors.sort((a, b) => a - b)[errors.length >> 1].toFixed(0)} ms`);
}
for (const note of notes) {
  const tech = [note.legato && 'legato', note.bend && `bend ${note.bend / 4} grid${note.bendRelease ? ' + release' : ''}`, note.vibrato && 'vibrato'].filter(Boolean).join(', ');
  const g = grid ? (note.start - origin) / grid : 0;
  const where = grid ? `  16th #${String(Math.round(g)).padStart(3)} (${(g - Math.round(g) >= 0 ? '+' : '') + ((g - Math.round(g)) * grid * 1000).toFixed(0)} ms) len ${((note.end - note.start) / grid).toFixed(1)}` : '';
  console.log(`${note.start.toFixed(3)}–${note.end.toFixed(3)}  ${midiName(note.pitch).padEnd(4)} level ${note.level.toFixed(3)}${where}  ${tech}`);
}
