import test from 'node:test';
import assert from 'node:assert/strict';
import * as at from '@coderline/alphatab';
import * as ops from '../src/editor/ops.ts';

const settings = new at.Settings();
function load(tex) { const i = new at.importer.AlphaTexImporter(); i.initFromString(tex, settings); return i.readScore(); }
const TEX = String.raw`\title "T" \tempo 120 \track "G" :8 5.3 7.3 5.3 3.3 :4 5.2 5.2 | :4 1.1 2.1 3.1 4.1 | :1 9.6`;
const sig = sc => sc.tracks[0].staves[0].bars.map(b => b.voices[0].beats.map(x => x.isRest ? 'r' + x.duration : x.duration + (x.dots ? '.' : '') + (x.hasTuplet ? 't' : '') + ':' + x.notes.map(n => n.string + '/' + n.fret).join(',')).join(' ')).join(' | ');
/** Apply an edit the same way the app does: mutate, then normalize through JSON. */
function edit(score, fn) { const r = fn(score); return { score: ops.normalize(score, settings).score, result: r }; }
const at0 = { track: 0, bar: 0, beat: 0, string: 4 };

test('guitarist string numbering is the reverse of the model numbering', () => {
  const sc = load(TEX);
  assert.equal(ops.guitarString(6, 6), 1);
  assert.equal(ops.guitarString(6, 1), 6);
  assert.equal(ops.openPitch(ops.staffOf(sc, at0), 6), 64); // model string 6 = high E
  assert.equal(ops.openPitch(ops.staffOf(sc, at0), 1), 40); // model string 1 = low E
});

test('typing a fret changes an existing note or adds a chord tone', () => {
  let sc = load(TEX);
  sc = edit(sc, s => ops.setFret(s, at0, 12)).score;
  sc = edit(sc, s => ops.setFret(s, { ...at0, string: 6 }, 3)).score;
  assert.match(sig(sc), /^8:4\/12,6\/3 /);
  assert.throws(() => ops.setFret(sc, at0, 25));
});

test('deleting the last note leaves a rest, deleting a rest removes the beat', () => {
  let sc = load(TEX);
  sc = edit(sc, s => ops.deleteAtCursor(s, at0)).score;
  assert.match(sig(sc), /^r8 8:4\/7/);
  sc = edit(sc, s => ops.deleteAtCursor(s, at0)).score;
  assert.match(sig(sc), /^8:4\/7 8:4\/5/);
});

test('duration, dot, triplet and bar-fill check', () => {
  let sc = load(TEX);
  assert.deepEqual(ops.badBars(sc, 0), []);
  sc = edit(sc, s => ops.setDuration(s, at0, 4)).score;
  assert.deepEqual(ops.badBars(sc, 0), [0]);
  assert.deepEqual(ops.barFill(sc, 0, 0), { used: 3840 + 480, total: 3840 });
  sc = edit(sc, s => { ops.setDuration(s, at0, 16); ops.toggleDot(s, at0); }).score;
  assert.match(sig(sc), /^16\.:4\/5/);
  assert.equal(ops.barFill(sc, 0, 0).used, 3840 - 480 + 360);
  sc = edit(sc, s => { ops.toggleDot(s, at0); ops.toggleTriplet(s, at0); }).score;
  assert.match(sig(sc), /^16t:4\/5/);
  sc = edit(sc, s => ops.toggleTriplet(s, at0)).score;
  assert.match(sig(sc), /^16:4\/5/);
});

test('insert and delete bars keep every track aligned', () => {
  let sc = load(TEX + String.raw` \track "B" \tuning (G2 D2 A1 E1) 3.4 | 3.4 | 3.4`);
  sc = edit(sc, s => ops.insertBar(s, 1)).score;
  assert.equal(sc.masterBars.length, 4);
  sc.tracks.forEach(t => assert.equal(t.staves[0].bars.length, 4));
  assert.ok(sc.tracks[1].staves[0].bars[1].voices[0].beats[0].isRest);
  assert.equal(sc.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].fret, 1);
  sc = edit(sc, s => ops.deleteBar(s, 1)).score;
  assert.equal(sig(sc), sig(load(TEX)));
});

