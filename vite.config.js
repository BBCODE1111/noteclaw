import { defineConfig } from 'vite';
import { alphaTab } from '@coderline/alphatab-vite';
import fs from 'node:fs';
import path from 'node:path';

/** Copy the Basic Pitch model (polyphonic transcription) into public/ so the app can load it locally. */
function basicPitchModel() {
  return {
    name: 'noteclaw-basic-pitch-model',
    buildStart() {
      const from = path.resolve('node_modules/@spotify/basic-pitch/model'), to = path.resolve('public/basic-pitch');
      if (!fs.existsSync(from)) return;
      fs.mkdirSync(to, { recursive: true });
      for (const file of fs.readdirSync(from)) fs.copyFileSync(path.join(from, file), path.join(to, file));
    }
  };
}

export default defineConfig({
  plugins: [alphaTab(), basicPitchModel()],
  build: { chunkSizeWarningLimit: 2600 },
  server: { host: '127.0.0.1' }
});
