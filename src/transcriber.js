// Kept for compatibility: the analysis now lives in src/audio/.
import { midiName } from './fingering.js';
import { detectPitchHz } from './audio/analysis.js';
export { GuitarRecorder } from './audio/recorder.js';

/** Pitch of one buffer as the nearest note, or null for silence / unpitched sound. */
export function detectPitch(buffer, sampleRate) {
  const window = buffer.length > 2048 ? buffer.subarray(buffer.length - 2048) : buffer;
  const r = detectPitchHz(window, sampleRate);
  if (!r.hz) return null;
  const exact = 69 + 12 * Math.log2(r.hz / 440), pitch = Math.round(exact);
  return { pitch, name: midiName(pitch), hz: r.hz, cents: (exact - pitch) * 100, rms: r.rms, clarity: r.clarity };
}
