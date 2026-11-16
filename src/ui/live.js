// "Play → tab" page: record from the interface, show what was measured and what was guessed, write the score.
import * as alphaTab from '@coderline/alphatab';
import { GuitarRecorder, encodeWav } from '../audio/recorder.js';
import { transcribe } from '../audio/analysis.js';
import { synth } from '../audio/synth.js';
import { midiName, notesToAlphaTex, optimizeFingering, OPEN_STRINGS, BASS_STRINGS } from '../fingering.js';
import { polyToAlphaTex, groupChords, fingerChords } from '../poly-score.js';

const BEND = { 2: '半音', 3: '3/4 音', 4: '全音', 5: '1¼ 音', 6: '一個半音', 7: '1¾ 音', 8: '兩個全音' };

export function initLive({ $, toast, setStatus, hasScore, onTex, download }) {
  let recording = false, listening = false, lastNotes = [], lastOrigin, lastTake = null;
  // A small second score that grows while the player plays. It only displays; nothing is written to the
  // real score until the take is finished (or captured).
  let preview = null, previewBusy = false, previewPending = null;
  function showPreview(notes, origin) {
    if (isPoly() || !notes.length) return;
    if (!preview) preview = new alphaTab.AlphaTabApi($('livePreview'), {
      core: { fontDirectory: `${import.meta.env.BASE_URL}font/`, enableLazyLoading: false }, player: { enablePlayer: false },
      display: { scale: 0.8 }, notation: { rhythmMode: alphaTab.TabRhythmMode.ShowWithBars, rhythmHeight: 18 }
    });
    let tex;
    try { tex = notesToAlphaTex(notes, { bpm: Number($('transcribeBpm').value) || 110, subdivision: Number($('quantization').value), ...fingeringOptions(), origin, ...names() }); } catch { return; }
    // Render one at a time; if new notes arrive meanwhile, draw only the latest.
    if (previewBusy) { previewPending = tex; return; }
    previewBusy = true;
    preview.tex(tex);
  }
  const previewDone = () => {
    previewBusy = false;
    if (previewPending) { const t = previewPending; previewPending = null; previewBusy = true; preview.tex(t); }
    const sheet = $('livePreview').parentElement; sheet.scrollTop = sheet.scrollHeight;
  };
  let lastPoly = false;
  const instrument = () => $('recInstrument').value;
  const isBass = () => instrument() === 'bass', isPiano = () => instrument() === 'piano';
  const isPoly = () => $('recMode').value === 'poly';
  const tuning = () => (isBass() ? BASS_STRINGS : OPEN_STRINGS);
  const names = () => ({ title: isPiano() ? 'Recorded Piano' : isBass() ? 'Recorded Bass' : 'Recorded Guitar', trackName: isPiano() ? 'Piano' : isBass() ? 'Bass' : 'Guitar' });
  const modelUrl = `${import.meta.env.BASE_URL}basic-pitch/model.json`;
  /** Run the polyphonic model (loaded on first use) and report progress in the counter line. */
  async function polyNotes(samples, sampleRate) {
    const { transcribePoly } = await import('../audio/poly.js');
    const range = isBass() ? { lowest: 23, highest: 72 } : isPiano() ? {} : { lowest: 38, highest: 90 };
    return transcribePoly(samples, sampleRate, { model: modelUrl, ...range, onProgress: f => { $('recordCounter').textContent = `多音分析中… ${Math.round(f * 100)}%`; } });
  }
  const fingeringOptions = () => {
    const bias = $('fretBias').value;
    const base = { tuning: tuning() };
    return bias === 'position'
      ? { ...base, bias, minFret: Number($('minFret').value), maxFret: Math.max(Number($('maxFretPos').value), Number($('minFret').value) + 3) }
      : { ...base, bias, maxFret: Number($('maxFret').value) };
  };
  $('recInstrument').onchange = () => { if (lastNotes.length) renderNotes(lastNotes, lastPoly); };
  $('recMode').onchange = () => { $('pitchDetail').textContent = isPoly() ? '多音模式：錄完才分析，即時音高只供參考' : '按「開始錄製」後顯示'; };
  $('fretBias').onchange = () => { $('positionRange').hidden = $('fretBias').value !== 'position'; if (lastNotes.length) renderNotes(lastNotes, lastPoly); };

  function renderNotes(notes, poly = false) {
    lastNotes = notes; lastPoly = poly;
    const el = $('liveEvents'); el.replaceChildren();
    if (!notes.length) { el.textContent = recording ? '正在聽…還沒有穩定的音符。' : '尚無音符。'; return; }
    const row = (cls, cells) => { const r = document.createElement('div'); r.className = 'event ' + cls; cells.forEach(([text, c]) => { const s = document.createElement('span'); s.textContent = text; if (c) s.className = c; r.append(s); }); return r; };
    if (poly) {
      // Polyphonic: one line per chord.
      const chords = groupChords(notes, { origin: lastOrigin, unit: 60 / (Number($('transcribeBpm').value) || 110) / 4 });
      const fingered = isPiano() ? null : fingerChords(chords, { tuning: tuning(), maxFret: Number($('maxFret').value) });
      el.append(row('head', [['時間'], ['幾個音'], ['音高 實測'], [isPiano() ? '' : '指型 推測']]));
      chords.slice(-40).forEach((c, k) => {
        const shape = fingered?.shapes[chords.length - Math.min(40, chords.length) + k];
        const shapeText = isPiano() ? '' : shape ? shape.map(n => `${tuning().length + 1 - n.string}弦${n.fret}`).join(' ') + (shape.length < c.pitches.length ? `（省略 ${c.pitches.length - shape.length} 個音）` : '') : '這個樂器彈不出來';
        el.append(row('', [[`${c.start.toFixed(2)}s`], [String(c.pitches.length)], [c.pitches.map(midiName).join(' '), 'measured'], [shapeText, shape && shape.length === c.pitches.length ? 'guess' : 'tech']]));
      });
      el.scrollTop = el.scrollHeight;
      return;
    }
    let positions = [];
    try { positions = optimizeFingering(notes.map(n => n.pitch), { ...fingeringOptions(), hints: notes }); } catch { /* out of range: shown without a position */ }
    el.append(row('head', [['時間'], ['音高 實測'], ['指法 推測'], ['技巧 推測']]));
    notes.slice(-40).forEach((n, k) => {
      const p = positions[notes.length - Math.min(40, notes.length) + k];
      const tech = [n.legato && '連音', n.bend && `推弦 ${BEND[n.bend] ?? ''}${n.bendRelease ? '後放回' : ''}`, n.vibrato && '揉弦'].filter(Boolean).join('、');
      el.append(row('', [[`${n.start.toFixed(2)}s`], [midiName(n.pitch), 'measured'],
        [isPiano() ? '五線譜' : p ? `第 ${tuning().length + 1 - p.string} 弦 ${p.fret} 格` : '超出音域', 'guess'], [tech || '—', tech ? 'tech' : 'guess']]));
    });
    el.scrollTop = el.scrollHeight;
  }

  const recorder = new GuitarRecorder({
    onFrame: f => {
      $('pitchText').textContent = f.m === null ? '—' : midiName(Math.round(f.m));
      $('pitchDetail').textContent = f.m === null ? '等待音符…' : `${f.hz.toFixed(1)} Hz · ${((f.m - Math.round(f.m)) * 100).toFixed(0)} cents · 清晰度 ${(f.clarity * 100).toFixed(0)}%`;
    },
    onLevels: (peaks, active) => {
      $('meterBar').firstElementChild.style.width = `${Math.min(100, peaks[active] * 140)}%`;
      const box = $('channelMeters');
      if (box.children.length !== peaks.length) {
        box.replaceChildren(...peaks.map((_, i) => { const d = document.createElement('div'); d.className = 'ch'; d.innerHTML = '<i><b></b></i>'; d.append(String(i + 1)); return d; }));
        const sel = $('channelSelect'), keep = sel.value;
        sel.replaceChildren(new Option('自動（訊號最大的聲道）', 'auto'), ...peaks.map((_, i) => new Option(`輸入 ${i + 1}`, i)));
        sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'auto';
      }
      peaks.forEach((p, i) => { box.children[i].classList.toggle('active', i === active); box.children[i].querySelector('b').style.height = `${Math.min(100, p * 140)}%`; });
    },
    onNotes: (notes, origin) => {
      if (isPoly()) { $('recordCounter').textContent = `${listening ? '聆聽中' : '錄音中'} · 多音模式在按下後才分析`; return; }
      $('recordCounter').textContent = listening ? `聆聽中 · 最近聽到 ${notes.length} 個音符` : `錄音中 · 已聽到 ${notes.length} 個音符`;
      renderNotes(listening ? notes.slice(-40) : notes);
      // While listening there is no beat one: the preview just shows the most recent phrase.
      showPreview(listening ? notes.slice(-24) : notes, listening ? undefined : origin);
    }
  });
  // Hook the preview's render event once it exists.
  const hookPreview = setInterval(() => { if (preview) { preview.postRenderFinished.on(previewDone); clearInterval(hookPreview); } }, 200);
  $('channelSelect').onchange = () => recorder.setChannel($('channelSelect').value === 'auto' ? 'auto' : Number($('channelSelect').value));

  async function fillDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const input = $('deviceSelect'), current = input.value;
      input.replaceChildren(new Option('系統預設輸入', ''), ...list.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default').map(d => new Option(d.label || '音訊輸入裝置', d.deviceId)));
      input.value = current;
    } catch (e) { console.warn(e); }
  }

  // Always listening: no count-in, no metronome, the last few minutes kept. "Write down what I just played" takes
  // the chosen stretch and turns it into a score, without stopping.
  $('listenBtn').onclick = async () => {
    if (recording) return;
    if (listening) {
      listening = false; await recorder.stop();
      $('listenBtn').classList.remove('active'); $('listenBtn').textContent = '◎ 開始聆聽'; $('captureBtn').disabled = true; $('recordBtn').disabled = false;
      $('recordCounter').textContent = '已停止聆聽'; setStatus('可播放 / 可編輯');
      return;
    }
    try {
      const channel = $('channelSelect').value === 'auto' ? 'auto' : Number($('channelSelect').value);
      const info = await recorder.start({ deviceId: $('deviceSelect').value, channel, countIn: false, metronome: false, range: isBass() ? 'bass' : 'guitar', keepSeconds: 180 });
      listening = true; lastNotes = [];
      $('listenBtn').classList.add('active'); $('listenBtn').textContent = '◉ 聆聽中（再按停止）'; $('captureBtn').disabled = false; $('recordBtn').disabled = true;
      $('recordCounter').textContent = `聆聽中 · ${info.channels} 個輸入聲道 · 保留最近 3 分鐘`;
      setStatus('聆聽中');
      await fillDevices();
    } catch (e) { toast(`無法開啟音訊輸入：${e.message}。請確認已允許使用麥克風／音效卡。`); }
  };
  $('captureBtn').onclick = async () => {
    const seconds = Number($('captureSeconds').value);
    const take = recorder.snapshot(seconds);
    if (!take) return;
    lastTake = take; $('saveTakeBtn').disabled = false;
    await run(take.samples, take.sampleRate, { origin: undefined, label: `記下最近 ${seconds} 秒`, tail: ' · 以第一個音當第一拍，速度用左邊設定的 BPM' });
  };

  $('recordBtn').onclick = async () => {
    if (recording || listening) return;
    try {
      const channel = $('channelSelect').value === 'auto' ? 'auto' : Number($('channelSelect').value);
      const info = await recorder.start({ deviceId: $('deviceSelect').value, channel, bpm: Number($('transcribeBpm').value) || 110,
        countIn: $('recCountIn').checked, metronome: $('recMetronome').checked, latencyMs: Number($('recLatency').value) || 0, range: isBass() ? 'bass' : 'guitar' });
      recording = true; lastNotes = [];
      $('recordBtn').classList.add('active'); $('recordBtn').textContent = '● 錄音中'; $('recordBtn').disabled = true; $('stopRecordBtn').disabled = false;
      $('recordCounter').textContent = `${info.channels} 個輸入聲道 · ${info.sampleRate} Hz${$('recCountIn').checked ? ' · 先數一小節' : ''}`;
      setStatus('正在錄音');
      await fillDevices();
    } catch (e) { toast(`無法開啟音訊輸入：${e.message}。請確認已允許使用麥克風／音效卡。`); }
  };
  $('stopRecordBtn').onclick = async () => {
    if (!recording) return;
    recording = false;
    $('stopRecordBtn').disabled = true; $('recordBtn').disabled = false; $('recordBtn').classList.remove('active'); $('recordBtn').textContent = '● 開始錄製';
    const result = await recorder.stop();
    setStatus('錄音結束');
    if (!result) return;
    lastTake = result; $('saveTakeBtn').disabled = false;
    const how = { click: `用錄到的節拍器聲校正（延遲 ${result.alignment.ms} ms）`, fit: `依你的彈奏自動貼齊格線（${result.alignment.ms} ms）`, estimate: `用系統回報的延遲（${result.alignment.ms} ms）`, none: '沒有節拍器，以第一個音當第一拍' }[result.alignment.method];
    await run(result.samples, result.sampleRate, { monoNotes: result.notes, origin: result.origin, label: `錄了 ${result.seconds.toFixed(1)} 秒 · 輸入 ${result.channel + 1}`, tail: ` · 對拍：${how}` });
  };

  /** Analyse audio in the chosen mode and write the score. */
  async function run(samples, sampleRate, { monoNotes, origin, label, tail = '' }) {
    try {
      const poly = isPoly();
      const notes = poly ? await polyNotes(samples, sampleRate) : monoNotes ?? transcribe(samples, sampleRate, { range: isBass() ? 'bass' : 'guitar' });
      if (!notes.length) { $('recordCounter').textContent = `${label} · 沒有辨識到音符`; return toast('沒有辨識到音符。請確認輸入聲道有訊號（看聲道音量條），或換另一種辨識模式。'); }
      $('recordCounter').textContent = `${label} · ${notes.length} 個音符${tail}`;
      finish(notes, origin, poly);
    } catch (e) { console.error(e); $('recordCounter').textContent = `${label} · 分析失敗`; toast(`分析失敗：${e.message}`); }
  }
  // An existing recording (a bounced DAW track, a phone memo…) goes through the same analysis.
  $('importAudioBtn').onclick = () => $('audioFileInput').click();
  $('audioFileInput').onchange = async e => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    $('recordCounter').textContent = `讀取 ${file.name}…`;
    try {
      const context = new AudioContext();
      const audio = await context.decodeAudioData(await file.arrayBuffer());
      await context.close();
      const samples = new Float32Array(audio.length);
      for (let c = 0; c < audio.numberOfChannels; c++) { const d = audio.getChannelData(c); for (let i = 0; i < d.length; i++) samples[i] += d[i] / audio.numberOfChannels; }
      lastTake = { samples, sampleRate: audio.sampleRate }; $('saveTakeBtn').disabled = false;
      if (!isPoly()) $('recordCounter').textContent = `分析 ${file.name}…`;
      await new Promise(r => setTimeout(r, 30)); // let the message paint before the analysis blocks the page
      await run(samples, audio.sampleRate, { origin: undefined, label: `${file.name} · ${audio.duration.toFixed(1)} 秒`, tail: ' · 以第一個音當第一拍' });
    } catch (err) { console.error(err); $('recordCounter').textContent = '讀取失敗'; toast(`無法讀取這個音訊檔：${err.message}`); }
  };
  // Keeping the raw take lets a wrong transcription be examined and the detector tuned against real playing.
  $('saveTakeBtn').onclick = () => {
    if (!lastTake) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download(encodeWav(lastTake.samples, lastTake.sampleRate), `guitar-take-${stamp}-${$('transcribeBpm').value}bpm.wav`, 'audio/wav');
  };

  function finish(notes, origin, poly = false) {
    lastOrigin = origin;
    renderNotes(notes, poly);
    try {
      const common = { bpm: Number($('transcribeBpm').value), subdivision: Number($('quantization').value), origin, ...names() };
      let tex, note = '';
      if (poly || isPiano()) {
        const out = polyToAlphaTex(notes, { ...common, staff: isPiano() ? 'score' : 'tab', tuning: tuning(), maxFret: Number($('maxFret').value) });
        tex = out.tex;
        // Say what could not be written as played instead of dropping it quietly.
        if (out.simplified) note += `有 ${out.simplified} 個和弦在這個樂器上按不出來，省略了中間 ${out.dropped} 個音。`;
        if (out.unplayable) note += `有 ${out.unplayable} 個和弦完全超出音域，寫成了休止符。`;
      } else tex = notesToAlphaTex(notes, { ...common, ...fingeringOptions() });
      if (hasScore() && !confirm(`辨識到 ${notes.length} 個音符。產生的譜會取代目前的譜面，要繼續嗎？`)) return;
      onTex(tex, notes, note);
    } catch (e) { toast(e.message); }
  }

  // Demo: a synthesized phrase (picked notes, a repeated note, hammer-on / pull-off, a bend, vibrato)
  // goes through exactly the same analysis as a real recording.
  $('transcriptionDemoBtn').onclick = () => {
    const bpm = Number($('transcribeBpm').value) || 110, b = 60 / bpm;
    if (isPoly()) {
      // Four voices mixed together: Em, C, G, D chords, then a two-note figure.
      const prog = [[40, 47, 52, 55], [48, 52, 55, 60], [43, 50, 55, 59], [50, 57, 62, 66]];
      const voices = [0, 1, 2, 3].map(v => synth([...prog.map((c, i) => ({ at: 0.05 + i * b * 2, dur: b * 1.9, midi: c[v] })),
        ...(v < 2 ? [{ at: 0.05 + b * 8, dur: b * 1.9, midi: v ? 64 : 57 }] : [])], { sampleRate: 22050 }).samples);
      const mix = new Float32Array(Math.max(...voices.map(v => v.length)));
      for (const v of voices) for (let i = 0; i < v.length; i++) mix[i] += v[i] * 0.3;
      run(mix, 22050, { origin: 0.05, label: '合成和弦測試（Em、C、G、D、雙音）' });
      return;
    }
    const phrase = [
      { at: 0, dur: b / 2, midi: 57 }, { at: b / 2, dur: b / 2, midi: 60 }, { at: b, dur: b / 2, midi: 62 }, { at: b * 1.5, dur: b / 2, midi: 62 },
      { at: b * 2, dur: b / 2, midi: 64 }, { at: b * 2.5, dur: b / 2, midi: 67, pick: false }, { at: b * 3, dur: b / 2, midi: 64, pick: false }, { at: b * 3.5, dur: b / 2, midi: 62 },
      { at: b * 4, dur: b * 2, midi: t => 62 + 2 * Math.min(1, Math.max(0, (t - 0.06) / 0.14)) },
      { at: b * 6, dur: b * 2, midi: t => 64 + (t > 0.25 ? 0.3 * Math.sin(2 * Math.PI * 5.5 * t) : 0) }
    ];
    const lead = 0.05;
    const { samples, sampleRate } = synth(phrase.map(e => ({ ...e, at: e.at + lead })));
    const notes = transcribe(samples, sampleRate);
    $('recordCounter').textContent = `合成測試 · ${notes.length} 個音符（原本寫了 ${phrase.length} 個）`;
    finish(notes, lead);
  };
  fillDevices();
  return { get notes() { return lastNotes; }, get origin() { return lastOrigin; } };
}