test('moving right past the end extends the bar, then the score', () => {
  let sc = load(String.raw`\track "G" :4 5.3 5.3`);
  let c = { track: 0, bar: 0, beat: 1, string: 4 };
  let r = edit(sc, s => ops.moveRight(s, c)); sc = r.score; c = r.result.cursor;
  assert.equal(r.result.changed, true);
  assert.equal(sig(sc), '4:4/5 4:4/5 r4');
  sc = edit(sc, s => ops.setFret(s, c, 7)).score;
  r = edit(sc, s => ops.moveRight(s, c)); sc = r.score; c = r.result.cursor;
  sc = edit(sc, s => ops.setFret(s, c, 8)).score;
  r = edit(sc, s => ops.moveRight(s, c)); sc = r.score; c = r.result.cursor;
  assert.deepEqual([c.bar, c.beat, sc.masterBars.length], [1, 0, 2]);
  // A blank last bar does not keep growing.
  assert.equal(ops.moveRight(sc, c).changed, false);
  assert.deepEqual(ops.moveLeft(sc, c), { ...c, bar: 0, beat: 3 });
});

test('techniques toggle on and off and survive a Guitar Pro export', () => {
  let sc = load(TEX);
  for (const t of ['hammer', 'slide', 'vibrato', 'palmMute', 'dead', 'harmonic', 'ghost', 'tap', 'bend'])
    sc = edit(sc, s => ops.toggleTechnique(s, at0, t)).score;
  let st = ops.techniqueState(sc, at0);
  for (const t of ['hammer', 'slide', 'vibrato', 'palmMute', 'dead', 'harmonic', 'ghost', 'tap', 'bend']) assert.equal(st[t], true, t);
  assert.equal(st.bendValue, 4);
  const back = at.importer.ScoreLoader.loadScoreFromBytes(new at.exporter.Gp7Exporter().export(sc, settings), settings);
  st = ops.techniqueState(back, at0);
  for (const t of ['hammer', 'slide', 'vibrato', 'palmMute', 'dead', 'harmonic', 'ghost', 'tap', 'bend']) assert.equal(st[t], true, 'gp ' + t);
  // Bend cycles full → half → 1½ → 2 → off
  const seen = [];
  for (let i = 0; i < 4; i++) { sc = edit(sc, s => ops.toggleTechnique(s, at0, 'bend')).score; seen.push(ops.techniqueState(sc, at0).bendValue); }
  assert.deepEqual(seen, [2, 6, 8, 0]);
  sc = edit(sc, s => ops.toggleTechnique(s, at0, 'letRing')).score;
  st = ops.techniqueState(sc, at0);
  assert.deepEqual([st.letRing, st.palmMute], [true, false]);
  assert.throws(() => ops.toggleTechnique(load(String.raw`\track "G" r`), { ...at0 }, 'hammer'));
});

test('same pitch on another string', () => {
  let sc = load(TEX); // first note: model string 4 (G string) fret 5 = C4
  const alts = ops.alternatePositions(sc, at0);
  assert.deepEqual(alts.map(a => [a.string, a.fret]), [[5, 1], [4, 5], [3, 10], [2, 15], [1, 20]]);
  const r = edit(sc, s => ops.moveNoteToString(s, at0, 3));
  assert.match(sig(r.score), /^8:3\/10 /);
  assert.equal(r.result.string, 3);
});

test('undo and redo restore snapshots and cursors', () => {
  const h = new ops.History();
  let sc = load(TEX);
  const before = { data: ops.serialize(sc), cursor: at0 };
  h.record(before);
  sc = edit(sc, s => ops.setFret(s, at0, 9)).score;
  const after = { data: ops.serialize(sc), cursor: at0 };
  const u = h.undo(after);
  assert.match(sig(ops.deserialize(u.data, settings)), /^8:4\/5 /);
  const r = h.redo(u);
  assert.match(sig(ops.deserialize(r.data, settings)), /^8:4\/9 /);
  assert.equal(h.redo(r), null);
});

