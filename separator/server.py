"""NoteClaw guitar separator: a small local server that splits a recording into guitar / bass / drums / …
with Demucs (htdemucs_6s) so NoteClaw can transcribe the guitar on its own.

It listens on 127.0.0.1 only, so nothing outside this Mac can reach it, and answers only NoteClaw's own pages.

  GET  /status                       -> {"ok": true, "version": 1, "model": ..., "device": ...}
  POST /separate?rate=R&channels=C&stems=guitar,bass
       body: float32 little-endian samples, interleaved, C channels at R Hz
       reply: float32 little-endian mono tracks one after another, in the order of `stems`,
              each X-Length samples long at R Hz
"""
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np
import torch
from demucs.apply import apply_model
from demucs.audio import convert_audio
from demucs.pretrained import get_model

PORT = 47391
VERSION = 1
MODEL_NAME = 'htdemucs_6s'
MAX_SECONDS = 15 * 60
ALLOWED_ORIGINS = [
    re.compile(r'^http://(localhost|127\.0\.0\.1)(:\d+)?$'),
    re.compile(r'^https://noteclaw[\w-]*\.vercel\.app$'),
]

device = 'mps' if torch.backends.mps.is_available() else 'cpu'
print(f'載入分離模型 {MODEL_NAME}（第一次會下載約 50MB）…', flush=True)
model = get_model(MODEL_NAME)
model.eval()
lock = threading.Lock()


def separate(mix, rate, stems):
    """mix: (channels, samples) float32 at `rate`. Returns {stem: mono float32 at `rate`}."""
    wav = convert_audio(torch.from_numpy(mix), rate, model.samplerate, model.audio_channels)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((wav - mean) / std)[None], device=device, split=True, overlap=0.25, progress=False)[0]
    out = out * std + mean
    result = {}
    for name in stems:
        track = out[model.sources.index(name)]
        back = convert_audio(track, model.samplerate, rate, 1)[0]
        result[name] = back.cpu().numpy().astype('<f4')
    return result


class Handler(BaseHTTPRequestHandler):
    def _origin_ok(self):
        origin = self.headers.get('Origin')
        return origin is None or any(p.match(origin) for p in ALLOWED_ORIGINS)

    def _cors(self):
        origin = self.headers.get('Origin')
        if origin and self._origin_ok():
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Expose-Headers', 'X-Length, X-Stems, X-Rate, X-Seconds')

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self._origin_ok():
            self.send_response(403); self.end_headers(); return
        self.send_response(204)
        self._cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # Chrome asks before a public page (the online NoteClaw) may talk to this Mac.
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def do_GET(self):
        if not self._origin_ok():
            return self._json(403, {'ok': False, 'error': 'origin not allowed'})
        if urlparse(self.path).path == '/status':
            return self._json(200, {'ok': True, 'version': VERSION, 'model': MODEL_NAME, 'device': device,
                                    'stems': list(model.sources), 'busy': lock.locked()})
        self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if not self._origin_ok():
            return self._json(403, {'ok': False, 'error': 'origin not allowed'})
        url = urlparse(self.path)
        if url.path != '/separate':
            return self._json(404, {'ok': False, 'error': 'not found'})
        try:
            q = parse_qs(url.query)
            rate = int(q.get('rate', ['44100'])[0])
            channels = int(q.get('channels', ['1'])[0])
            stems = [s for s in q.get('stems', ['guitar'])[0].split(',') if s]
            if not 8000 <= rate <= 96000 or channels not in (1, 2):
                raise ValueError('bad rate or channels')
            bad = [s for s in stems if s not in model.sources]
            if bad:
                raise ValueError(f'unknown stem {bad[0]}')
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > MAX_SECONDS * rate * channels * 4:
                raise ValueError('audio missing or too long')
            data = self.rfile.read(size)
            mix = np.frombuffer(data, dtype='<f4').reshape(-1, channels).T.copy()
        except Exception as err:  # noqa: BLE001 - report any bad request back to the page
            return self._json(400, {'ok': False, 'error': str(err)})
        start = time.time()
        with lock:
            try:
                tracks = separate(mix, rate, stems)
            except Exception as err:  # noqa: BLE001
                print('分離失敗：', err, flush=True)
                return self._json(500, {'ok': False, 'error': str(err)})
        took = time.time() - start
        length = len(next(iter(tracks.values())))
        print(f'分離完成：{mix.shape[1] / rate:.0f} 秒音訊，花了 {took:.1f} 秒', flush=True)
        body = b''.join(tracks[s].tobytes() for s in stems)
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Length', str(length))
        self.send_header('X-Stems', ','.join(stems))
        self.send_header('X-Rate', str(rate))
        self.send_header('X-Seconds', f'{took:.1f}')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'NoteClaw 吉他分離器已啟動（{device}）。保持這個視窗開著，回到 NoteClaw 自動扒譜就會先分離吉他。', flush=True)
    print('要關閉：關掉這個視窗或按 Control-C。', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
