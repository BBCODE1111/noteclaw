import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitchHz, transcribe, StreamAnalyzer, analyzeBuffer } from '../src/audio/analysis.js';
import { synth } from '../src/audio/synth.js';

const run = events => { const { samples, sampleRate } = synth(events); return transcribe(samples, sampleRate); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

test('pitch detection across the guitar range, including low E', () => {
  for (const midi of [40, 45, 52, 64, 76, 88]) {
    const { samples, sampleRate } = synth([{ at: 0, dur: 0.3, midi }]);
    const r = detectPitchHz(samples.subarray(4000, 4000 + 2048), sampleRate);
    near(69 + 12 * Math.log2(r.hz / 440), midi, 0.05, `midi ${midi}`);
  }
  assert.equal(detectPitchHz(new Float32Array(2048), 48000).hz, null);
});

test('a picked scale gives the right notes at the right times', () => {
  const pitches = [57, 59, 60, 62, 64, 65, 67, 69];
  const notes = run(pitches.map((midi, i) => ({ at: 0.1 + i * 0.25, dur: 0.25, midi })));
  assert.deepEqual(notes.map(n => n.pitch), pitches);
  notes.forEach((n, i) => { near(n.start, 0.1 + i * 0.25, 0.03, `start ${i}`); assert.equal(n.bend, 0); assert.equal(n.vibrato, false); assert.equal(n.legato, false, `note ${i} was picked`); });
});

test('the same note picked four times is four notes, not one long one', () => {
  const notes = run([0, 1, 2, 3].map(i => ({ at: 0.1 + i * 0.2, dur: 0.2, midi: 64 })));
  assert.deepEqual(notes.map(n => n.pitch), [64, 64, 64, 64]);
  notes.forEach((n, i) => { near(n.start, 0.1 + i * 0.2, 0.03); assert.equal(n.legato, false); });
});

test('picked notes are not mistaken for legato anywhere on the neck', () => {
  for (const base of [40, 52, 64, 76]) {
    const notes = run([0, 3, 5, 5, 7, 3].map((d, i) => ({ at: 0.1 + i * 0.22, dur: 0.22, midi: base + d })));
    assert.deepEqual(notes.map(n => n.pitch), [0, 3, 5, 5, 7, 3].map(d => base + d), `from ${base}`);
    assert.deepEqual(notes.map(n => n.legato), Array(6).fill(false), `from ${base}`);
  }
});

test('rests keep their length', () => {
  const notes = run([{ at: 0.1, dur: 0.2, midi: 60 }, { at: 0.8, dur: 0.2, midi: 62 }]);
  assert.deepEqual(notes.map(n => n.pitch), [60, 62]);
  near(notes[0].end, 0.3, 0.06); near(notes[1].start, 0.8, 0.03);
});

test('a whole-step bend stays one note and is reported as a bend', () => {
  const up = t => 62 + 2 * Math.min(1, Math.max(0, (t - 0.08) / 0.15));
  const notes = run([{ at: 0.1, dur: 0.7, midi: up }]);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].pitch, notes[0].bend, notes[0].bendRelease], [62, 4, false]);
  const half = run([{ at: 0.1, dur: 0.6, midi: t => 62 + Math.min(1, Math.max(0, (t - 0.08) / 0.12)) }]);
  assert.deepEqual([half[0].pitch, half[0].bend], [62, 2]);
});

test('bend and release', () => {
  const curve = t => 62 + 2 * (t < 0.08 ? 0 : t < 0.2 ? (t - 0.08) / 0.12 : t < 0.45 ? 1 : t < 0.57 ? 1 - (t - 0.45) / 0.12 : 0);
  const notes = run([{ at: 0.1, dur: 0.8, midi: curve }]);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].pitch, notes[0].bend, notes[0].bendRelease], [62, 4, true]);
});

test('vibrato is vibrato, not a bend and not several notes', () => {
  const notes = run([{ at: 0.1, dur: 0.9, midi: t => 67 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t) }]);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].pitch, notes[0].vibrato, notes[0].bend], [67, true, 0]);
  const plain = run([{ at: 0.1, dur: 0.9, midi: 67 }]);
  assert.equal(plain[0].vibrato, false);
});

test('hammer-on and pull-off: new pitch without a pick attack is marked legato', () => {
  const notes = run([
    { at: 0.1, dur: 0.25, midi: 57 }, { at: 0.35, dur: 0.25, midi: 60, pick: false },
    { at: 0.6, dur: 0.25, midi: 57, pick: false }, { at: 0.85, dur: 0.25, midi: 59 }]);
  assert.deepEqual(notes.map(n => n.pitch), [57, 60, 57, 59]);
  assert.deepEqual(notes.map(n => n.legato), [false, true, true, false]);
  near(notes[1].start, 0.35, 0.035); near(notes[2].start, 0.6, 0.035);
});

