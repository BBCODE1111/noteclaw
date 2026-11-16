// Pure score-editing operations on the alphaTab model. No DOM here, so everything is testable in Node.
//
// Editing strategy: an operation mutates the model loosely (array splices, field writes) and the
// caller then runs `normalize()`, which round-trips the score through alphaTab's own JSON format.
// That rebuilds every index, linked-list pointer and derived value, so operations never have to
// maintain alphaTab's internal bookkeeping by hand.
//
// String numbering: alphaTab's model uses 1 = LOWEST pitched string. Guitarists (and this app's UI)
// use 1 = HIGHEST. `Cursor.string` is the model number; use `guitarString()` for anything shown.
import * as alphaTab from '@coderline/alphatab';

type Score = alphaTab.model.Score;
type Staff = alphaTab.model.Staff;
type Bar = alphaTab.model.Bar;
type Beat = alphaTab.model.Beat;
type Note = alphaTab.model.Note;
const { Beat: BeatCls, Note: NoteCls, Bar: BarCls, Voice: VoiceCls, MasterBar: MasterBarCls, Track: TrackCls, Staff: StaffCls,
  Chord: ChordCls, Tuning, Automation, AutomationType, Clef, BendPoint, BendType, InstrumentArticulation,
  SlideOutType, HarmonicType, VibratoType, JsonConverter } = alphaTab.model;

export interface Cursor { track: number; bar: number; beat: number; string: number }
export type Snapshot = Map<string, unknown>;
export const DURATIONS = [1, 2, 4, 8, 16, 32] as const;
export const MAX_FRET = 24;

export const serialize = (score: Score): Snapshot => JsonConverter.scoreToJsObject(score) as Snapshot;
export const deserialize = (data: Snapshot, settings: alphaTab.Settings): Score => JsonConverter.jsObjectToScore(data, settings);
export function normalize(score: Score, settings: alphaTab.Settings): { score: Score; data: Snapshot } {
  const data = serialize(score);
  return { score: deserialize(data, settings), data };
}

// ---- lookup helpers ----
export const staffOf = (score: Score, c: Cursor): Staff => score.tracks[c.track].staves[0];
export const barOf = (score: Score, c: Cursor): Bar => staffOf(score, c).bars[c.bar];
export const beatsOf = (score: Score, c: Cursor): Beat[] => barOf(score, c).voices[0].beats;
export const beatOf = (score: Score, c: Cursor): Beat => beatsOf(score, c)[c.beat];
export const noteAt = (score: Score, c: Cursor): Note | null => beatOf(score, c)?.notes.find(n => n.string === c.string) ?? null;
export const stringCount = (score: Score, c: Cursor): number => staffOf(score, c).tuning.length;
export const isEditable = (score: Score, track: number): boolean => {
  const staff = score.tracks[track]?.staves[0];
  return !!staff && !staff.isPercussion && staff.tuning.length > 0 && staff.showTablature;
};
export const isDrums = (score: Score, track: number): boolean => !!score.tracks[track]?.staves[0]?.isPercussion;
/** Tracks the editor can write into: fretted instruments shown as tablature, and drums. */
export const isWritable = (score: Score, track: number): boolean => isEditable(score, track) || isDrums(score, track);
/** Guitarist string number (1 = highest pitched string) for a model string number. */
export const guitarString = (count: number, modelString: number): number => count + 1 - modelString;
export const openPitch = (staff: Staff, modelString: number): number => staff.tuning[staff.tuning.length - modelString];

export function clampCursor(score: Score, c: Cursor): Cursor {
  const track = Math.min(Math.max(c.track, 0), score.tracks.length - 1);
  const staff = score.tracks[track].staves[0];
  const bar = Math.min(Math.max(c.bar, 0), staff.bars.length - 1);
  const beats = staff.bars[bar].voices[0].beats;
  const beat = Math.min(Math.max(c.beat, 0), Math.max(beats.length - 1, 0));
  const strings = Math.max(staff.tuning.length, 1);
  return { track, bar, beat, string: Math.min(Math.max(c.string, 1), strings) };
}

/** Ticks used by voice 1 of a bar versus what the time signature allows (960 ticks = quarter note). */
export function barFill(score: Score, track: number, bar: number): { used: number; total: number } {
  const beats = score.tracks[track].staves[0].bars[bar].voices[0].beats;
  const used = beats.reduce((sum, b) => sum + (b.isEmpty ? 0 : b.playbackDuration), 0);
  return { used, total: score.masterBars[bar].calculateDuration(false) };
}
export function badBars(score: Score, track: number): number[] {
  const out: number[] = [];
  score.masterBars.forEach((_, i) => { const f = barFill(score, track, i); if (f.used !== f.total) out.push(i); });
  return out;
}

