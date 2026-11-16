import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import { midiToAlphaTex, detectKey, parseMidi } from '../src/midi-import.js';

at.Logger.logLevel = at.LogLevel.None;
// Build a Type 1 MIDI file: tracks of [deltaTicks, ...bytes] events.
function midiFile(tracks, ppq = 480) {
  const vlq = n => { const out = [n & 127]; while ((n >>= 7)) out.unshift((n & 127) | 128); return out; };
  const chunk = (id, data) => [...id].map(c => c.charCodeAt(0)).concat([(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255], data);
  const head = chunk('MThd', [0, 1, 0, tracks.length, ppq >> 8, ppq & 255]);
  const body = tracks.flatMap(events => chunk('MTrk', [...events.flatMap(([d, ...bytes]) => [...vlq(d), ...bytes]), 0, 0xff, 0x2f, 0]));
  return new Uint8Array([...head, ...body]);
}
const notes = (ch, list, len = 480) => list.flatMap(([pitches, gap = 0]) => [...pitches.map((p, i) => [i ? 0 : gap, 0x90 | ch, p, 90]), ...pitches.map((p, i) => [i ? 0 : len, 0x80 | ch, p, 0])]);
const load = tex => { const i = new at.importer.AlphaTexImporter(); i.initFromString(tex, new at.Settings()); return i.readScore(); };

test('every track comes in: piano chords, a guitar line as tablature, and drums', () => {
  const file = midiFile([
    [[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], [0, 0xff, 0x58, 4, 3, 2, 24, 8]], // 120 bpm, 3/4
    [[0, 0xff, 0x03, 5, ...'Piano'.split('').map(c => c.charCodeAt(0))], [0, 0xc0, 0], ...notes(0, [[[60, 64, 67]], [[62, 65, 69]], [[64, 67, 72]]])],
    [[0, 0xc1, 27], ...notes(1, [[[64]], [[67]], [[69]]])],
    [...notes(9, [[[36, 42]], [[38, 42]], [[42]]])]
  ]);
  const r = midiToAlphaTex(file);
  const sc = load(r.tex);
  assert.equal(sc.tempo, 120);
  assert.equal(sc.tracks.length, 3);
  assert.equal(sc.masterBars[0].timeSignatureNumerator, 3);
  const firstBeats = t => sc.tracks[t].staves[0].bars[0].voices[0].beats.filter(b => !b.isRest);
  assert.deepEqual(firstBeats(0).map(b => b.notes.map(n => n.realValue).sort((a, b) => a - b)), [[60, 64, 67], [62, 65, 69], [64, 67, 72]]);
  assert.equal(sc.tracks[0].staves[0].showTablature, false);
  assert.equal(sc.tracks[1].staves[0].tuning.length, 6);
  assert.equal(sc.tracks[1].playbackInfo.program, 27);
  assert.deepEqual(firstBeats(1).map(b => b.notes[0].realValue), [64, 67, 69]);
  const drums = sc.tracks[2];
  assert.equal(drums.staves[0].isPercussion, true);
  assert.deepEqual(firstBeats(2).map(b => b.notes.map(n => drums.percussionArticulations[n.percussionArticulation].outputMidiNumber).sort()), [[36, 42], [38, 42], [42]]);
});

test('key: taken from the file when present, otherwise worked out from the notes', () => {
  const dMajor = [62, 64, 66, 67, 69, 71, 73, 74, 69, 66, 62];
  const withSig = midiFile([[[0, 0xff, 0x59, 2, 0xfd, 0]], notes(0, dMajor.map(p => [[p]]))]); // 3 flats in the file
  assert.deepEqual([midiToAlphaTex(withSig).key.sharps, midiToAlphaTex(withSig).key.fromFile], [-3, true]);
  const k = midiToAlphaTex(midiFile([notes(0, dMajor.map(p => [[p]]))])).key;
  assert.deepEqual([k.sharps, k.minor, k.fromFile], [2, false, false]);
  const aMinor = detectKey([57, 59, 60, 62, 64, 65, 68, 69, 64, 60, 57, 57].map((pitch, i) => ({ pitch, startTick: i * 480, endTick: i * 480 + (pitch === 57 ? 960 : 480) })));
  assert.deepEqual([aMinor.sharps, aMinor.minor], [0, true]);
  assert.equal(parseMidi(withSig).parts.length, 1);
});
