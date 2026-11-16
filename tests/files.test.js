import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import { exportGuitarPro, exportProject, importProject, reduceCurve } from '../src/io/files.ts';

const settings = new at.Settings();
function load(tex) { const i = new at.importer.AlphaTexImporter(); i.initFromString(tex, settings); return i.readScore(); }
const firstNote = sc => sc.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];
const pts = n => n.bendPoints.map(p => [p.offset, p.value]);
const P = list => list.map(([o, v]) => new at.model.BendPoint(o, v));

test('a five-point bend-and-release is stored exactly instead of being dropped', () => {
  const sc = load(String.raw`\track "G" :2 5.3{b (0 4 4 4 0)} r`);
  assert.equal(firstNote(sc).bendPoints.length, 5);
  // alphaTab on its own loses this bend completely:
  const raw = at.importer.ScoreLoader.loadScoreFromBytes(new at.exporter.Gp7Exporter().export(sc, settings), settings);
  assert.equal(firstNote(raw).hasBend, false);
  const out = exportGuitarPro(sc, settings);
  assert.deepEqual([out.simplified, out.approximated], [1, 0]);
  const back = at.importer.ScoreLoader.loadScoreFromBytes(out.bytes, settings);
  assert.equal(firstNote(back).hasBend, true);
  assert.deepEqual(pts(firstNote(back)), [[0, 0], [15, 4], [45, 4], [60, 0]]);
  assert.equal(firstNote(sc).bendPoints.length, 5); // the score being edited is untouched
});

test('curve reduction: exact when possible, flagged when not', () => {
  const tail = reduceCurve(P([[0, 0], [5, 4], [15, 4], [25, 0], [60, 0]]));
  assert.equal(tail.exact, true);
  assert.deepEqual(tail.points.map(p => [p.offset, p.value]), [[0, 0], [5, 4], [15, 4], [25, 0]]);
  const wobble = reduceCurve(P([[0, 0], [10, 4], [20, 4], [30, 0], [40, 0], [50, 4], [60, 4]]));
  assert.equal(wobble.exact, false);
  assert.ok(wobble.points.length <= 4);
  const simple = P([[0, 0], [60, 4]]);
  assert.equal(reduceCurve(simple).points, simple);
});

test('project file round-trips everything, including what Guitar Pro cannot hold', () => {
  const sc = load(String.raw`\title "P" \tempo 97 \track "G" :2 5.3{b (0 4 0 4 0 4 0)} 7.3{v}`);
  const back = importProject(exportProject(sc), settings);
  assert.equal(back.title, 'P');
  assert.equal(back.tempo, 97);
  assert.deepEqual(pts(firstNote(back)), pts(firstNote(sc)));
  assert.throws(() => importProject('{"hello":1}', settings));
  assert.throws(() => importProject('not json', settings));
});

test('project files saved under the old name (.gstudio, "guitar-studio") still open', () => {
  const sc = load(String.raw`\title "Old" \track "G" :4 5.3 7.3 r r`);
  const saved = JSON.parse(exportProject(sc));
  assert.equal(saved.format, 'noteclaw');
  const legacy = JSON.stringify({ ...saved, format: 'guitar-studio' });
  assert.equal(importProject(legacy, settings).title, 'Old');
});
