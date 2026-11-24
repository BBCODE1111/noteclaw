// node tools/grade-written.mjs writtenDir truthDir : compare scores written blind (tools/blind-write.mjs) with
// the known-good tabs (<name>.truth.json from tools/ptb-notes.mjs). Strict: the written bar lines are used as
// they are — the only freedom is which written bar is the tab's bar 1 (a video may start with an intro).
// "+1 fix" also allows moving the bar lines by whole beats, as the ← 一拍 / 一拍 → buttons do.
import fs from 'node:fs';
import path from 'node:path';
const [,, wdir, tdir] = process.argv;
let T = 0, Hs = 0, Ws = 0, Es = 0, Fs = 0, Hf = 0, Ef = 0, Ff = 0, Wf = 0, bars = 0, n = 0;
const rows = [];
for (const f of fs.readdirSync(wdir).filter(f => f.endsWith('.written.json'))) {
  const name = f.replace('.written.json', '');
  const tf = path.join(tdir, name.replace(/lick0(\d)$/, 'lick$1') + '.truth.json');
  const tf2 = path.join(tdir, name + '.truth.json');
  const truthFile = fs.existsSync(tf2) ? tf2 : tf;
  if (!fs.existsSync(truthFile)) { console.log('no truth for', name); continue; }
  const { written, bpm } = JSON.parse(fs.readFileSync(path.join(wdir, f)));
  const tp = JSON.parse(fs.readFileSync(truthFile));
  const truth = tp.filter(p => !p.rest && !p.grace).flatMap(p => p.notes.filter(x => !(parseInt(x.d, 16) & 1)).map(x => ({ beat: p.beat, pitch: x.pitch, s: x.s, f: x.f })));
  const end = (tp[tp.length - 1]?.beat ?? 0) + 1;
  const score = shift => {
    const w = written.map(x => ({ ...x, beat: x.beat - shift })).filter(x => x.beat > -0.3 && x.beat < end);
    const used = new Set(); let hit = 0, exact = 0, fing = 0;
    for (const t of truth) {
      let k = w.findIndex((x, i) => !used.has(i) && x.pitch === t.pitch && Math.abs(x.beat - t.beat) < 0.02);
      if (k < 0) k = w.findIndex((x, i) => !used.has(i) && x.pitch === t.pitch && Math.abs(x.beat - t.beat) <= 0.27);
      if (k < 0) continue;
      used.add(k); hit++; if (Math.abs(w[k].beat - t.beat) < 0.02) exact++; if (w[k].string === 7 - t.s && w[k].fret === t.f) fing++; // alphaTab counts strings from the lowest
    }
    return { shift, hit, exact, fing, w: w.length, f1: 2 * hit / (truth.length + w.length) };
  };
  let strict = null, fixed = null;
  for (let s = -64; s <= 64; s++) { const r = score(s); if (s % 4 === 0 && (!strict || r.f1 > strict.f1)) strict = r; if (!fixed || r.f1 > fixed.f1) fixed = r; }
  n++; T += truth.length; Hs += strict.hit; Ws += strict.w; Es += strict.exact; Fs += strict.fing; Hf += fixed.hit; Ef += fixed.exact; Ff += fixed.fing; Wf += fixed.w;
  if (fixed.shift % 4 === 0) bars++;
  rows.push(`${name.slice(-6).padEnd(7)} ♩=${bpm} strict found ${strict.hit}/${truth.length} extra ${strict.w - strict.hit} exact ${strict.exact} fret ${strict.fing} | best shift ${fixed.shift - strict.shift} beat(s) → found ${fixed.hit}`);
}
if (process.env.ROWS) console.log(rows.join('\n'));
const pc = (a, b) => (100 * a / b).toFixed(1) + '%';
console.log(`${n} licks, blind, as written: found ${pc(Hs, T)} · correct among written ${pc(Hs, Ws)} · exact position ${pc(Es, Hs)} · string+fret ${pc(Fs, Hs)} · bar lines right ${bars}/${n}`);
console.log(`after a one-beat fix where needed: found ${pc(Hf, T)} · correct among written ${pc(Hf, Wf)} · exact ${pc(Ef, Hf)} · string+fret ${pc(Ff, Hf)}`);