// ---- construction helpers ----
function restBeat(duration: number): Beat {
  const b = new BeatCls();
  b.duration = duration as alphaTab.model.Duration;
  b.isEmpty = false;
  return b;
}
function emptyBarLike(template: Bar, duration: number): Bar {
  const bar = new BarCls();
  bar.clef = template.clef;
  bar.clefOttava = template.clefOttava;
  bar.keySignature = template.keySignature;
  bar.keySignatureType = template.keySignatureType;
  const voice = new VoiceCls();
  voice.beats.push(restBeat(duration));
  bar.voices.push(voice);
  return bar;
}
/** Rest values (largest first) that exactly fill `ticks`; 960 ticks = quarter note. */
export function restsFor(ticks: number): number[] {
  const out: number[] = [];
  let left = ticks;
  for (const d of DURATIONS) { const len = 3840 / d; while (left >= len) { out.push(d); left -= len; } }
  return out.length ? out : [4];
}
function fillWithRests(bar: Bar, ticks: number): void {
  bar.voices[0].beats = restsFor(ticks).map(restBeat);
}
/** True when a bar holds nothing but rests, i.e. nothing has been written in it yet. */
export const isBlankBar = (score: Score, c: Cursor): boolean => beatsOf(score, c).every(b => b.isRest || b.isEmpty);

// ---- cursor movement (moveRight may extend the score, like typing past the end of a line) ----
export interface MoveResult { cursor: Cursor; changed: boolean }
export function moveLeft(score: Score, c: Cursor): Cursor {
  if (c.beat > 0) return { ...c, beat: c.beat - 1 };
  if (c.bar === 0) return c;
  const prev = { ...c, bar: c.bar - 1, beat: 0 };
  return { ...prev, beat: beatsOf(score, prev).length - 1 };
}
export function moveRight(score: Score, c: Cursor): MoveResult {
  const beats = beatsOf(score, c);
  if (c.beat < beats.length - 1) return { cursor: { ...c, beat: c.beat + 1 }, changed: false };
  const current = beats[c.beat];
  const fill = barFill(score, c.track, c.bar);
  const hasRoom = fill.used < fill.total;
  // Bar still has room and the player just wrote a note here: continue with the same note value.
  if (hasRoom && current.notes.length > 0) {
    beats.push(restBeat(current.duration));
    return { cursor: { ...c, beat: c.beat + 1 }, changed: true };
  }
  if (c.bar < score.masterBars.length - 1) return { cursor: { ...c, bar: c.bar + 1, beat: 0 }, changed: false };
  // At the very end: add a bar once the last one is full. A trailing rest never grows the score.
  if (hasRoom || beats.every(b => b.isRest || b.isEmpty)) return { cursor: c, changed: false };
  insertBar(score, score.masterBars.length, current.duration);
  return { cursor: { ...c, bar: c.bar + 1, beat: 0 }, changed: true };
}
export const moveString = (score: Score, c: Cursor, towardsHigher: boolean): Cursor =>
  clampCursor(score, { ...c, string: c.string + (towardsHigher ? 1 : -1) });

