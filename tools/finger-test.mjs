// node tools/finger-test.mjs dir [filter] : how often the automatic fingering picks the same string and fret as
// a known-good Guitar Pro file. Only the pitches are given (in order, chords together); strings/frets are hidden.
// filter is a regular expression on the path. OPTS='{"lead":true,"leadCost":{...}}' to try settings. ROWS=1 per file.
import fs from 'node:fs';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import { fingerChords } from '../src/poly-score.js';
const [,, dir, filter = ''] = process.argv;
const opts = JSON.parse(process.env.OPTS || '{}');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.gp[x345]?$/.test(f) && !f.startsWith('._') && new RegExp(filter).test(p)) files.push(p); } })(dir);
let total = 0, same = 0, sameString = 0;
const rows = [];
for (const file of files.sort()) {
  const score = at.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(file)), new at.Settings());
  const track = score.tracks.find(t => t.staves[0].tuning.length === 6 && !t.staves[0].isPercussion);
  if (!track) continue;
  const std = track.staves[0].tuning.join() === '64,59,55,50,45,40' && !track.staves[0].capo;
  if (!std) { rows.push(`${path.basename(file)}: skipped (not standard tuning)`); continue; }
  const chords = [], truth = [];
  for (const bar of track.staves[0].bars) for (const beat of bar.voices[0].beats) {
    const notes = beat.notes.filter(n => n.isStringed && !n.isTieDestination && !n.isDead);
    if (!notes.length) continue;
    const pitches = [...new Set(notes.map(n => n.realValue))].sort((a, b) => a - b);
    chords.push({ pitches, notes: pitches.map(p => ({ pitch: p, level: 1 })) });
    truth.push(notes);
  }
  const { shapes } = fingerChords(chords, { maxFret: 24, lead: opts.lead ?? true, ...(opts.leadCost ? { leadCost: opts.leadCost } : {}) });
  let t = 0, s = 0, ss = 0;
  shapes.forEach((shape, i) => {
    for (const n of truth[i]) {
      t++;
      const w = (shape || []).find(x => x.pitch === n.realValue);
      if (w && w.string === n.string && w.fret === n.fret) s++;
      if (w && w.string === n.string) ss++;
    }
  });
  total += t; same += s; sameString += ss;
  rows.push(`${path.relative(dir, file).padEnd(40)} ${s}/${t} (${Math.round(100 * s / t)}%)`);
}
if (process.env.ROWS) console.log(rows.join('\n'));
console.log(`${files.length} files · ${total} notes · same string+fret ${(100 * same / total).toFixed(1)}% · same string ${(100 * sameString / total).toFixed(1)}%`);
