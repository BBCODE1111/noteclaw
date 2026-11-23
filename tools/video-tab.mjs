// node tools/video-tab.mjs in.wav frames.json : tempo, beats and notes from a recording (offline check of the
// video → tab pipeline). frames.json comes from tools/poly-frames.mjs.
import fs from 'node:fs';
import bp from '@spotify/basic-pitch';
import { onsetEnvelope, estimateTempo, trackBeats, findDownbeat, phaseScores, timeToBeat } from '../src/audio/beats.js';
import { cleanPolyNotes } from '../src/audio/poly.js';
const [,, wav, framesFile] = process.argv;
const buf = fs.readFileSync(wav);
let off = 12, data, rate;
while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
  if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
  if (id === 'data') { data = buf.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
const s = new Float32Array(data.length / 2); for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
const E = onsetEnvelope(s, rate);
const bpm = estimateTempo(E.env, E.rate);
const beats = trackBeats(E.env, E.rate, bpm);
console.log('tempo', bpm.toFixed(1), 'beats', beats.length, beats.slice(0, 12).map(b => b.toFixed(2)).join(' '));
const iv = beats.slice(1).map((b, i) => b - beats[i]); console.log('beat lengths', iv.map(x => x.toFixed(2)).join(' '));
let notes = [];
if (framesFile) {
  const { frames, onsets } = JSON.parse(fs.readFileSync(framesFile));
  const ev = bp.noteFramesToTime(bp.outputToNotesPoly(frames, onsets, 0.5, 0.3, 5));
  notes = cleanPolyNotes(ev.map(e => ({ pitch: e.pitchMidi, start: e.startTimeSeconds, end: e.startTimeSeconds + e.durationSeconds, level: e.amplitude })));
}
const down = process.env.DOWN ? Number(process.env.DOWN) : findDownbeat(beats, E, notes);
console.log('phase scores', phaseScores(beats, E, notes).map(v => v.toFixed(1)).join(' '));
console.log('downbeat index', down, 'at', beats[down]?.toFixed(2), 'notes', notes.length);
const N = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'], nm = p => N[p % 12] + (Math.floor(p / 12) - 1);
const bars = new Map();
for (const n of notes) { const b = timeToBeat(n.start, beats) - down; const bar = Math.floor(b / 4); const pos = b - bar * 4;
  if (!bars.has(bar)) bars.set(bar, []); bars.get(bar).push(`${pos.toFixed(2)}:${nm(n.pitch)}${n.level < 0.4 ? '?' : ''}`); }
for (const [bar, list] of [...bars].sort((a, b) => a[0] - b[0])) console.log(`bar ${bar + 1}:`, list.join(' '));
