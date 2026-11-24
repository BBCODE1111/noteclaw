// Live MIDI (a keyboard, a MIDI guitar pickup, an e-drum…) → score. MIDI already says exactly which note
// was played and when, so only the rhythm has to be worked out: tempo, beats and bar lines come from the
// note starts with the same beat tracker the audio path uses, then the score is written the same way.
import { estimateTempo, trackBeats, findDownbeat, beatsTempo } from './beats.js';
import { videoScore } from './video-tab.js';

export const MIDI_RATE = 100; // envelope frames per second

/**
 * Turn raw MIDI messages into notes. `events` are {time (ms), data: [status, d1, d2]}.
 * Note-on with velocity 0 counts as note-off; notes still held at the end last until `endTime`.
 * Sustain pedal (CC 64) holds released notes until the pedal is lifted.
 */
export function midiToNotes(events, endTime) {
  const open = new Map(), notes = [];
  let pedal = false; const held = [];
  const close = (n, t) => { n.end = Math.max(t, n.start + 0.03); notes.push(n); };
  for (const { time, data } of events) {
    const [status, a, b] = data, kind = status & 0xf0, ch = status & 0x0f, t = time / 1000;
    if (kind === 0x90 && b > 0) {
      const key = `${ch}:${a}`;
      if (open.has(key)) close(open.get(key), t);
      open.set(key, { pitch: a, start: t, end: t, velocity: b, level: b / 127, channel: ch });
    } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
      const key = `${ch}:${a}`, n = open.get(key);
      if (!n) continue;
      open.delete(key);
      if (pedal) held.push(n); else close(n, t);
    } else if (kind === 0xb0 && a === 64) {
      pedal = b >= 64;
      if (!pedal) { for (const n of held.splice(0)) close(n, t); }
    }
  }
  const end = (endTime ?? Math.max(0, ...events.map(e => e.time))) / 1000;
  for (const n of [...open.values(), ...held]) close(n, end);
  return notes.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
}

/** Onset envelope from note starts: louder notes count more; notes below E3 also feed the bass band. */
export function noteEnvelope(notes, seconds) {
  const n = Math.ceil((seconds + 1) * MIDI_RATE), env = new Float32Array(n), low = new Float32Array(n);
  for (const note of notes) {
    const i = Math.round(note.start * MIDI_RATE);
    for (let k = -2; k <= 2; k++) {
      if (i + k < 0 || i + k >= n) continue;
      const w = Math.exp(-0.5 * k * k) * (0.4 + 0.6 * (note.level ?? 0.8));
      env[i + k] += w; if (note.pitch < 52) low[i + k] += w;
    }
  }
  return { env, low, rate: MIDI_RATE };
}

/**
 * Tempo, beats and first downbeat from MIDI notes. With `bpm` the tempo is taken as given (playing to a
 * metronome) and only the beats are placed.
 */
export function midiRhythm(notes, { bpm, beatsPerBar = 4 } = {}) {
  if (!notes.length) throw new Error('沒有收到 MIDI 音符。');
  const seconds = notes[notes.length - 1].end;
  const envelope = noteEnvelope(notes, seconds);
  const tempo = bpm || estimateTempo(envelope.env, envelope.rate);
  const beats = trackBeats(envelope.env, envelope.rate, tempo);
  const downbeat = findDownbeat(beats, envelope, notes, beatsPerBar);
  return { bpm: bpm || beatsTempo(beats, tempo), beats, downbeat, beatsPerBar };
}

/** Score from a MIDI take: guitar / bass as tab (every note kept, fingered), anything else as notation. */
export function midiScore(notes, { bpm, staff = 'tab', tuning, title = 'MIDI', trackName = 'Guitar', maxFret = 22 } = {}) {
  const rhythm = midiRhythm(notes, { bpm });
  const out = videoScore(notes, rhythm, { lead: false, staff, tuning, title, trackName, maxFret });
  return { ...out, rhythm };
}
