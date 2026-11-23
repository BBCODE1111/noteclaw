// node poly.mjs in.wav out.json : run Basic Pitch on a 22050 mono wav, save raw notes
import fs from 'node:fs';
import * as tf from '@tensorflow/tfjs';
import bp from '@spotify/basic-pitch';
const [,, inp, out] = process.argv;
const buf = fs.readFileSync(inp);
// parse 16-bit PCM wav
let off = 12, data, rate;
while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
  if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
  if (id === 'data') { data = buf.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
const s = new Float32Array(data.length / 2); for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
const root = process.cwd();
const model = await tf.loadGraphModel(tf.io.fileSystem ? tf.io.fileSystem(root + '/public/basic-pitch/model.json') : {
  load: async () => { const j = JSON.parse(fs.readFileSync(root + '/public/basic-pitch/model.json'));
    const w = fs.readFileSync(root + '/public/basic-pitch/' + j.weightsManifest[0].paths[0]);
    return { modelTopology: j.modelTopology, weightSpecs: j.weightsManifest[0].weights, weightData: w.buffer.slice(w.byteOffset, w.byteOffset + w.length), format: j.format, generatedBy: j.generatedBy, convertedBy: j.convertedBy, signature: j.signature, userDefinedMetadata: j.userDefinedMetadata }; } });
const B = new bp.BasicPitch(model);
let peak = 0; for (const v of s) peak = Math.max(peak, Math.abs(v)); const g = Math.min(40, 0.8 / peak);
const frames = [], onsets = [], contours = []; const t0 = Date.now();
await B.evaluateModel(s.map(v => v * g), (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, p => {});
fs.writeFileSync(out, JSON.stringify({ rate, frames, onsets }));
console.log('done', (Date.now() - t0) / 1000, 's frames', frames.length);
