import test from 'node:test';
import assert from 'node:assert/strict';
import { midiName, possiblePositions, optimizeFingering, notesToAlphaTex } from '../src/fingering.js';
test('standard tuning pitches and fret possibilities', () => {
  assert.equal(midiName(69), 'A4');
  assert.deepEqual(possiblePositions(64, 24).find(v=>v.string===6), { string:6, fret:0 });
  assert.deepEqual(possiblePositions(69, 24).find(v=>v.string===6), { string:6, fret:5 });
});
test('smooth fingering preserves pitches and range', () => {
  const pitches = [69, 71, 72, 71, 69, 67, 64];
  const r = optimizeFingering(pitches, {maxFret:19});
  assert.equal(r.length, pitches.length);
  r.forEach((p,i)=>assert.equal([40,45,50,55,59,64][p.string-1]+p.fret, pitches[i]));
});
test('recording to alphaTex includes title, tempo, rests and bar boundaries', () => {
  const tex = notesToAlphaTex([
    {pitch:69,start:0,end:0.25},
    {pitch:71,start:0.55,end:0.80},
  ], {bpm:110, subdivision:16});
  assert.match(tex,/\\title "Recorded Guitar"/);
  assert.match(tex,/\\tempo 110/);
  assert.match(tex,/\|/);
});

test('alphaTex output keeps real pitch after alphaTab parses it (string numbering)', async () => {
  const at = await import('@coderline/alphatab');
  const pitches = [69, 64, 52, 45, 40];
  const tex = notesToAlphaTex(pitches.map((pitch, i) => ({ pitch, start: i * 0.5, end: i * 0.5 + 0.45 })), { bpm: 120 });
  const importer = new at.importer.AlphaTexImporter();
  importer.initFromString(tex, new at.Settings());
  const score = importer.readScore();
  const parsed = score.tracks[0].staves[0].bars.flatMap(b => b.voices[0].beats).flatMap(b => b.notes).map(n => n.realValue);
  assert.deepEqual(parsed, pitches);
});

async function parse(tex) {
  const at = await import('@coderline/alphatab');
  const importer = new at.importer.AlphaTexImporter();
  importer.initFromString(tex, new at.Settings());
  return importer.readScore().tracks[0].staves[0].bars.flatMap(b => b.voices[0].beats);
}

test('fingering modes: position limits, solo strings, legato on one string, bends off the open string', () => {
  const scale = [57, 59, 60, 62, 64, 65, 67, 69]; // A minor, A3–A4
  const pos = optimizeFingering(scale, { bias: 'position', minFret: 5, maxFret: 8 });
  // B3 does not exist in frets 5–8; it is written one fret outside (a stretch), everything else stays inside.
  pos.forEach((p, i) => assert.ok(scale[i] === 59 ? [4, 9].includes(p.fret) : p.fret >= 5 && p.fret <= 8, `fret ${p.fret} outside the position`));
  assert.ok(new Set(pos.map(p => p.string)).size >= 3, 'a box position crosses strings');
  const smooth = optimizeFingering(scale);
  assert.ok(Math.max(...smooth.map(p => p.fret)) - Math.min(...smooth.filter(p => p.fret).map(p => p.fret)) <= 5, 'smooth stays in one position');
  const solo = optimizeFingering([64, 67, 69], { bias: 'solo' });
  solo.forEach(p => assert.ok(p.string >= 4 && p.fret >= 3, `solo wants plain strings: ${p.string}/${p.fret}`));
  const slur = optimizeFingering([62, 64], { hints: [{}, { legato: true }] });
  assert.equal(slur[0].string, slur[1].string);
  const bent = optimizeFingering([64], { hints: [{ bend: 4 }] }); // E4 is the open 1st string, which cannot be bent
  assert.ok(bent[0].fret > 0);
});

