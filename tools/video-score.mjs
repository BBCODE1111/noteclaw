// node tools/video-score.mjs in.wav frames.json [downbeatShift] : the score the app would write for a recording.
import fs from 'node:fs';
import bp from '@spotify/basic-pitch';
import { cleanPolyNotes } from '../src/audio/poly.js';
import { analyseRhythm, videoScore } from '../src/audio/video-tab.js';
const [,, wav, framesFile, shift = '0'] = process.argv;
const buf = fs.readFileSync(wav);
let off = 12, data, rate;
while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
  if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
  if (id === 'data') { data = buf.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
const s = new Float32Array(data.length / 2); for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
const { frames, onsets } = JSON.parse(fs.readFileSync(framesFile));
const ev = bp.noteFramesToTime(bp.outputToNotesPoly(frames, onsets, 0.5, 0.3, 5));
const notes = cleanPolyNotes(ev.map(e => ({ pitch: e.pitchMidi, start: e.startTimeSeconds, end: e.startTimeSeconds + e.durationSeconds, level: e.amplitude })));
const rhythm = analyseRhythm(s, rate, notes);
rhythm.downbeat += Number(shift);
const out = videoScore(notes, rhythm, { lead: process.env.ALL ? false : true });
console.log('bpm', out.bpm, 'downbeat', rhythm.downbeat, 'notes', out.notes, 'bars', out.bars.slice(0, 6).map(b => b.toFixed(2)).join(' '));
console.log(out.tex.split('\n').slice(3).join('\n').split('|').slice(0, Number(process.env.BARS || 4)).join('|\n'));