// ---- note / beat edits ----
/** First note in an untouched bar: replace the placeholder rests so the bar is written left to right. */
function startBlankBar(score: Score, c: Cursor, inputDuration: number): void {
  if (inputDuration && isBlankBar(score, c) && c.beat === 0) beatsOf(score, c).splice(0, Infinity, restBeat(inputDuration));
}
export function setFret(score: Score, c: Cursor, fret: number, inputDuration = 0): void {
  if (fret < 0 || fret > MAX_FRET) throw new Error(`格數必須在 0–${MAX_FRET} 之間`);
  startBlankBar(score, c, inputDuration);
  const beat = beatOf(score, c);
  beat.isEmpty = false;
  const existing = noteAt(score, c);
  if (existing) { existing.fret = fret; return; }
  const note = new NoteCls();
  note.string = c.string;
  note.fret = fret;
  beat.addNote(note);
}
/** Remove the note under the cursor. On a rest, remove the beat itself. */
export function deleteAtCursor(score: Score, c: Cursor): Cursor {
  const beat = beatOf(score, c);
  if (isDrums(score, c.track) && beat.notes.length) { [...beat.notes].forEach(n => beat.removeNote(n)); return c; }
  const note = noteAt(score, c);
  if (note) { beat.removeNote(note); return c; }
  if (beat.notes.length === 0) return deleteBeat(score, c);
  return c;
}
export function deleteBeat(score: Score, c: Cursor): Cursor {
  const beats = beatsOf(score, c);
  if (beats.length <= 1) {
    const only = beats[0];
    [...only.notes].forEach(n => only.removeNote(n));
    only.isEmpty = false;
    return c;
  }
  beats.splice(c.beat, 1);
  return { ...c, beat: Math.min(c.beat, beats.length - 1) };
}
export function insertBeat(score: Score, c: Cursor): Cursor {
  const beats = beatsOf(score, c);
  beats.splice(c.beat, 0, restBeat(beats[c.beat].duration));
  return c;
}
export function setDuration(score: Score, c: Cursor, duration: number): void {
  if (!(DURATIONS as readonly number[]).includes(duration)) throw new Error('不支援的時值');
  const beat = beatOf(score, c);
  beat.isEmpty = false;
  beat.duration = duration as alphaTab.model.Duration;
}
export function stepDuration(score: Score, c: Cursor, shorter: boolean): void {
  const i = (DURATIONS as readonly number[]).indexOf(beatOf(score, c).duration);
  const next = DURATIONS[Math.min(Math.max((i < 0 ? 2 : i) + (shorter ? 1 : -1), 0), DURATIONS.length - 1)];
  setDuration(score, c, next);
}
export function toggleDot(score: Score, c: Cursor): void {
  const beat = beatOf(score, c);
  beat.dots = beat.dots ? 0 : 1;
}
export function toggleTriplet(score: Score, c: Cursor): void {
  const beat = beatOf(score, c);
  if (beat.hasTuplet) { beat.tupletNumerator = -1; beat.tupletDenominator = -1; }
  else { beat.tupletNumerator = 3; beat.tupletDenominator = 2; }
}
export function makeRest(score: Score, c: Cursor): void {
  const beat = beatOf(score, c);
  [...beat.notes].forEach(n => beat.removeNote(n));
  beat.isEmpty = false;
}
/** Move the note under the cursor to another string keeping its pitch. Returns the new cursor. */
export function moveNoteToString(score: Score, c: Cursor, modelString: number): Cursor {
  const note = noteAt(score, c);
  const staff = staffOf(score, c);
  if (!note) throw new Error('游標位置沒有音符');
  const pitch = openPitch(staff, note.string) + note.fret;
  const fret = pitch - openPitch(staff, modelString);
  if (fret < 0 || fret > MAX_FRET) throw new Error('這條弦彈不到這個音');
  if (beatOf(score, c).notes.some(n => n !== note && n.string === modelString)) throw new Error('這條弦在同一拍已經有音符');
  note.string = modelString;
  note.fret = fret;
  return { ...c, string: modelString };
}
export function alternatePositions(score: Score, c: Cursor): { string: number; fret: number; current: boolean }[] {
  const note = noteAt(score, c);
  if (!note) return [];
  const staff = staffOf(score, c);
  const pitch = openPitch(staff, note.string) + note.fret;
  const out: { string: number; fret: number; current: boolean }[] = [];
  for (let s = staff.tuning.length; s >= 1; s--) {
    const fret = pitch - openPitch(staff, s);
    if (fret >= 0 && fret <= MAX_FRET) out.push({ string: s, fret, current: s === note.string });
  }
  return out;
}

