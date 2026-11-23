import test from 'node:test';
import assert from 'node:assert/strict';
import { onsetEnvelope, estimateTempo, trackBeats, timeToBeat } from '../src/audio/beats.js';
import { analyseRhythm, leadNotes, videoScore, beatTime } from '../src/audio/video-tab.js';

const RATE = 22050;
/** Plucked tones at the given times (a stand-in for a recording). */
function render(events, seconds) {
  const out = new Float32Array(Math.ceil(seconds * RATE));
  for (const { t, pitch, gain = 0.5 } of events) {
    const hz = 440 * 2 ** ((pitch - 69) / 12), i0 = Math.round(t * RATE);
    for (let i = 0; i < RATE * 0.4 && i0 + i < out.length; i++) out[i0 + i] += gain * Math.exp(-i / (RATE * 0.08)) * Math.sin(2 * Math.PI * hz * i / RATE);
  }
  return out;
}
// A player at 96 bpm who slows down to 88 over 12 bars, starting at 1.3 s: eighth notes, the bar's first note loudest.
function performance() {
  const beats = []; let t = 1.3;
  for (let b = 0; b < 48; b++) { beats.push(t); t += 60 / (96 - 8 * b / 47); }
  const events = [];
  beats.forEach((bt, b) => { const next = beats[b + 1] ?? bt + 0.68;
    events.push({ t: bt, pitch: 64 + (b % 4 === 0 ? 0 : 3), gain: b % 4 === 0 ? 0.8 : 0.45 }, { t: (bt + next) / 2, pitch: 67, gain: 0.3 }); });
  return { beats, audio: render(events, t + 1) };
}

test('tempo and beats follow a player who slows down', () => {
  const { beats, audio } = performance();
  const e = onsetEnvelope(audio, RATE);
  const bpm = estimateTempo(e.env, e.rate);
  assert.ok(bpm > 86 && bpm < 98, `tempo ${bpm}`);
  const found = trackBeats(e.env, e.rate, bpm);
  // Every real beat has a detected beat within 40 ms.
  const missed = beats.filter(b => !found.some(f => Math.abs(f - b) < 0.04));
  assert.equal(missed.length, 0, `missed ${missed.map(m => m.toFixed(2))}`);
});

test('bar lines land on the real bar starts, also late in the take', () => {
  const { beats, audio } = performance();
  const notes = beats.flatMap((t, b) => [{ pitch: 64 + (b % 4 === 0 ? 0 : 3), start: t, end: t + 0.3, level: 0.8 }]);
  const rhythm = analyseRhythm(audio, RATE, notes);
  const out = videoScore(notes, rhythm, { offset: 10 });
  // Bar k starts at real beat 4k (shifted by the offset), whichever beat the analysis called "1".
  const real = beats.filter((_, i) => i % 4 === 0).map(t => t + 10);
  const shift = Math.round((out.bars[0] - real[0]) / (60 / 96));
  assert.equal(((shift % 4) + 4) % 4, 0, 'bar line on a downbeat');
  for (let k = 0; k < 10; k++) assert.ok(Math.abs(out.bars[k] - real[k + shift / 4]) < 0.05, `bar ${k + 1}: ${out.bars[k]} vs ${real[k + shift / 4]}`);
  assert.match(out.tex, /\\tempo 9\d/);
});

test('beat positions interpolate and extrapolate', () => {
  const b = [1, 2, 3.5];
  assert.equal(timeToBeat(1.5, b), 0.5);
  assert.equal(timeToBeat(2.75, b), 1.5);
  assert.equal(timeToBeat(0.5, b), -0.5);
  assert.equal(beatTime(-1, b), 0);
  assert.equal(beatTime(3, b), 5);
});

test('lead notes keep the melody and double stops, drop the band underneath', () => {
  const kept = leadNotes([
    { pitch: 31, start: 0, end: 1 },              // bass
    { pitch: 48, start: 0.01, end: 1 }, { pitch: 52, start: 0.02, end: 1 }, // backing chord
    { pitch: 69, start: 0.02, end: 0.3 }, { pitch: 74, start: 0.03, end: 0.3 }, // double stop on top
    { pitch: 71, start: 0.5, end: 0.7 }
  ]).map(n => n.pitch);
  assert.deepEqual(kept, [69, 74, 71]);
});