test('blank bars are full bars of rest and typing starts them with the input note value', () => {
  let sc = load(String.raw`\track "G" \ts 3 4 :4 5.3 5.3 5.3`);
  sc = edit(sc, s => ops.insertBar(s, 1)).score;
  assert.equal(sig(sc), '4:4/5 4:4/5 4:4/5 | r2 r4');
  assert.deepEqual(ops.badBars(sc, 0), []);
  sc = edit(sc, s => ops.setFret(s, { track: 0, bar: 1, beat: 0, string: 6 }, 3, 8)).score;
  assert.equal(sig(sc), '4:4/5 4:4/5 4:4/5 | 8:6/3');
  assert.deepEqual(ops.restsFor(3840 * 7 / 8), [2, 4, 8]);
});

test('tempo, key and time signature', () => {
  let sc = load(TEX);
  sc = edit(sc, s => ops.setTempo(s, 96)).score;
  assert.equal(sc.tempo, 96);
  sc = edit(sc, s => ops.setKeySignature(s, 1, 2, false)).score;
  assert.deepEqual(sc.tracks[0].staves[0].bars.map(b => b.keySignature), [0, 2, 2]);
  sc = edit(sc, s => ops.setKeySignature(s, 0, -3, true)).score; // only bar 1: the next bar already has another key
  assert.deepEqual(sc.tracks[0].staves[0].bars.map(b => [b.keySignature, b.keySignatureType]), [[-3, 1], [2, 0], [2, 0]]);
  sc = edit(sc, s => ops.setTimeSignature(s, 1, 6, 8)).score;
  assert.deepEqual(sc.masterBars.map(m => `${m.timeSignatureNumerator}/${m.timeSignatureDenominator}`), ['4/4', '6/8', '6/8']);
  assert.deepEqual(ops.badBars(sc, 0), [1, 2]); // written bars are flagged, not silently rewritten
  const back = at.importer.ScoreLoader.loadScoreFromBytes(new at.exporter.Gp7Exporter().export(sc, settings), settings);
  assert.equal(back.tempo, 96);
  assert.deepEqual(back.tracks[0].staves[0].bars.map(b => b.keySignature), [-3, 2, 2]);
  assert.equal(back.masterBars[2].timeSignatureNumerator, 6);
});

test('chord names and text above a beat survive a Guitar Pro export', () => {
  let sc = load(TEX);
  sc = edit(sc, s => { ops.setChordName(s, at0, 'Am7'); ops.setBeatText(s, at0, 'let it breathe'); }).score;
  sc = edit(sc, s => ops.setChordName(s, { ...at0, beat: 2 }, 'Am7')).score;
  assert.equal(ops.chordNameAt(sc, at0), 'Am7');
  assert.equal(sc.tracks[0].staves[0].chords.size, 1); // same name reuses one chord entry
  const back = at.importer.ScoreLoader.loadScoreFromBytes(new at.exporter.Gp7Exporter().export(sc, settings), settings);
  assert.equal(ops.chordNameAt(back, at0), 'Am7');
  assert.equal(ops.chordNameAt(back, { ...at0, beat: 2 }), 'Am7');
  assert.equal(ops.beatOf(back, at0).text, 'let it breathe');
  sc = edit(sc, s => { ops.setChordName(s, at0, ''); ops.setBeatText(s, at0, ' '); }).score;
  assert.equal(ops.chordNameAt(sc, at0), '');
  assert.equal(ops.beatOf(sc, at0).text, null);
});