// ---- techniques ----
export type Technique = 'hammer' | 'slide' | 'bend' | 'vibrato' | 'palmMute' | 'letRing' | 'dead' | 'harmonic' | 'tap' | 'ghost';
/** Bend amounts cycled by the bend command, in quarter tones (4 = whole step). */
const BEND_STEPS = [4, 2, 6, 8];
function targets(score: Score, c: Cursor): Note[] {
  const note = noteAt(score, c);
  return note ? [note] : [...beatOf(score, c).notes];
}
export function bendValue(note: Note): number {
  if (note.bendType === BendType.None || !note.bendPoints?.length) return 0;
  return Math.max(...note.bendPoints.map(p => p.value));
}
export function techniqueState(score: Score, c: Cursor): Record<Technique, boolean> & { bendValue: number } {
  const notes = targets(score, c);
  const beat = beatOf(score, c);
  const any = (f: (n: Note) => boolean) => notes.length > 0 && notes.every(f);
  return {
    hammer: any(n => n.isHammerPullOrigin), slide: any(n => n.slideOutType !== SlideOutType.None),
    bend: any(n => n.bendType !== BendType.None), vibrato: any(n => n.vibrato !== VibratoType.None),
    palmMute: any(n => n.isPalmMute), letRing: any(n => n.isLetRing), dead: any(n => n.isDead),
    harmonic: any(n => n.harmonicType !== HarmonicType.None), ghost: any(n => n.isGhost), tap: !!beat?.tap,
    bendValue: notes.length ? bendValue(notes[0]) : 0
  };
}
export function toggleTechnique(score: Score, c: Cursor, technique: Technique, force?: boolean): void {
  const beat = beatOf(score, c);
  const notes = targets(score, c);
  if (!notes.length) throw new Error('休止符不能加演奏技巧，請先輸入音符');
  const on = force ?? !techniqueState(score, c)[technique];
  if (technique === 'tap') { beat.tap = on; return; }
  for (const n of notes) {
    if (technique === 'bend' && force !== undefined && (bendValue(n) > 0) === force) continue;
    switch (technique) {
      case 'hammer': n.isHammerPullOrigin = on; break;
      case 'slide': n.slideOutType = on ? SlideOutType.Shift : SlideOutType.None; break;
      case 'vibrato': n.vibrato = on ? VibratoType.Slight : VibratoType.None; break;
      case 'palmMute': n.isPalmMute = on; if (on) n.isLetRing = false; break;
      case 'letRing': n.isLetRing = on; if (on) n.isPalmMute = false; break;
      case 'dead': n.isDead = on; break;
      case 'ghost': n.isGhost = on; break;
      case 'harmonic': n.harmonicType = on ? HarmonicType.Natural : HarmonicType.None; break;
      case 'bend': {
        // Cycle: none → full → half → 1½ → 2 steps → none
        const current = bendValue(n);
        const next = current === 0 ? BEND_STEPS[0] : BEND_STEPS[BEND_STEPS.indexOf(current) + 1 || BEND_STEPS.length];
        n.bendPoints = [];
        if (next === undefined) { n.bendType = BendType.None; break; }
        n.bendType = BendType.Bend;
        n.addBendPoint(new BendPoint(0, 0));
        n.addBendPoint(new BendPoint(BendPoint.MaxPosition, next));
        break;
      }
    }
  }
}

// ---- bars ----
/** Insert an empty bar so that it becomes bar number `index` (0-based) in every track. */
export function insertBar(score: Score, index: number, duration = 4): void {
  const ref = score.masterBars[Math.min(Math.max(index - 1, 0), score.masterBars.length - 1)];
  const mb = new MasterBarCls();
  mb.timeSignatureNumerator = ref.timeSignatureNumerator;
  mb.timeSignatureDenominator = ref.timeSignatureDenominator;
  mb.timeSignatureCommon = ref.timeSignatureCommon;
  mb.tripletFeel = ref.tripletFeel;
  const ticks = ref.calculateDuration(false);
  score.masterBars.splice(index, 0, mb);
  for (const track of score.tracks) for (const staff of track.staves) {
    const template = staff.bars[Math.min(Math.max(index - 1, 0), staff.bars.length - 1)];
    const bar = emptyBarLike(template, duration);
    fillWithRests(bar, ticks);
    staff.bars.splice(index, 0, bar);
  }
}
export function deleteBar(score: Score, index: number): void {
  if (score.masterBars.length <= 1) throw new Error('至少要保留一個小節');
  score.masterBars.splice(index, 1);
  for (const track of score.tracks) for (const staff of track.staves) staff.bars.splice(index, 1);
}

// ---- pitch changes ----
/** Where to put `pitch` on this staff: the cursor's string if it can be played there, otherwise the string
 *  whose fret is closest to `nearFret`, skipping strings already used on this beat. */
