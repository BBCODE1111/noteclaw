// node tools/gp-truth.mjs file.gp : notes of a Guitar Pro file in the same form as tools/ptb-notes.mjs
// ({beat, rest, grace, notes:[{s (1 = highest string), f, pitch, d}]}), for grading transcriptions.
// Uses the guitar track with the most notes; repeats are played out the way a recording plays them.
// INFO=1 prints tracks, tempo and bars instead.
import fs from 'node:fs';
import * as at from '@coderline/alphatab';
const settings = new at.Settings();
const score = at.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(process.argv[2])), settings);
const count = t => t.staves[0].bars.reduce((s, b) => s + b.voices[0].beats.reduce((x, bt) => x + bt.notes.length, 0), 0);
const guitars = score.tracks.filter(t => !t.staves[0].isPercussion && t.staves[0].tuning.length >= 6);
const track = (guitars.length ? guitars : score.tracks).reduce((a, b) => (count(b) > count(a) ? b : a));
if (process.env.INFO) {
  console.log(score.title, 'tempo', score.tempo, 'bars', score.masterBars.length, 'repeats', score.masterBars.some(m => m.isRepeatStart || m.repeatCount > 0));
  for (const t of score.tracks) console.log(' track', t.index, t.name, 'strings', t.staves[0].tuning.length, 'notes', count(t), t === track ? '<- used' : '');
  process.exit(0);
}
// Bar play order with repeats (simple repeat signs; endings/jumps are rare in exercise files).
const order = [];
for (let i = 0; i < score.masterBars.length; i++) {
  const mb = score.masterBars[i];
  order.push(i);
  if (mb.repeatCount > 0) {
    let start = i; while (start > 0 && !score.masterBars[start].isRepeatStart) start--;
    for (let r = 1; r < mb.repeatCount; r++) for (let k = start; k <= i; k++) order.push(k);
  }
}
const strings = track.staves[0].tuning.length;
const out = [];
let at0 = 0;
for (const i of order) {
  const mb = score.masterBars[i], bar = track.staves[0].bars[i];
  for (const beat of bar.voices[0].beats) {
    const beatPos = at0 + (beat.playbackStart / 960);
    out.push({ beat: +beatPos.toFixed(4), rest: beat.isRest, grace: beat.graceType !== at.model.GraceType.None,
      notes: beat.notes.filter(n => n.isStringed).map(n => ({ s: strings + 1 - n.string, f: n.fret, pitch: n.realValue, d: n.isTieDestination ? '1' : '0' })) });
  }
  at0 += mb.calculateDuration() / 960;
}
console.log(JSON.stringify(out));
