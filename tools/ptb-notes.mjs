// node tools/ptb-notes.mjs file.ptb : notes of a Power Tab (.ptb) file as {beat, notes:[{s,f,pitch}]}, used as
// known-good answers when checking transcriptions. Reads only the position / note records of the guitar
// staves; other objects are skipped by searching for the next position record and checking it is sane.
// Grace notes take no time; triplet members take 2/3. Each system (line of music) starts on a new bar.
import fs from 'node:fs';
const b = fs.readFileSync(process.argv[2]);
const tuning = [64, 59, 55, 50, 45, 40]; // standard; string 0 = high e
const posDef = b.indexOf(Buffer.from('CPosition')), lineDef = b.indexOf(Buffer.from('CLineData'));
if (posDef < 0) { console.log(process.env.JSON ? '[]' : 'no positions'); process.exit(0); }
const DUR = new Set([1, 2, 4, 8, 16, 32, 64]);
let posTag = null, lineTag = null;
function readPos(k) {
  if (k + 10 > b.length) return null;
  const pos = b[k], beaming = b.readUInt16LE(k + 1), data = b.readUInt32LE(k + 3), cc = b[k + 7];
  if (!DUR.has(data >>> 24) || cc > 8) return null;
  let p = k + 8; const sym = [];
  for (let c = 0; c < cc; c++) { if (p + 4 > b.length) return null; sym.push(b.readUInt32LE(p)); p += 4; }
  const n = b.readUInt16LE(p); p += 2;
  if (n > 6) return null;
  const lines = [];
  for (let c = 0; c < n; c++) {
    if (b[p] === 0xff && b[p + 1] === 0xff) p = lineDef + 9;
    else { const tag = b.readUInt16LE(p); if (!(tag & 0x8000)) return null; if (lineTag === null) lineTag = tag; else if (tag !== lineTag) return null; p += 2; }
    const sd = b[p], nd = b.readUInt16LE(p + 1), lc = b[p + 3];
    if ((sd >> 5) > 5 || lc > 8) return null;
    const ls = []; for (let i = 0; i < lc; i++) ls.push(b.readUInt32LE(p + 4 + i * 4));
    lines.push({ string: sd >> 5, fret: sd & 0x1f, data: nd, sym: ls }); p += 4 + lc * 4;
  }
  if (!n && !(data & 4)) return null; // a position is a rest or has notes
  return { rec: { pos, beaming, data, sym, lines }, next: p };
}
const staves = []; let cur = [];
let k = posDef + 9;
while (k < b.length) {
  const r = readPos(k);
  if (!r) break;
  cur.push(r.rec);
  const n = r.next;
  if (posTag === null && b[n + 1] & 0x80 && readPos(n + 2)) posTag = b.readUInt16LE(n);
  if (posTag !== null && b.readUInt16LE(n) === posTag) { k = n + 2; continue; }
  // End of this staff (or voice). Find the next position record further on.
  staves.push(cur); cur = [];
  let m = n, found = -1;
  while (posTag !== null && (m = b.indexOf(Buffer.from([posTag & 0xff, posTag >> 8]), m)) >= 0) {
    const t = readPos(m + 2);
    if (t && t.rec.pos === 0) { found = m + 2; break; }
    m += 1;
  }
  if (found < 0) break;
  k = found;
}
if (cur.length) staves.push(cur);
let beat = 0; const out = [];
for (const staff of staves) {
  beat = Math.ceil(beat / 4 - 1e-6) * 4; // each system starts a new bar (4/4)
  for (const p of staff) {
    const denom = p.data >>> 24, dotted = p.data & 1, rest = !!(p.data & 4);
    const grace = !!(p.data & 0x10000), triplet = !!(p.data & 0xe00000);
    const len = grace ? 0 : 4 / denom * (dotted ? 1.5 : 1) * (triplet ? 2 / 3 : 1);
    out.push({ beat: +beat.toFixed(3), pos: p.pos, denom, rest, grace, triplet,
      notes: p.lines.map(l => ({ s: l.string + 1, f: l.fret, pitch: tuning[l.string] + l.fret, d: l.data.toString(16), sym: l.sym.map(x => x.toString(16)) })) });
    beat += len;
  }
}
if (process.env.JSON) console.log(JSON.stringify(out));
else for (const o of out) console.log(o.beat.toFixed(3).padStart(7), `p${o.pos}`, `1/${o.denom}${o.triplet ? 't' : ''}`, o.rest ? 'rest' : o.grace ? 'grace' : '', o.notes.map(n => `${n.s}:${n.f}(${n.pitch})${n.sym.length ? '[' + n.sym.join(',') + ']' : ''}${n.d !== '0' ? '{' + n.d + '}' : ''}`).join(' '));