function placePitch(staff: Staff, beat: Beat, pitch: number, prefer: number, nearFret: number, except: Note | null): { string: number; fret: number } | null {
  const used = new Set(beat.notes.filter(n => n !== except).map(n => n.string));
  const options: { string: number; fret: number }[] = [];
  for (let s = 1; s <= staff.tuning.length; s++) {
    const fret = pitch - openPitch(staff, s);
    if (fret >= 0 && fret <= MAX_FRET && !used.has(s)) options.push({ string: s, fret });
  }
  if (!options.length) return null;
  const preferred = options.find(o => o.string === prefer && Math.abs(o.fret - nearFret) <= 5);
  return preferred ?? options.reduce((a, b) => (Math.abs(b.fret - nearFret) < Math.abs(a.fret - nearFret) ? b : a));
}
/** The pitch and fret of the closest sounding note before the cursor in this voice (for choosing octaves and positions). */
function previousNote(score: Score, c: Cursor): { pitch: number; fret: number } | null {
  const staff = staffOf(score, c);
  for (let bar = c.bar; bar >= 0; bar--) {
    const beats = staff.bars[bar].voices[0].beats;
    for (let i = bar === c.bar ? c.beat - 1 : beats.length - 1; i >= 0; i--) {
      const notes = beats[i].notes;
      if (notes.length) { const n = notes.reduce((a, b) => (b.string > a.string ? b : a)); return { pitch: openPitch(staff, n.string) + n.fret, fret: n.fret }; }
    }
  }
  return null;
}
/** Raise or lower the note under the cursor (or every note of the beat) by `semitones`, re-placing it on another string when needed. */
export function shiftPitch(score: Score, c: Cursor, semitones: number): Cursor {
  const staff = staffOf(score, c), beat = beatOf(score, c);
  const at = noteAt(score, c);
  const notes = at ? [at] : [...beat.notes];
  if (!notes.length) throw new Error('游標位置沒有音符');
  let cursor = c;
  for (const n of notes) {
    const pitch = openPitch(staff, n.string) + n.fret + semitones;
    const spot = placePitch(staff, beat, pitch, n.string, n.fret, n);
    if (!spot) throw new Error('移調後這個樂器彈不到這個音');
    if (n === at) cursor = { ...c, string: spot.string };
    n.string = spot.string; n.fret = spot.fret;
  }
  return cursor;
}

// ---- numbered notation (簡譜) entry ----
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
/** Pitch class of "1" for a key signature (sharps positive, flats negative): movable do on the major key. */
export const tonicOf = (keySignature: number): number => (((keySignature * 7) % 12) + 12) % 12;
/**
 * Write scale degree 1–7 at the cursor. The octave is the one closest to the previous note, so a melody can be
 * typed without octave marks; `[` / `]` and the octave keys fix the rest. Replaces the note under the cursor.
 */
export function enterDegree(score: Score, c: Cursor, degree: number, inputDuration = 0): Cursor {
  if (!(degree >= 1 && degree <= 7)) throw new Error('簡譜只有 1 到 7');
  startBlankBar(score, c, inputDuration);
  const staff = staffOf(score, c), beat = beatOf(score, c);
  const pc = (tonicOf(barOf(score, c).keySignature) + MAJOR_STEPS[degree - 1]) % 12;
  const prev = previousNote(score, c);
  const centre = (staff.tuning[0] + staff.tuning[staff.tuning.length - 1]) / 2 + 6;
  const reference = prev?.pitch ?? centre;
  let pitch = pc + 12 * Math.round((reference - pc) / 12);
  const low = staff.tuning[staff.tuning.length - 1], high = staff.tuning[0] + MAX_FRET;
  while (pitch < low) pitch += 12;
  while (pitch > high) pitch -= 12;
  // Melody entry: the note under the cursor, or the only note of the beat, is replaced; on a chord a new note is added.
  const existing = noteAt(score, c) ?? (beat.notes.length === 1 ? beat.notes[0] : null);
  const spot = placePitch(staff, beat, pitch, existing?.string ?? c.string, existing?.fret ?? prev?.fret ?? 5, existing);
  if (!spot) throw new Error('這一拍已經沒有空的弦可以放這個音');
  beat.isEmpty = false;
  if (existing) { existing.string = spot.string; existing.fret = spot.fret; }
  else { const n = new NoteCls(); n.string = spot.string; n.fret = spot.fret; beat.addNote(n); }
  return { ...c, string: spot.string };
}