test('streaming analyser matches the offline one', () => {
  const { samples, sampleRate } = synth([{ at: 0.05, dur: 0.3, midi: 64 }]);
  const stream = new StreamAnalyzer(sampleRate);
  for (let i = 0; i < samples.length; i += 128) stream.push(samples.subarray(i, i + 128));
  const offline = analyzeBuffer(samples, sampleRate);
  assert.equal(stream.frames.length, offline.length);
  near(stream.frames[20].m, offline[20].m, 1e-6);
  near(stream.frames[20].t, offline[20].t, 1e-9);
});

test('a take saved as WAV has a valid header and the same samples', async () => {
  const { encodeWav } = await import('../src/audio/recorder.js');
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 48000);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(wav.length, 44 + 8);
  assert.equal(view.getInt16(46, true), 16383);
});

test('quiet DI signal: a long note stays one long note down to the noise floor', () => {
  // Real takes peak around 0.15 with notes near 0.02 RMS; an earlier fixed threshold chopped their tails off.
  const { samples, sampleRate } = synth([{ at: 0.2, dur: 1.6, midi: 73 }, { at: 1.8, dur: 0.4, midi: 75 }], { noise: 0.0015 });
  const quiet = samples.map(v => v * 0.08);
  const notes = transcribe(quiet, sampleRate);
  assert.deepEqual(notes.map(n => n.pitch), [73, 75]);
  near(notes[0].start, 0.2, 0.03); near(notes[0].end, 1.8, 0.05, 'first note rings until the next one');
});

test('distorted tone: clipped, compressed signal still gives the right notes', () => {
  const pitches = [45, 48, 50, 50, 52, 48];
  const { samples, sampleRate } = synth(pitches.map((midi, i) => ({ at: 0.1 + i * 0.25, dur: 0.25, midi })));
  const driven = samples.map(v => Math.tanh(v * 25) * 0.5); // heavy clipping: almost a square wave, no dynamics
  const notes = transcribe(driven, sampleRate);
  assert.deepEqual(notes.map(n => n.pitch), pitches);
  notes.forEach((n, i) => near(n.start, 0.1 + i * 0.25, 0.04, `start ${i}`));
});

test('bass range down to low E and low B', () => {
  const pitches = [23, 28, 33, 40];
  const { samples, sampleRate } = synth(pitches.map((midi, i) => ({ at: 0.1 + i * 0.5, dur: 0.5, midi })));
  const notes = transcribe(samples, sampleRate, { range: 'bass' });
  assert.deepEqual(notes.map(n => n.pitch), pitches);
});

test('a leaked metronome click is not a note and does not cut the note it lands on', async () => {
  const { alignGrid } = await import('../src/audio/recorder.js');
  const { samples, sampleRate } = synth([{ at: 2.05, dur: 1.5, midi: 69 }]);
  const clickTimes = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0], delay = 0.025;
  let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const t of clickTimes) for (let i = 0; i < 0.02 * sampleRate; i++) samples[Math.round((t + delay) * sampleRate) + i] += 0.02 * rand() * Math.exp(-i / 200);
  const frames = analyzeBuffer(samples, sampleRate);
  const scheduled = clickTimes.map((t, i) => ({ t, counting: i < 4 }));
  const grid = alignGrid(frames, scheduled, 2.0, 0);
  assert.equal(grid.measured, true);
  near(grid.origin, 2.025, 0.012, 'beat one is where the leaked click was recorded');
  const notes = transcribe(samples, sampleRate, { frames, clicks: scheduled.map(c => c.t + grid.delay) });
  assert.deepEqual(notes.map(n => n.pitch), [69]);
  assert.ok(notes[0].end - notes[0].start > 1.3, 'the clicks at 2.5 and 3.0 did not split the note');
  // No leak (headphones): nothing to measure, the system estimate is kept.
  const clean = analyzeBuffer(synth([{ at: 2.05, dur: 0.5, midi: 69 }]).samples, sampleRate);
  assert.equal(alignGrid(clean, scheduled, 2.0, 0.01).measured, false);
});

test('a phrase with no pauses at all (nothing to measure the noise floor from)', () => {
  const b = 60 / 110;
  const notes = run([
    { at: 0.05, dur: b / 2, midi: 57 }, { at: 0.05 + b / 2, dur: b / 2, midi: 60 }, { at: 0.05 + b, dur: b / 2, midi: 62 }, { at: 0.05 + b * 1.5, dur: b / 2, midi: 62 },
    { at: 0.05 + b * 2, dur: b / 2, midi: 64 }, { at: 0.05 + b * 2.5, dur: b / 2, midi: 67, pick: false }, { at: 0.05 + b * 3, dur: b / 2, midi: 64, pick: false },
    { at: 0.05 + b * 3.5, dur: b * 2, midi: t => 64 + (t > 0.25 ? 0.3 * Math.sin(2 * Math.PI * 5.5 * t) : 0) }]);
  assert.deepEqual(notes.map(n => n.pitch), [57, 60, 62, 62, 64, 67, 64, 64]);
  assert.deepEqual(notes.map(n => n.legato), [false, false, false, false, false, true, true, false]);
  assert.equal(notes[7].vibrato, true);
});
