import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import { playOrder, readPoints, writePoints } from '../src/ui/video.js';
import { exportProject, importProject, projectMedia } from '../src/io/files.ts';
import { normalize } from '../src/editor/ops.ts';

const settings = new at.Settings();
function load(tex) { const i = new at.importer.AlphaTexImporter(); i.initFromString(tex, settings); return i.readScore(); }
const FOUR = String.raw`\tempo 120 \track "G" . :1 0.6 | 0.6 | 0.6 | 0.6`; // 2 s per bar
const pairs = o => o.map(p => `${p.bar}:${p.occ}`);

test('play order unrolls repeats and gives the written-tempo start of each pass', () => {
  const sc = load(String.raw`\tempo 120 \track "G" . :1 0.6 | \ro 0.6 | \rc 2 0.6 | 0.6`);
  const order = playOrder(sc, settings);
  assert.deepEqual(pairs(order), ['0:0', '1:0', '2:0', '1:1', '2:1', '3:0']);
  assert.deepEqual(order.map(o => Math.round(o.synthMs)), [0, 2000, 4000, 6000, 8000, 10000]);
});

test('a later first point adds a bar-1 point at the written tempo', () => {
  const sc = load(FOUR);
  writePoints(sc, settings, [], [{ bar: 2, occ: 0, ms: 7000 }]);
  assert.deepEqual(sc.exportFlatSyncPoints().map(p => [p.barIndex, p.millisecondOffset]), [[0, 3000], [2, 7000]]);
  assert.deepEqual(readPoints(sc).map(p => [p.bar, p.ms]), [[2, 7000]]); // the automatic one is not the user's
});

test('new points replace old ones that would make time run backwards', () => {
  const sc = load(FOUR);
  writePoints(sc, settings, [], [{ bar: 0, occ: 0, ms: 1000 }, { bar: 1, occ: 0, ms: 3000 }, { bar: 3, occ: 0, ms: 7000 }]);
  writePoints(sc, settings, readPoints(sc), [{ bar: 2, occ: 0, ms: 7500 }]);
  assert.deepEqual(readPoints(sc).map(p => [p.bar, p.ms]), [[0, 1000], [1, 3000], [2, 7500]]);
});

test('alignment survives editing round-trips and project files', () => {
  const sc = load(FOUR);
  writePoints(sc, settings, [], [{ bar: 1, occ: 0, ms: 4200 }]);
  const again = normalize(sc, settings).score;
  assert.deepEqual(readPoints(again).map(p => [p.bar, p.ms]), [[1, 4200]]);
  assert.equal(again.exportFlatSyncPoints().length, 2);
  const text = exportProject(again, 'lesson.mov');
  assert.equal(projectMedia(text), 'lesson.mov');
  assert.deepEqual(readPoints(importProject(text, settings)).map(p => [p.bar, p.ms]), [[1, 4200]]);
  assert.equal(projectMedia(exportProject(again)), null);
});