// ---- drums ----
export interface DrumPiece { key: string; id: number; name: string; element: string; line: number; out: number; heads: [number, number, number] }
const HEAD = [57508, 57507, 57506] as [number, number, number], X = [57513, 57513, 57513] as [number, number, number];
/** A standard kit on number keys, using Guitar Pro's articulation ids so files exchange cleanly. */
export const DRUM_KIT: DrumPiece[] = [
  { key: '1', id: 36, name: '大鼓', element: 'Kick Drum', line: 7, out: 36, heads: HEAD },
  { key: '2', id: 38, name: '小鼓', element: 'Snare', line: 3, out: 38, heads: HEAD },
  { key: '3', id: 42, name: 'Hi-hat 閉', element: 'Charley', line: -1, out: 42, heads: X },
  { key: '4', id: 46, name: 'Hi-hat 開', element: 'Charley', line: -1, out: 46, heads: [57523, 57523, 57523] },
  { key: '5', id: 49, name: 'Crash', element: 'Crash High', line: -2, out: 49, heads: [57592, 57592, 57592] },
  { key: '6', id: 51, name: 'Ride', element: 'Ride', line: 0, out: 51, heads: X },
  { key: '7', id: 48, name: '高音 Tom', element: 'Tom High', line: 2, out: 48, heads: HEAD },
  { key: '8', id: 47, name: '中音 Tom', element: 'Tom Medium', line: 4, out: 47, heads: HEAD },
  { key: '9', id: 43, name: '落地 Tom', element: 'Tom Very Low', line: 6, out: 43, heads: HEAD },
  { key: '0', id: 37, name: '邊擊', element: 'Snare', line: 3, out: 37, heads: X }
];
/** MIDI drum sounds (GM numbers) struck on this beat. */
export function drumHits(score: Score, c: Cursor): number[] {
  const track = score.tracks[c.track];
  return beatOf(score, c).notes.map(n => track.percussionArticulations[n.percussionArticulation]?.outputMidiNumber ?? -1);
}
/** Add or remove one kit piece on the beat under the cursor. */
export function toggleDrum(score: Score, c: Cursor, piece: DrumPiece, inputDuration = 0): void {
  if (!isDrums(score, c.track)) throw new Error('這不是鼓組軌');
  startBlankBar(score, c, inputDuration);
  const track = score.tracks[c.track], beat = beatOf(score, c);
  const hit = beat.notes.find(n => track.percussionArticulations[n.percussionArticulation]?.outputMidiNumber === piece.out);
  if (hit) { beat.removeNote(hit); return; }
  const art = new InstrumentArticulation(piece.element, piece.line, piece.out, piece.heads[0], piece.heads[1], piece.heads[2], -1, 1, piece.id);
  const note = new NoteCls();
  note.percussionArticulation = track.getOrRegisterPercussionArticulation(art);
  beat.isEmpty = false;
  beat.addNote(note);
}
export function addDrumTrack(score: Score): number {
  const track = new TrackCls();
  track.name = '鼓組'; track.shortName = 'Drums';
  track.playbackInfo.program = 0; track.playbackInfo.primaryChannel = 9; track.playbackInfo.secondaryChannel = 9;
  const staff = new StaffCls();
  staff.isPercussion = true; staff.showTablature = false; staff.showStandardNotation = true; staff.showNumbered = false;
  score.masterBars.forEach(mb => {
    const bar = new BarCls();
    bar.clef = Clef.Neutral;
    bar.voices.push(new VoiceCls());
    fillWithRests(bar, mb.calculateDuration(false));
    staff.bars.push(bar);
  });
  track.staves.push(staff);
  score.tracks.push(track);
  return score.tracks.length - 1;
}

// ---- ranges of beats (selection, clipboard) ----
export interface Pos { bar: number; beat: number }
const before = (a: Pos, b: Pos) => a.bar < b.bar || (a.bar === b.bar && a.beat <= b.beat);
/** Every beat from `a` to `b` (either order), inclusive, in voice 1 of a track. */
export function beatsBetween(score: Score, track: number, a: Pos, b: Pos): Pos[] {
  const [from, to] = before(a, b) ? [a, b] : [b, a];
  const staff = score.tracks[track].staves[0], out: Pos[] = [];
  for (let bar = from.bar; bar <= to.bar; bar++) {
    const count = staff.bars[bar].voices[0].beats.length;
    for (let beat = bar === from.bar ? from.beat : 0; beat <= (bar === to.bar ? Math.min(to.beat, count - 1) : count - 1); beat++) out.push({ bar, beat });
  }
  return out;
}
/** Turn the beats into rests (lengths stay, so the bars still add up). */
export function clearBeats(score: Score, track: number, list: Pos[]): void {
  for (const p of list) makeRest(score, { track, bar: p.bar, beat: p.beat, string: 0 });
}
/** Remove the beats. A bar left with nothing becomes a bar of rest. */
export function deleteBeats(score: Score, track: number, list: Pos[]): void {
  const staff = score.tracks[track].staves[0];
  const byBar = new Map<number, number[]>();
  for (const p of list) byBar.set(p.bar, [...(byBar.get(p.bar) ?? []), p.beat]);
  for (const [bar, beats] of byBar) {
    const voice = staff.bars[bar].voices[0];
    voice.beats = voice.beats.filter((_, i) => !beats.includes(i));
    if (!voice.beats.length) fillWithRests(staff.bars[bar], score.masterBars[bar].calculateDuration(false));
  }
}
type BeatData = Map<string, unknown>;
const beatList = (data: Snapshot, track: number, bar: number): BeatData[] =>
  (((((data.get('tracks') as Snapshot[])[track].get('staves') as Snapshot[])[0].get('bars') as Snapshot[])[bar].get('voices') as Snapshot[])[0].get('beats') as BeatData[]);
