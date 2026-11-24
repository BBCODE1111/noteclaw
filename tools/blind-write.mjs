// node tools/blind-write.mjs audioDir outDir : write scores from recordings exactly as the app's 自動扒譜 does,
// without looking at any answer. For each <name>.wav (+ <name>.frames.json from tools/poly-frames.mjs) writes
// <name>.alphatex and <name>.written.json (every written note: beat from the start of bar 1, pitch, string, fret).
// OPTS='{"onset":..,"frame":..,"rhythm":{..},"leadCost":{..}}' overrides settings (for tuning on other data).
import fs from 'node:fs';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import bp from '@spotify/basic-pitch';
import { cleanPolyNotes } from '../src/audio/poly.js';
import { analyseRhythm, videoScore } from '../src/audio/video-tab.js';
const [,, dir, out] = process.argv;
const opts = JSON.parse(process.env.OPTS || '{}');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.frames.json'))) {
  const name = f.replace('.frames.json', '');
  const buf = fs.readFileSync(path.join(dir, name + '.wav'));
  let off = 12, data; while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4); if (id === 'data') { data = buf.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
  const s = new Float32Array(data.length / 2); for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  const { frames, onsets } = JSON.parse(fs.readFileSync(path.join(dir, f)));
  const notes = cleanPolyNotes(bp.noteFramesToTime(bp.outputToNotesPoly(frames, onsets, opts.onset ?? 0.65, opts.frame ?? 0.2, 5))
    .map(e => ({ pitch: e.pitchMidi, start: e.startTimeSeconds, end: e.startTimeSeconds + e.durationSeconds, level: e.amplitude })))
    .filter(n => n.pitch >= 28 && n.pitch <= 96);
  const rhythm = analyseRhythm(s, 22050, notes, opts.rhythm || {});
  const score = videoScore(notes, rhythm, { title: name, leadCost: opts.leadCost });
  fs.writeFileSync(path.join(out, name + '.alphatex'), score.tex);
  // Read back what was written, as the editor would show it.
  const imp = new at.importer.AlphaTexImporter(); imp.initFromString(score.tex, new at.Settings());
  const sc = imp.readScore(), written = [];
  for (const bar of sc.tracks[0].staves[0].bars) for (const beat of bar.voices[0].beats) for (const n of beat.notes) {
    if (n.isTieDestination) continue;
    written.push({ beat: beat.absolutePlaybackStart / 960, pitch: n.realValue, string: n.string, fret: n.fret });
  }
  fs.writeFileSync(path.join(out, name + '.written.json'), JSON.stringify({ bpm: score.bpm, bars: sc.masterBars.length, written }));
  console.log(name, `♩=${score.bpm}`, `${sc.masterBars.length} bars`, `${written.length} notes`);
}
