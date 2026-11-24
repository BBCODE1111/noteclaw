import test from 'node:test';
import assert from 'node:assert/strict';
import { separatorStatus, separateGuitar, interleave, SEPARATOR_URL } from '../src/audio/separator.js';

const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => data, headers: new Map() });

test('separator status: running, not running, or answering something else', async () => {
  assert.equal((await separatorStatus({ fetchImpl: async () => json({ ok: true, device: 'mps' }) })).device, 'mps');
  assert.equal(await separatorStatus({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), null);
  assert.equal(await separatorStatus({ fetchImpl: async () => json({ ok: false }) }), null);
  assert.equal(await separatorStatus({ fetchImpl: async () => json({}, 404) }), null);
});

test('separator status gives up quickly when nothing answers', async () => {
  const t0 = Date.now();
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal(await separatorStatus({ timeout: 50, fetchImpl: hang }), null);
  assert.ok(Date.now() - t0 < 1000);
});

test('stereo is interleaved for the separator', () => {
  assert.deepEqual([...interleave([Float32Array.of(1, 2, 3), Float32Array.of(-1, -2, -3)])], [1, -1, 2, -2, 3, -3]);
});

test('separateGuitar sends the audio and reads back the guitar track', async () => {
  let sent;
  const out = Float32Array.of(0.5, -0.25);
  const fetchImpl = async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, headers: new Map([['X-Length', '2']]), arrayBuffer: async () => out.buffer.slice(0) };
  };
  const guitar = await separateGuitar([Float32Array.of(1, 2), Float32Array.of(3, 4)], 44100, { fetchImpl });
  assert.equal(sent.url, `${SEPARATOR_URL}/separate?rate=44100&channels=2&stems=guitar`);
  assert.deepEqual([...sent.init.body], [1, 3, 2, 4]);
  assert.deepEqual([...guitar], [0.5, -0.25]);
});

test('separateGuitar explains failures in plain words', async () => {
  await assert.rejects(separateGuitar([Float32Array.of(0)], 44100, { fetchImpl: async () => { throw new TypeError('x'); } }), /視窗還開著/);
  await assert.rejects(separateGuitar([Float32Array.of(0)], 44100, { fetchImpl: async () => json({ ok: false, error: 'audio missing' }, 400) }), /audio missing/);
});