/** Copy of the beats in alphaTab's own data form (keeps every property: techniques, text, chords, drums). */
export function copyBeats(score: Score, track: number, list: Pos[]): BeatData[] {
  const data = serialize(score);
  return list.map(p => {
    const beat = structuredClone(beatList(data, track, p.bar)[p.beat]);
    // Pasted beats are new beats: drop ids and links to notes that are not part of the copy.
    beat.delete('id'); beat.delete('chordid');
    for (const n of (beat.get('notes') as BeatData[]) ?? []) {
      n.delete('id'); n.delete('hammerpulldestinationnoteid'); n.delete('tiedestinationnoteid'); n.delete('slurdestinationnoteid'); n.delete('slidetargetnoteid');
      n.set('istiedestination', false); n.set('ishammerpullorigin', false);
    }
    return beat;
  });
}
/** Insert copied beats before the cursor beat. Returns the new score data and the cursor on the first pasted beat. */
export function pasteBeats(score: Score, c: Cursor, beats: BeatData[]): Snapshot {
  if (!beats.length) throw new Error('剪貼簿是空的');
  const data = serialize(score);
  const list = beatList(data, c.track, c.bar);
  const atBlank = isBlankBar(score, c);
  // Pasting into an untouched bar replaces its placeholder rests.
  list.splice(atBlank ? 0 : c.beat, atBlank ? list.length : 0, ...beats.map(b => structuredClone(b)));
  return data;
}

// ---- song settings ----
export function setTempo(score: Score, bpm: number): void {
  if (!(bpm >= 20 && bpm <= 400)) throw new Error('速度必須在 20–400 之間');
  const first = score.masterBars[0];
  const existing = first.tempoAutomations.find(a => a.type === AutomationType.Tempo && a.ratioPosition === 0);
  if (existing) existing.value = bpm;
  else first.tempoAutomations.unshift(Automation.buildTempoAutomation(false, 0, bpm, 2));
}
/** Key signature as sharps (+) / flats (−), from this bar until the next key change, in every track. */
export function setKeySignature(score: Score, fromBar: number, key: number, minor: boolean): void {
  if (!(key >= -7 && key <= 7)) throw new Error('不支援的調號');
  const ref = score.tracks[0].staves[0].bars[fromBar];
  const oldKey = ref.keySignature, oldType = ref.keySignatureType;
  for (let i = fromBar; i < score.masterBars.length; i++) {
    const here = score.tracks[0].staves[0].bars[i];
    if (i > fromBar && (here.keySignature !== oldKey || here.keySignatureType !== oldType)) break;
    for (const track of score.tracks) for (const staff of track.staves) {
      staff.bars[i].keySignature = key as alphaTab.model.KeySignature;
      staff.bars[i].keySignatureType = (minor ? 1 : 0) as alphaTab.model.KeySignatureType;
    }
  }
}
/** Time signature from this bar until the next time-signature change. Untouched (blank) bars are refilled with rests. */
export function setTimeSignature(score: Score, fromBar: number, numerator: number, denominator: number): void {
  if (!(numerator >= 1 && numerator <= 32) || ![1, 2, 4, 8, 16, 32].includes(denominator)) throw new Error('不支援的拍號');
  const oldN = score.masterBars[fromBar].timeSignatureNumerator, oldD = score.masterBars[fromBar].timeSignatureDenominator;
  const ticks = numerator * 3840 / denominator;
  for (let i = fromBar; i < score.masterBars.length; i++) {
    const mb = score.masterBars[i];
    if (i > fromBar && (mb.timeSignatureNumerator !== oldN || mb.timeSignatureDenominator !== oldD)) break;
    mb.timeSignatureNumerator = numerator; mb.timeSignatureDenominator = denominator; mb.timeSignatureCommon = false;
    for (const track of score.tracks) for (const staff of track.staves) {
      const bar = staff.bars[i];
      if (bar.voices.every(v => v.beats.every(b => b.isRest || b.isEmpty))) fillWithRests(bar, ticks);
    }
  }
}

