import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch } from '../src/transcriber.js';
import { midiToAlphaTex } from '../src/midi-import.js';
test('clean A440 produces A4', () => {
  const sr = 44100, n=8192;const b=new Float32Array(n);
  for(let i=0;i<n;i++) b[i]=0.28*Math.sin(2*Math.PI*440*i/sr);
  const result=detectPitch(b,sr);
  assert.equal(result?.pitch,69);
});
test('near silence does not create notes', () => {
  assert.equal(detectPitch(new Float32Array(8192), 44100), null);
});
test('basic MIDI Type 0 turns note events into alphaTex', () => {
  const bytes=new Uint8Array([
    0x4d,0x54,0x68,0x64,0,0,0,6, 0,0, 0,1, 0,96,
    0x4d,0x54,0x72,0x6b,0,0,0,12,
    0,0x90,69,100, 0x60,0x80,69,0, 0,0xff,0x2f,0
  ]);
  const result=midiToAlphaTex(bytes);
  assert.equal(result.droppedChordNotes,0);
  assert.match(result.tex,/\\title "Imported MIDI"/);
});
