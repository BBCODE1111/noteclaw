// node tools/tempo-check.mjs dir truth.json-map : detected vs true tempo for every <name>.wav/.frames.json in dir.
// TRUTH='{"name-substring": bpm, ...}'. OPTS='{"tempo":{...}}'.
import fs from 'node:fs';
import path from 'node:path';
import bp from '@spotify/basic-pitch';
import { cleanPolyNotes } from '../src/audio/poly.js';
import { analyseRhythm } from '../src/audio/video-tab.js';
const [,, dir] = process.argv;
const truth = JSON.parse(process.env.TRUTH), opts = JSON.parse(process.env.OPTS || '{}');
let ok = 0, n = 0; const bad = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.frames.json'))) {
  const name = f.replace('.frames.json', ''), key = Object.keys(truth).find(k => name.includes(k));
  if (!key) continue;
  const buf = fs.readFileSync(path.join(dir, name + '.wav')); let off = 12, data; while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4); if (id === 'data') { data = buf.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
  const s = new Float32Array(data.length / 2); for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  const { frames, onsets } = JSON.parse(fs.readFileSync(path.join(dir, f)));
  const notes = cleanPolyNotes(bp.noteFramesToTime(bp.outputToNotesPoly(frames, onsets, 0.65, 0.2, 5)).map(e => ({ pitch: e.pitchMidi, start: e.startTimeSeconds, end: e.startTimeSeconds + e.durationSeconds, level: e.amplitude })));
  const r = analyseRhythm(s, 22050, notes, opts);
  n++; const good = Math.abs(r.bpm / truth[key] - 1) < 0.04; if (good) ok++; else bad.push(`${name.slice(-14)} ${r.bpm.toFixed(0)} (true ${truth[key]})`);
}
console.log(`tempo right ${ok}/${n}`, bad.join(' · '));
