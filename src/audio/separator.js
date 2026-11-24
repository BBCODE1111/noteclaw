// Talks to the optional guitar separator running on this Mac (separator/server.py, started with
// separator/啟動吉他分離器.command). It splits a recording with Demucs so the notes can be heard from the guitar
// alone; beats and bar lines still come from the full mix, which keeps the drums and bass.
export const SEPARATOR_URL = 'http://127.0.0.1:47391';
export const SEPARATOR_RATE = 44100;

/** The separator's status, or null when it is not running (or this browser may not reach it). */
export async function separatorStatus({ timeout = 1500, fetchImpl = globalThis.fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchImpl(`${SEPARATOR_URL}/status`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data : null;
  } catch {
    return null;
  } finally { clearTimeout(timer); }
}

/** Interleave channels into one float32 buffer (what the separator expects). */
export function interleave(channels) {
  const n = channels[0].length, c = channels.length, out = new Float32Array(n * c);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) out[i * c + k] = channels[k][i];
  return out;
}

/**
 * Separate the guitar from `channels` (one or two Float32Arrays at `rate`). Resolves to a mono Float32Array
 * at the same rate.
 */
export async function separateGuitar(channels, rate, { fetchImpl = globalThis.fetch } = {}) {
  const body = interleave(channels);
  let res;
  try {
    res = await fetchImpl(`${SEPARATOR_URL}/separate?rate=${rate}&channels=${channels.length}&stems=guitar`, {
      method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }
    });
  } catch {
    throw new Error('連不上吉他分離器，請確認它的視窗還開著。');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(`吉他分離失敗：${msg}`);
  }
  const buf = await res.arrayBuffer();
  return new Float32Array(buf.slice(0, Number(res.headers.get('X-Length') || buf.byteLength / 4) * 4));
}
