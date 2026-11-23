// Video / recording → tab, with the bar lines tied to the recording so the video can follow the score.
//
// 1. Notes come from the polyphonic model (pitches and times, measured).
// 2. Tempo and beats come from the sound itself (src/audio/beats.js), so a player who speeds up or drags
//    is followed beat by beat instead of drifting off a fixed metronome.
// 3. Note times are re-expressed in beats ("warped"), so the existing score writer can put them on a
//    steady grid, and every bar line gets the video time where that bar really starts (sync points).
import { onsetEnvelope, estimateTempo, trackBeats, findDownbeat, timeToBeat } from './beats.js';
import { polyToAlphaTex } from '../poly-score.js';
import { OPEN_STRINGS } from '../fingering.js';

/**
 * Keep what the lead guitar plays and drop what belongs to the band: notes outside the guitar's range,
 * and, among notes that start together, those far below the top note (accompaniment and bass), so a
 * melody with double stops survives but the backing chord under it does not.
 */
export function leadNotes(notes, { lowest = 40, highest = 88, span = 9, strum = 0.06 } = {}) {
  const inRange = notes.filter(n => n.pitch >= lowest && n.pitch <= highest).sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 0; i < inRange.length;) {
    let j = i; while (j < inRange.length && inRange[j].start - inRange[i].start <= strum) j++;
    const group = inRange.slice(i, j), top = Math.max(...group.map(n => n.pitch));
    out.push(...group.filter(n => top - n.pitch <= span));
    i = j;
  }
  return out;
}

/** Tempo, beat times and the first downbeat of a recording. */
export function analyseRhythm(samples, sampleRate, notes = [], { bpm, beatsPerBar = 4 } = {}) {
  const envelope = onsetEnvelope(samples, sampleRate);
  const tempo = bpm || estimateTempo(envelope.env, envelope.rate);
  const beats = trackBeats(envelope.env, envelope.rate, tempo);
  const downbeat = findDownbeat(beats, envelope, notes, beatsPerBar);
  return { bpm: tempo, beats, downbeat, beatsPerBar };
}

/** Time of beat `i` (fractional and out-of-range indexes extrapolate at the nearest beat length). */
export function beatTime(i, beats) {
  const n = beats.length;
  if (n < 2) return beats[0] ?? 0;
  if (i <= 0) return beats[0] + i * (beats[1] - beats[0]);
  if (i >= n - 1) return beats[n - 1] + (i - n + 1) * (beats[n - 1] - beats[n - 2]);
  const k = Math.floor(i);
  return beats[k] + (i - k) * (beats[k + 1] - beats[k]);
}

/**
 * Write the score. `offset` is where the analysed audio starts in the video (seconds); `bars` in the result
 * are the video times at which each written bar starts.
 * @returns {{tex:string, bars:number[], notes:number, bpm:number, dropped:number}}
 */
export function videoScore(notes, rhythm, { offset = 0, lead = true, title = 'Video', trackName = 'Guitar', tuning = OPEN_STRINGS, maxFret = 22 } = {}) {
  const { beats, beatsPerBar } = rhythm;
  const bpm = Math.round(rhythm.bpm);
  const used = lead ? leadNotes(notes) : notes.filter(n => n.pitch >= tuning[0] && n.pitch <= tuning[tuning.length - 1] + maxFret);
  if (!used.length) throw new Error('這一段沒有聽到吉他的音。');
  // Bar 1 is the bar holding the first note (a pickup gets rests before it).
  const position = t => timeToBeat(t, beats) - rhythm.downbeat;
  const firstBar = Math.floor((position(used[0].start) + 0.125) / beatsPerBar);
  const startBeat = rhythm.downbeat + firstBar * beatsPerBar;
  const beatSeconds = 60 / bpm;
  const warp = t => (timeToBeat(t, beats) - startBeat) * beatSeconds;
  const warped = used.map(n => ({ ...n, start: warp(n.start), end: Math.max(warp(n.end), warp(n.start) + 0.02) }));
  const out = polyToAlphaTex(warped, { bpm, origin: 0, staff: 'tab', tuning, maxFret, title, trackName, timeSignature: beatsPerBar, lead });
  const barCount = (out.tex.match(/\|/g) ?? []).length + 1;
  const bars = Array.from({ length: barCount }, (_, k) => offset + beatTime(startBeat + k * beatsPerBar, beats));
  return { tex: out.tex, bars, notes: used.length, bpm, dropped: out.dropped };
}