test('add, configure and delete tracks', () => {
  let sc = load(TEX);
  let r = edit(sc, s => ops.addTrack(s, 'bass')); sc = r.score;
  assert.equal(r.result, 1);
  const bass = sc.tracks[1];
  assert.deepEqual(bass.staves[0].tuning, [43, 38, 33, 28]);
  assert.equal(bass.staves[0].bars.length, sc.masterBars.length);
  assert.notEqual(bass.playbackInfo.primaryChannel, sc.tracks[0].playbackInfo.primaryChannel);
  assert.deepEqual(ops.badBars(sc, 1), []);
  assert.equal(ops.isEditable(sc, 1), true);
  sc = edit(sc, s => { ops.setFret(s, { track: 1, bar: 0, beat: 0, string: 1 }, 3, 4); ops.setProgram(s, 1, 34); ops.setTrackVolume(s, 1, 12); }).score;
  const back = at.importer.ScoreLoader.loadScoreFromBytes(new at.exporter.Gp7Exporter().export(sc, settings), settings);
  assert.equal(back.tracks.length, 2);
  assert.equal(back.tracks[1].playbackInfo.program, 34);
  assert.equal(back.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0].realValue, 28 + 3);
  sc = edit(sc, s => ops.deleteTrack(s, 0)).score;
  assert.equal(sc.tracks.length, 1);
  assert.equal(sc.tracks[0].index, 0);
  assert.throws(() => ops.deleteTrack(sc, 0));
});

test('changing the sound also changes the instrument marker on the first beat, so playback really changes', () => {
  let sc = load(String.raw`\track "G" \instrument 25 :4 5.3 5.3 5.3 5.3`);
  const programs = score => {
    const mf = new at.midi.MidiFile();
    new at.midi.MidiFileGenerator(score, settings, new at.midi.AlphaSynthMidiFileHandler(mf, true)).generate();
    return [...new Set(mf.tracks.flatMap(t => t.events).filter(e => e.constructor.name === 'ProgramChangeEvent').map(e => e.program))];
  };
  sc = edit(sc, s => ops.setProgram(s, 0, 30)).score;
  assert.deepEqual(programs(sc), [30]);
});

test('drums: new drum track, hits toggle on and off, play on channel 10 and survive Guitar Pro', () => {
  let sc = load(TEX);
  let r = edit(sc, s => ops.addDrumTrack(s)); sc = r.score;
  const d = { track: r.result, bar: 0, beat: 0, string: 0 };
  assert.equal(ops.isDrums(sc, d.track), true);
  assert.equal(ops.isWritable(sc, d.track), true);
  assert.deepEqual(ops.badBars(sc, d.track), []);
  const kick = ops.DRUM_KIT[0], snare = ops.DRUM_KIT[1], hat = ops.DRUM_KIT[2];
  sc = edit(sc, s => { ops.toggleDrum(s, d, kick, 8); ops.toggleDrum(s, d, hat); }).score;
  sc = edit(sc, s => { ops.toggleDrum(s, { ...d, beat: 0 }, hat); ops.toggleDrum(s, { ...d, beat: 0 }, snare); }).score;
  assert.deepEqual(ops.drumHits(sc, d).sort(), [36, 38]);
  assert.equal(ops.beatOf(sc, d).duration, 8);
  const mf = new at.midi.MidiFile();
  new at.midi.MidiFileGenerator(sc, settings, new at.midi.AlphaSynthMidiFileHandler(mf, true)).generate();
  const drumNotes = mf.tracks.flatMap(t => t.events).filter(e => e.constructor.name === 'NoteOnEvent' && e.channel === 9).map(e => e.noteKey);
  assert.deepEqual([...new Set(drumNotes)].sort(), [36, 38]);
  const back = at.importer.ScoreLoader.loadScoreFromBytes(new at.exporter.Gp7Exporter().export(sc, settings), settings);
  assert.equal(back.tracks[1].staves[0].isPercussion, true);
  assert.deepEqual(ops.drumHits(back, d).sort(), [36, 38]);
});