test('recorded techniques and ties are written into the score with the right pitches', async () => {
  const beatLen = 60 / 120;
  const notes = [
    { pitch: 62, start: 0, end: beatLen * 0.9, bend: 4, bendRelease: false, vibrato: false, legato: false },
    { pitch: 64, start: beatLen, end: beatLen * 1.45, legato: false },
    { pitch: 66, start: beatLen * 1.5, end: beatLen * 2, legato: true },
    { pitch: 69, start: beatLen * 2, end: beatLen * 4.5, vibrato: true, legato: false } // 2.5 beats: crosses the bar line
  ];
  const beats = await parse(notesToAlphaTex(notes, { bpm: 120, subdivision: 8, origin: 0 }));
  const sounding = beats.filter(b => !b.isRest);
  assert.deepEqual(sounding.map(b => b.notes[0].realValue), [62, 64, 66, 69, 69]);
  assert.equal(sounding[0].notes[0].hasBend, true);
  assert.equal(sounding[1].notes[0].isHammerPullOrigin, true);
  assert.ok(sounding[3].notes[0].vibrato > 0);
  assert.equal(sounding[4].notes[0].isTieDestination, true); // held over the bar line, not picked again
});

test('with a count-in the grid starts at beat one, so a late first note is preceded by a rest', async () => {
  const beats = await parse(notesToAlphaTex([{ pitch: 60, start: 1.0, end: 1.4 }], { bpm: 120, subdivision: 8, origin: 0 }));
  assert.equal(beats[0].isRest, true);
  assert.equal(beats.find(b => !b.isRest).notes[0].realValue, 60);
  const early = notesToAlphaTex([{ pitch: 60, start: -0.4, end: -0.1 }, { pitch: 62, start: 0, end: 0.4 }], { bpm: 120, origin: 0 });
  assert.deepEqual([...new Set((await parse(early)).filter(b => !b.isRest).map(b => b.notes[0].realValue))], [62]); // a note played during the count-in is dropped
});

test('rhythm follows a player who drags behind the click instead of jumping grid steps', async () => {
  const { quantizeStarts } = await import('../src/fingering.js');
  const unit = 0.1875; // a 16th at 80 bpm
  // Eighth notes that drift up to 90 ms late and come back, as measured on a real take.
  const late = [-29, 59, 90, 88, 54, 63, 30, 17, 26, 25, 12, -11];
  const starts = late.map((ms, i) => 2 * i * unit + ms / 1000);
  assert.deepEqual(quantizeStarts(starts, 0, unit), late.map((_, i) => 2 * i));
});

test('a note that rings into the next one is held, not followed by a rest', async () => {
  const unit = 60 / 80 / 4;
  const notes = [0, 2, 4, 6].map(i => ({ pitch: 69, start: i * unit, end: i * unit + 1.6 * unit })); // each stops 75 ms short
  const beats = await parse(notesToAlphaTex(notes, { bpm: 80, subdivision: 16, origin: 0 }));
  const firstBar = beats.slice(0, 4);
  assert.deepEqual(firstBar.map(b => [b.isRest, b.duration]), [[false, 8], [false, 8], [false, 8], [false, 8]]);
});

test('bass: notes are written on a four-string staff in bass tuning', async () => {
  const at = await import('@coderline/alphatab');
  const { BASS_STRINGS } = await import('../src/fingering.js');
  const tex = notesToAlphaTex([28, 33, 40, 43].map((pitch, i) => ({ pitch, start: i * 0.5, end: i * 0.5 + 0.45 })), { bpm: 120, origin: 0, tuning: BASS_STRINGS, trackName: 'Bass' });
  const importer = new at.importer.AlphaTexImporter(); importer.initFromString(tex, new at.Settings());
  const staff = importer.readScore().tracks[0].staves[0];
  assert.deepEqual(staff.tuning, [43, 38, 33, 28]);
  assert.deepEqual(staff.bars.flatMap(b => b.voices[0].beats).filter(b => !b.isRest).map(b => b.notes[0].realValue), [28, 33, 40, 43]);
});
