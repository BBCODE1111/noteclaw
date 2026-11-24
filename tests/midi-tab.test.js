import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import { midiToNotes, midiScore } from '../src/audio/midi-tab.js';

/** MIDI messages for notes given in beats at a tempo, with a little human timing wobble. */
function take(spec, bpm, start = 1.0) {
  const beat = 60 / bpm, ev = [];
  spec.forEach(([b, len, pitch, vel = 90], i) => {
    const t = (start + b * beat + (i % 3 - 1) * 0.008) * 1000;
    ev.push({ time: t, data: [0x90, pitch, vel] }, { time: t + len * beat * 900, data: [0x80, pitch, 0] });
  });
  return ev.sort((a, b) => a.time - b.time);
}

test('MIDI messages become notes (note-on velocity 0 ends a note, the pedal holds notes)', () => {
  const notes = midiToNotes([
    { time: 0, data: [0x90, 60, 100] }, { time: 500, data: [0x90, 60, 0] },
    { time: 600, data: [0xb0, 64, 127] }, { time: 700, data: [0x90, 64, 80] }, { time: 800, data: [0x80, 64, 0] },
    { time: 1500, data: [0xb0, 64, 0] }, { time: 1600, data: [0x91, 67, 70] }
  ], 2000);
  assert.deepEqual(notes.map(n => [n.pitch, n.start, +n.end.toFixed(2)]), [[60, 0, 0.5], [64, 0.7, 1.5], [67, 1.6, 2]]);
});

test('a played MIDI phrase gives its tempo, bar lines and notes', () => {
  // 4 bars at 96 bpm: bass note on each downbeat, eighth notes above, a pickup into bar 1.
  const spec = [[-0.5, 0.5, 64]];
  for (let bar = 0; bar < 4; bar++) {
    spec.push([bar * 4, 3.8, [40, 45, 43, 47][bar], 110]);
    for (let e = 0; e < 8; e++) spec.push([bar * 4 + e / 2, 0.45, 64 + [0, 3, 5, 7, 5, 3, 0, 2][e]]);
  }
  const notes = midiToNotes(take(spec, 96));
  const out = midiScore(notes, { title: 'Test' });
  assert.ok(Math.abs(out.bpm - 96) <= 2, `tempo ${out.bpm}`);
  const imp = new at.importer.AlphaTexImporter(); imp.initFromString(out.tex, new at.Settings());
  const score = imp.readScore();
  // Bar lines: one bar holds the pickup; the bass notes start the following bars on beat one.
  const firstBeats = score.tracks[0].staves[0].bars.map(b => b.voices[0].beats.find(x => !x.isRest)).filter(Boolean);
  const bassBars = firstBeats.filter(b => b.playbackStart % 3840 === 0 && b.notes.some(n => n.realValue < 46));
  assert.ok(bassBars.length >= 3, `bass on beat one in ${bassBars.length} bars`);
  const pitches = score.tracks[0].staves[0].bars.flatMap(b => b.voices[0].beats.flatMap(x => x.notes.filter(n => !n.isTieDestination).map(n => n.realValue)));
  assert.equal(pitches.length, spec.length);
});