test('selecting beats: clear, delete, copy and paste a range across a bar line', () => {
  let sc = load(TEX); // bar 1: 8 8 8 8 4 4 | bar 2: 4 4 4 4 | bar 3: 1
  const range = ops.beatsBetween(sc, 0, { bar: 1, beat: 2 }, { bar: 0, beat: 4 });
  assert.deepEqual(range, [{ bar: 0, beat: 4 }, { bar: 0, beat: 5 }, { bar: 1, beat: 0 }, { bar: 1, beat: 1 }, { bar: 1, beat: 2 }]);
  let cleared = edit(load(TEX), s => ops.clearBeats(s, 0, range)).score;
  assert.equal(sig(cleared), '8:4/5 8:4/7 8:4/5 8:4/3 r4 r4 | r4 r4 r4 4:6/4 | 1:1/9');
  assert.deepEqual(ops.badBars(cleared, 0), []);
  const copied = ops.copyBeats(sc, 0, ops.beatsBetween(sc, 0, { bar: 1, beat: 0 }, { bar: 1, beat: 1 }));
  sc = ops.deserialize(ops.pasteBeats(sc, { track: 0, bar: 2, beat: 0, string: 1 }, copied), settings);
  assert.equal(sig(sc), '8:4/5 8:4/7 8:4/5 8:4/3 4:5/5 4:5/5 | 4:6/1 4:6/2 4:6/3 4:6/4 | 4:6/1 4:6/2 1:1/9');
  sc = edit(sc, s => ops.deleteBeats(s, 0, ops.beatsBetween(s, 0, { bar: 2, beat: 0 }, { bar: 2, beat: 2 }))).score;
  assert.equal(sig(sc).split(' | ')[2], 'r1');
});

test('pitch keys: sharpen, flatten and octave keep the note playable', () => {
  let sc = load(TEX); // first note: G string fret 5 (C4)
  let r = edit(sc, s => ops.shiftPitch(s, at0, 1)); sc = r.score;
  assert.match(sig(sc), /^8:4\/6 /);
  r = edit(sc, s => ops.shiftPitch(s, at0, 12)); sc = r.score;
  const n = ops.beatOf(sc, r.result).notes[0];
  assert.equal(ops.openPitch(ops.staffOf(sc, at0), n.string) + n.fret, 61 + 12);
  assert.ok(n.fret <= 12, `moved to a reachable position, got fret ${n.fret}`);
});

test('numbered notation: degrees follow the key and the nearest octave', () => {
  let sc = load(String.raw`\track "G" :4 r r r r`);
  sc = edit(sc, s => ops.setKeySignature(s, 0, 2, false)).score; // D major: 1 = D
  assert.equal(ops.tonicOf(2), 2);
  assert.equal(ops.tonicOf(-3), 3); // E flat
  let c = { track: 0, bar: 0, beat: 0, string: 6 };
  const pitches = [];
  for (const [i, d] of [1, 3, 5, 1].entries()) {
    const r = edit(sc, s => ops.enterDegree(s, { ...c, beat: i }, d)); sc = r.score;
    const n = ops.beatOf(sc, r.result).notes[0];
    pitches.push(ops.openPitch(ops.staffOf(sc, c), n.string) + n.fret);
  }
  assert.deepEqual(pitches.map(p => p % 12), [2, 6, 9, 2]);
  assert.ok(pitches.every((p, i) => !i || Math.abs(p - pitches[i - 1]) <= 7), `stays close: ${pitches}`);
});

test('numbered notation replaces a single melody note instead of stacking a chord', () => {
  let sc = load(String.raw`\track "G" :4 5.2 7.2 8.2 r`);
  const r = edit(sc, s => ops.enterDegree(s, { track: 0, bar: 0, beat: 1, string: 6 }, 5)); sc = r.score; // C major: 5 = G
  const notes = ops.beatOf(sc, r.result).notes;
  assert.equal(notes.length, 1);
  assert.equal((ops.openPitch(ops.staffOf(sc, r.result), notes[0].string) + notes[0].fret) % 12, 7);
});
