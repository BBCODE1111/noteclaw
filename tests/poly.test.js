import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as at from '@coderline/alphatab';
import { synth } from '../src/audio/synth.js';
import { cleanPolyNotes, resample, transcribePoly } from '../src/audio/poly.js';
import { chordShapes, fingerChords, groupChords, polyToAlphaTex } from '../src/poly-score.js';
import { BASS_STRINGS } from '../src/fingering.js';

at.Logger.logLevel = at.LogLevel.None;
function beats(tex) { const i = new at.importer.AlphaTexImporter(); i.initFromString(tex, new at.Settings()); const sc = i.readScore(); return { staff: sc.tracks[0].staves[0], beats: sc.tracks[0].staves[0].bars.flatMap(b => b.voices[0].beats) }; }
const chord = (pitches, start, dur, level = 0.7) => pitches.map(pitch => ({ pitch, start, end: start + dur, level }));

test('chord shapes: open E minor and a barre F are found, an impossible cluster is not', () => {
  const em = chordShapes([40, 47, 52, 55, 59, 64])[0];
  assert.deepEqual(em.notes.map(n => n.fret), [0, 2, 2, 0, 0, 0]);
  const f = chordShapes([41, 48, 53, 57, 60, 65])[0];
  assert.deepEqual(f.notes.map(n => n.fret), [1, 3, 3, 2, 1, 1]); // full barre: one finger holds fret 1
  assert.equal(chordShapes([60, 61, 62, 63]).length, 0); // four adjacent semitones: not on a guitar
  assert.deepEqual(chordShapes([28, 35], { tuning: BASS_STRINGS })[0].notes.map(n => [n.string, n.fret]), [[1, 0], [2, 2]]);
});

test('a chord that does not fit is thinned from the middle and reported, never silently dropped', () => {
  const chords = groupChords([...chord([48, 60, 61, 62, 63, 76], 0, 0.5)], { origin: 0, unit: 0.125 });
  const r = fingerChords(chords);
  assert.equal(r.simplified, 1);
  assert.ok(r.dropped >= 1);
  const pitches = r.shapes[0].map(n => n.pitch);
  assert.equal(pitches[0], 48); assert.equal(pitches.at(-1), 76); // bass and top note survive
});

test('strummed chords become chords on the grid with held lengths, in tablature', () => {
  const unit = 60 / 120 / 4; // 16th at 120 bpm
  const strum = (pitches, at) => pitches.map((pitch, k) => ({ pitch, start: at + k * 0.012, end: at + 0.9, level: 0.7 }));
  const notes = [...strum([40, 47, 52, 55, 59, 64], 0.01), ...strum([45, 52, 57, 60, 64], 1.0), { pitch: 67, start: 2.0, end: 2.5, level: 0.7 }];
  const out = polyToAlphaTex(notes, { bpm: 120, origin: 0 });
  const { beats: b } = beats(out.tex);
  const sounding = b.filter(x => !x.isRest && !x.notes[0].isTieDestination);
  assert.deepEqual(sounding.map(x => x.notes.map(n => n.realValue).sort((p, q) => p - q)), [[40, 47, 52, 55, 59, 64], [45, 52, 57, 60, 64], [67]]);
  assert.deepEqual(sounding.map(x => x.duration), [2, 2, 4]); // half, half, then a quarter
  assert.deepEqual([out.dropped, out.unplayable], [0, 0]);
  assert.equal(unit, 0.125);
});

test('piano: written as pitches on a standard staff, ties across the bar line', () => {
  const notes = [...chord([48, 64, 67], 0, 2.4), ...chord([53, 65, 69, 72], 2.5, 0.45), ...chord([61, 66], 3.0, 0.45)];
  const out = polyToAlphaTex(notes, { bpm: 120, origin: 0, staff: 'score', trackName: 'Piano' });
  const { staff, beats: b } = beats(out.tex);
  assert.equal(staff.tuning.length, 0);
  assert.equal(staff.showTablature, false);
  const first = b.filter(x => !x.isRest);
  assert.deepEqual(first[0].notes.map(n => n.realValue), [48, 64, 67]);
  assert.ok(first[1].notes.every(n => n.isTieDestination), 'the long chord is tied over the bar line');
  assert.deepEqual(b.filter(x => !x.isRest && !x.notes[0].isTieDestination).map(x => x.notes.map(n => n.realValue)), [[48, 64, 67], [53, 65, 69, 72], [61, 66]]);
});