// ---- text and chord names above a beat ----
export function setBeatText(score: Score, c: Cursor, text: string): void {
  beatOf(score, c).text = text.trim() || null;
}
export function chordNameAt(score: Score, c: Cursor): string {
  const beat = beatOf(score, c);
  return (beat?.chordId && staffOf(score, c).chords?.get(beat.chordId)?.name) || '';
}
/** Put a chord name (e.g. "Am7") above the beat. Name only: no fingering diagram is generated. */
export function setChordName(score: Score, c: Cursor, name: string): void {
  const beat = beatOf(score, c), staff = staffOf(score, c);
  const clean = name.trim();
  if (!clean) { beat.chordId = null; return; }
  for (const [id, chord] of staff.chords ?? []) if (chord.name === clean && !chord.showDiagram) { beat.chordId = id; return; }
  const chord = new ChordCls();
  chord.name = clean; chord.showName = true; chord.showDiagram = false; chord.showFingering = false;
  let id = `gs-${clean}`;
  while (staff.chords?.has(id)) id += '_';
  staff.addChord(id, chord);
  beat.chordId = id;
}

// ---- tracks ----
export type TrackKind = 'guitar' | 'bass';
const TRACK_PRESETS: Record<TrackKind, { name: string; tuning: number[]; program: number; clef: number }> = {
  guitar: { name: '吉他', tuning: [64, 59, 55, 50, 45, 40], program: 27, clef: Clef.G2 },
  bass: { name: '貝斯', tuning: [43, 38, 33, 28], program: 33, clef: Clef.F4 }
};
/** Append a string-instrument track with blank bars matching the song. Returns its index. */
export function addTrack(score: Score, kind: TrackKind): number {
  const preset = TRACK_PRESETS[kind];
  const used = new Set(score.tracks.flatMap(t => [t.playbackInfo.primaryChannel, t.playbackInfo.secondaryChannel]));
  const free = Array.from({ length: 16 }, (_, i) => i).filter(i => i !== 9 && !used.has(i));
  const track = new TrackCls();
  track.name = `${preset.name} ${score.tracks.length + 1}`; track.shortName = preset.name;
  track.playbackInfo.program = preset.program;
  track.playbackInfo.primaryChannel = free[0] ?? 0;
  track.playbackInfo.secondaryChannel = free[1] ?? free[0] ?? 1;
  const staff = new StaffCls();
  staff.stringTuning = new Tuning('', preset.tuning, false);
  const like = score.tracks.map(t => t.staves[0]).find(st => st.tuning.length > 0);
  staff.showTablature = like?.showTablature ?? true;
  staff.showStandardNotation = like?.showStandardNotation ?? false;
  staff.showNumbered = like?.showNumbered ?? false;
  const keyRef = score.tracks[0]?.staves[0];
  score.masterBars.forEach((mb, i) => {
    const bar = new BarCls();
    bar.clef = preset.clef as alphaTab.model.Clef;
    if (keyRef) { bar.keySignature = keyRef.bars[i].keySignature; bar.keySignatureType = keyRef.bars[i].keySignatureType; }
    bar.voices.push(new VoiceCls());
    fillWithRests(bar, mb.calculateDuration(false));
    staff.bars.push(bar);
  });
  track.staves.push(staff);
  score.tracks.push(track);
  return score.tracks.length - 1;
}
export function deleteTrack(score: Score, index: number): void {
  if (score.tracks.length <= 1) throw new Error('至少要保留一個軌道');
  score.tracks.splice(index, 1);
}
export function setProgram(score: Score, track: number, program: number): void {
  if (!(program >= 0 && program <= 127)) throw new Error('不支援的樂器');
  const t = score.tracks[track];
  const old = t.playbackInfo.program;
  t.playbackInfo.program = program;
  // Files usually also carry an "instrument change" on the first beat, which the player applies right after
  // the track's own program and so would undo the change. Every change to the old sound becomes the new one;
  // switches to other sounds later in the song are kept.
  for (const staff of t.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats)
    for (const a of beat.automations) if (a.type === AutomationType.Instrument && a.value === old) a.value = program;
}
/** Track volume on Guitar Pro's 0–16 scale. */
export function setTrackVolume(score: Score, track: number, volume: number): void {
  score.tracks[track].playbackInfo.volume = Math.min(16, Math.max(0, Math.round(volume)));
}

// ---- undo / redo ----
export interface HistoryEntry { data: Snapshot; cursor: Cursor }
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private limit: number;
  constructor(limit = 200) { this.limit = limit; }
  record(before: HistoryEntry): void {
    this.undoStack.push(before);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  /** Drop the most recent undo step (used to merge two-digit fret typing into one step). */
  dropLast(): void { this.undoStack.pop(); }
  undo(current: HistoryEntry): HistoryEntry | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(current);
    return prev;
  }
  redo(current: HistoryEntry): HistoryEntry | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(current);
    return next;
  }
  clear(): void { this.undoStack = []; this.redoStack = []; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}