test('overtone ghosts and duplicates from the model are removed, real octaves are kept', () => {
  const notes = [
    { pitch: 48, start: 0, end: 1, level: 0.7 }, { pitch: 60, start: 0.01, end: 0.9, level: 0.4 },  // octave overtone of C3
    { pitch: 55, start: 0, end: 1, level: 0.65 }, { pitch: 67, start: 0, end: 1, level: 0.62 },     // a real, equally loud octave
    { pitch: 48, start: 0.3, end: 0.6, level: 0.5 },                                                // duplicate inside the first
    { pitch: 72, start: 2, end: 2.03, level: 0.9 }];                                                // too short
  assert.deepEqual(cleanPolyNotes(notes).map(n => n.pitch), [48, 55, 67]);
});

test('resampling keeps pitch and length', () => {
  const { samples } = synth([{ at: 0, dur: 0.5, midi: 69 }], { sampleRate: 48000, tail: 0 });
  const out = resample(samples, 48000, 22050);
  assert.ok(Math.abs(out.length - samples.length * 22050 / 48000) <= 1);
});

// The real model, run on synthesized chords. Slow on plain CPU, so it is one test.
test('Basic Pitch model: chords, a double stop and a single line come back as the right notes', { timeout: 120000 }, async () => {
  const tf = await import('@tensorflow/tfjs');
  const dir = new URL('../node_modules/@spotify/basic-pitch/model/', import.meta.url);
  const json = JSON.parse(fs.readFileSync(new URL('model.json', dir), 'utf8'));
  const bin = fs.readFileSync(new URL(json.weightsManifest[0].paths[0], dir));
  const model = tf.loadGraphModel(tf.io.fromMemory({ modelTopology: json.modelTopology, weightSpecs: json.weightsManifest[0].weights,
    weightData: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy }));
  const SR = 48000;
  const voices = [
    [{ at: 0.2, dur: 0.9, midi: 40 }, { at: 1.2, dur: 0.9, midi: 48 }, { at: 2.2, dur: 0.4, midi: 64 }, { at: 2.6, dur: 0.4, midi: 67 }, { at: 3.1, dur: 0.6, midi: 57 }],
    [{ at: 0.2, dur: 0.9, midi: 47 }, { at: 1.2, dur: 0.9, midi: 52 }, { at: 3.1, dur: 0.6, midi: 64 }],
    [{ at: 0.2, dur: 0.9, midi: 52 }, { at: 1.2, dur: 0.9, midi: 55 }],
    [{ at: 0.2, dur: 0.9, midi: 55 }, { at: 1.2, dur: 0.9, midi: 60 }]].map(v => synth(v, { sampleRate: SR }).samples);
  const audio = new Float32Array(Math.max(...voices.map(v => v.length)));
  for (const v of voices) for (let i = 0; i < v.length; i++) audio[i] += v[i] * 0.02; // as quiet as a real DI
  const notes = await transcribePoly(audio, SR, { model });
  const at_ = (t, tol = 0.08) => notes.filter(n => Math.abs(n.start - t) < tol).map(n => n.pitch).sort((a, b) => a - b);
  assert.deepEqual(at_(0.2), [40, 47, 52, 55]);
  assert.deepEqual(at_(1.2), [48, 52, 55, 60]);
  assert.deepEqual(at_(2.2), [64]);
  assert.deepEqual(at_(2.6), [67]);
  assert.deepEqual(at_(3.1), [57, 64]);
  assert.equal(notes.length, 12, 'no extra notes: ' + notes.map(n => `${n.start.toFixed(2)}:${n.pitch}`).join(' '));
  const out = polyToAlphaTex(notes, { bpm: 120, origin: 0.2 });
  assert.deepEqual([out.chords, out.dropped, out.unplayable], [5, 0, 0]);
});

test('model artefacts: a sub-octave ghost, a late overtone and an early lone chord tone are cleaned up', () => {
  const notes = cleanPolyNotes([
    { pitch: 50, start: 3.0, end: 3.9, level: 0.7 }, { pitch: 57, start: 3.0, end: 3.9, level: 0.7 }, { pitch: 66, start: 3.0, end: 3.9, level: 0.66 },
    { pitch: 38, start: 3.08, end: 3.5, level: 0.4 },   // an octave under D3
    { pitch: 74, start: 3.5, end: 3.7, level: 0.35 }]); // an overtone surfacing mid-chord
  assert.deepEqual(notes.map(n => n.pitch), [50, 57, 66]);
  // A real bass note under a chord is as loud as the chord and stays.
  assert.equal(cleanPolyNotes([{ pitch: 62, start: 0, end: 1, level: 0.6 }, { pitch: 38, start: 0.5, end: 1.5, level: 0.7 }]).length, 2);
  const chords = groupChords([{ pitch: 43, start: 1.94, end: 2.0, level: 0.5 }, ...chord([43, 50, 55, 59], 2.04, 0.9)], { origin: 0.04, unit: 0.125 });
  assert.equal(chords.length, 1);
  assert.deepEqual(chords[0].pitches, [43, 50, 55, 59]);
});
