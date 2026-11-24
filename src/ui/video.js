// Video (or audio) playing along with the score.
//
// With a video attached alphaTab runs in "external media" mode: the video is the clock and the score cursor
// follows it, so sound comes from the video and the speed slider slows the video down.
// Alignment uses alphaTab's sync points: "bar N starts at video time T". They live in the score model
// (MasterBar.syncPoints), so they are undoable and saved in the project file. Between two points the score
// is stretched to fit; after the last one it keeps the last stretch.
import * as alphaTab from '@coderline/alphatab';
import { analyseRhythm, videoScore } from '../audio/video-tab.js';
import { timeToBeat } from '../audio/beats.js';

const AUTO = 'noteclaw-auto'; // marks the bar-1 point added automatically when the user's first point is later
const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i;
export const isMediaFile = file => /^(video|audio)\//.test(file.type) || MEDIA_EXT.test(file.name);

/**
 * Bars in the order they are played (repeats and jumps unrolled), with the time each starts at the
 * written tempo. Found by putting a dummy sync point on every bar and pass and letting alphaTab walk the song.
 */
export function playOrder(score, settings) {
  const { JsonConverter } = alphaTab.model;
  const copy = JsonConverter.jsObjectToScore(JsonConverter.scoreToJsObject(score), settings);
  const dummy = [];
  for (const mb of copy.masterBars) for (let occ = 0; occ < 8; occ++) dummy.push({ barIndex: mb.index, barOccurence: occ, barPosition: 0, millisecondOffset: 0 });
  copy.applyFlatSyncPoints(dummy);
  const seen = new Set(), out = [];
  for (const p of alphaTab.midi.MidiFileGenerator.generateSyncPoints(copy, false)) {
    const key = `${p.masterBarIndex}:${p.masterBarOccurence}`;
    if (seen.has(key) || p.masterBarOccurence < 0) continue; // the closing "end of song" point
    seen.add(key); out.push({ bar: p.masterBarIndex, occ: p.masterBarOccurence, synthMs: p.synthTime });
  }
  return out;
}

/** The user's alignment points (bar starts only), without the automatic bar-1 point. */
export function readPoints(score) {
  const out = [];
  for (const mb of score.masterBars) for (const a of mb.syncPoints ?? []) {
    if (a.text === AUTO) continue;
    out.push({ bar: mb.index, occ: a.syncPointValue.barOccurence, pos: a.ratioPosition, ms: a.syncPointValue.millisecondOffset });
  }
  return out;
}

/**
 * Store alignment points. `fresh` points win over `kept` ones: a kept point that would make time run backwards
 * next to a fresh one is dropped. When the first point is not on bar 1, a bar-1 point is added at the written
 * tempo so the start of the song is defined too.
 */
export function writePoints(score, settings, kept, fresh = []) {
  const order = playOrder(score, settings);
  const index = new Map(order.map((o, i) => [`${o.bar}:${o.occ}`, i]));
  const all = new Map();
  for (const p of kept) if (index.has(`${p.bar}:${p.occ}`)) all.set(`${p.bar}:${p.occ}`, { ...p, fresh: false });
  for (const p of fresh) if (index.has(`${p.bar}:${p.occ}`)) all.set(`${p.bar}:${p.occ}`, { pos: 0, ...p, fresh: true });
  const list = [...all.values()].sort((a, b) => index.get(`${a.bar}:${a.occ}`) - index.get(`${b.bar}:${b.occ}`) || a.pos - b.pos);
  const fixed = list.filter(p => p.fresh);
  const keep = [];
  for (const p of list) {
    if (!p.fresh) {
      const i = index.get(`${p.bar}:${p.occ}`);
      const before = [...fixed].reverse().find(f => index.get(`${f.bar}:${f.occ}`) < i);
      const after = fixed.find(f => index.get(`${f.bar}:${f.occ}`) > i);
      if ((before && p.ms <= before.ms) || (after && p.ms >= after.ms)) continue;
    }
    if (keep.length && p.ms <= keep[keep.length - 1].ms) continue;
    keep.push(p);
  }
  const flat = keep.map(p => ({ barIndex: p.bar, barOccurence: p.occ, barPosition: p.pos, millisecondOffset: Math.round(p.ms) }));
  let auto = null;
  if (keep.length && order.length && !(keep[0].bar === order[0].bar && keep[0].occ === order[0].occ && keep[0].pos === 0)) {
    const first = order[index.get(`${keep[0].bar}:${keep[0].occ}`)];
    auto = { barIndex: order[0].bar, barOccurence: order[0].occ, barPosition: 0, millisecondOffset: Math.round(keep[0].ms - (first.synthMs - order[0].synthMs)) };
    flat.unshift(auto);
  }
  score.applyFlatSyncPoints(flat);
  if (auto) {
    const a = score.masterBars[auto.barIndex].syncPoints.find(s => s.syncPointValue.barOccurence === auto.barOccurence && s.ratioPosition === 0);
    if (a) a.text = AUTO;
  }
  return keep.length;
}

const fmt = ms => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`; };

export function initVideo({ api, editor, $, toast, togglePlay }) {
  const panel = $('videoPanel'), video = $('videoEl');
  let media = null;       // { name, url, file, audio }
  let range = { from: 0, to: null };
  let auto = null;        // last automatic transcription: { samples, rate, offset, notes, rhythm, title }
  let busy = false;
  let tapping = null;     // { order, start, taps: [ms] }
  let frame = 0;

  const output = () => api.player?.output;
  const push = () => { const o = output(); if (media && o?.updatePosition) o.updatePosition(video.currentTime * 1000); };
  const loop = () => { push(); frame = video.paused ? 0 : requestAnimationFrame(loop); };
  video.addEventListener('play', () => { if (!frame) frame = requestAnimationFrame(loop); });
  video.addEventListener('seeked', push);
  video.addEventListener('timeupdate', push);
  video.addEventListener('ended', () => { if (api.playerState === alphaTab.synth.PlayerState.Playing) api.pause(); if (tapping) finishTapping(); });
  video.addEventListener('loadedmetadata', () => { renderStatus(); push(); });

  const handler = {
    get backingTrackDuration() { return Number.isFinite(video.duration) ? video.duration * 1000 : 0; },
    get playbackRate() { return video.playbackRate; },
    set playbackRate(v) { video.playbackRate = v; },
    get masterVolume() { return video.volume; },
    set masterVolume(v) { video.volume = Math.max(0, Math.min(1, v)); },
    seekTo(ms) { video.currentTime = Math.max(0, ms / 1000); },
    play() { video.play().catch(() => api.pause()); },
    pause() { video.pause(); }
  };
  // alphaTab creates a new player when the mode changes; hand it the video as soon as it exists.
  function connect() {
    const o = output();
    if (media && o && 'handler' in o) { o.handler = handler; push(); return true; }
    return false;
  }
  api.playerReady.on(() => connect());

  function setMode(external) {
    api.settings.player.playerMode = external ? alphaTab.PlayerMode.EnabledExternalMedia : alphaTab.PlayerMode.EnabledAutomatic;
    api.updateSettings();
    if (external) connect();
    for (const id of ['metronomeBtn', 'countInBtn']) { const b = $(id); if (b) { b.disabled = external; } }
    document.body.classList.toggle('has-video', external);
  }

  function attach(file) {
    if (tapping) finishTapping(false);
    if (media) URL.revokeObjectURL(media.url);
    media = { name: file.name, url: URL.createObjectURL(file), file, audio: null };
    range = { from: 0, to: null }; auto = null; renderRange(); $('vAutoResult').hidden = true;
    video.src = media.url;
    panel.classList.toggle('audio-only', /^audio\//.test(file.type) || /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i.test(file.name));
    $('videoName').textContent = file.name;
    $('videoName').title = file.name;
    panel.hidden = false;
    setMode(true);
    renderStatus();
    const n = api.score ? readPoints(api.score).length : 0;
    toast(n ? `已放入「${file.name}」，套用譜裡存的 ${n} 個對齊點。按播放就會一起走。`
      : `已放入「${file.name}」。現在第 1 小節對齊影片開頭；用下面的「對齊」把譜和影片對準。`);
  }
  function detach() {
    if (tapping) finishTapping(false);
    api.stop();
    video.pause(); video.removeAttribute('src'); video.load();
    if (media) URL.revokeObjectURL(media.url);
    media = null;
    panel.hidden = true;
    setMode(false);
  }

  // ---- alignment ----
  const cursorBar = () => editor.cursor.bar;
  function commit(fresh, message) {
    const t = video.currentTime;
    const ok = editor.apply(score => { writePoints(score, api.settings, readPoints(score), fresh); }, { needsStrings: false });
    if (!ok) return;
    // Rebuilding the score resets the player to the start; put the video back where it was.
    const restore = () => { api.midiLoaded.off(restore); video.currentTime = t; };
    api.midiLoaded.on(restore);
    renderStatus();
    if (message) toast(message);
  }
  function markHere() {
    if (!api.score || !media) return;
    const bar = cursorBar();
    commit([{ bar, occ: 0, ms: video.currentTime * 1000 }], `第 ${bar + 1} 小節的開頭 = 影片 ${fmt(video.currentTime * 1000)}`);
  }
  function startTapping() {
    if (!api.score || !media) return;
    if (api.playerState === alphaTab.synth.PlayerState.Playing) api.pause();
    const order = playOrder(api.score, api.settings);
    const start = order.findIndex(o => o.bar === cursorBar());
    tapping = { order, start: Math.max(0, start), taps: [] };
    video.play().catch(() => {});
    renderStatus();
  }
  function tap() {
    if (!tapping) return;
    const next = tapping.order[tapping.start + tapping.taps.length];
    if (!next) { finishTapping(); return; }
    tapping.taps.push(video.currentTime * 1000);
    flash();
    renderStatus();
  }
  function finishTapping(save = true) {
    const t = tapping; tapping = null;
    video.pause();
    if (!t) return;
    if (save && t.taps.length) {
      const fresh = t.taps.map((ms, i) => ({ bar: t.order[t.start + i].bar, occ: t.order[t.start + i].occ, ms }));
      const first = fresh[0].bar + 1, last = fresh[fresh.length - 1].bar + 1;
      commit(fresh, `已對齊 ${fresh.length} 個小節（第 ${first}${last !== first ? `–${last}` : ''} 小節）`);
    } else renderStatus();
  }
  function shiftAll(ms) {
    if (!api.score) return;
    const pts = readPoints(api.score);
    if (!pts.length) { // nothing aligned yet: move bar 1 itself
      commit([{ bar: 0, occ: 0, ms: Math.max(0, ms) }], `第 1 小節的開頭 = 影片 ${fmt(Math.max(0, ms))}`);
      return;
    }
    const moved = pts.map(p => ({ ...p, ms: p.ms + ms }));
    editor.apply(score => { score.applyFlatSyncPoints([]); writePoints(score, api.settings, moved); }, { needsStrings: false });
    renderStatus();
    toast(`整體${ms > 0 ? '延後' : '提早'} ${Math.abs(ms)} 毫秒`);
  }
  function clearAll() {
    if (!api.score || !readPoints(api.score).length) return;
    editor.apply(score => { score.applyFlatSyncPoints([]); }, { needsStrings: false });
    renderStatus();
    toast('已清除對齊，第 1 小節回到影片開頭');
  }

  // ---- automatic transcription of a stretch of the video ----
  const AUDIO_RATE = 22050;
  const clock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function renderRange() {
    $('vFromText').textContent = clock(range.from);
    $('vToText').textContent = range.to === null ? '結尾' : clock(range.to);
  }
  function setRange(which) {
    const t = video.currentTime;
    if (which === 'from') { range.from = t; if (range.to !== null && range.to <= t + 1) range.to = null; }
    else range.to = t > range.from + 1 ? t : null;
    renderRange();
  }
  async function decodeAudio() {
    if (media.audio) return media.audio;
    const ctx = new OfflineAudioContext(1, 1, AUDIO_RATE); // decoding resamples to the context's rate
    const buf = await ctx.decodeAudioData(await media.file.arrayBuffer());
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
    media.audio = mono;
    return mono;
  }
  const status = text => { $('videoStatus').textContent = text; };
  async function autoTranscribe() {
    if (busy || !media) return;
    const end = range.to ?? (Number.isFinite(video.duration) ? video.duration : 0);
    if (end - range.from < 2) { toast('範圍太短，至少要 2 秒'); return; }
    if (end - range.from > 240 && !confirm(`這一段有 ${Math.round((end - range.from) / 60)} 分鐘，分析會花比較久。繼續？`)) return;
    if (editor.dirty && !confirm('自動扒譜會取代目前的譜，未儲存的修改會不見。繼續？')) return;
    busy = true; $('vAutoBtn').disabled = true;
    if (api.playerState === alphaTab.synth.PlayerState.Playing) api.pause();
    try {
      status('讀取影片的聲音…');
      const audio = await decodeAudio();
      const samples = audio.subarray(Math.floor(range.from * AUDIO_RATE), Math.min(audio.length, Math.ceil(end * AUDIO_RATE)));
      const { transcribePoly } = await import('../audio/poly.js');
      let slow = false;
      const notes = await transcribePoly(samples, AUDIO_RATE, {
        model: `${import.meta.env.BASE_URL}basic-pitch/model.json`, lowest: 28, highest: 96,
        // Tuned on band recordings with known tabs (tools/bench.mjs): fewer false notes, about as many found.
        onsetThreshold: 0.65, frameThreshold: 0.2,
        onProgress: f => status(`聽音符中… ${Math.round(f * 100)}%（${clock(end - range.from)} 的音訊）${slow ? '・顯示卡加速失敗，改用 CPU，會慢一點' : ''}`),
        onFallback: () => { slow = true; }
      });
      status('找拍子和小節線…');
      await new Promise(r => setTimeout(r, 0));
      const rhythm = analyseRhythm(samples, AUDIO_RATE, notes);
      auto = { samples, rate: AUDIO_RATE, offset: range.from, notes, rhythm, title: media.name.replace(/\.[^.]+$/, '') };
      buildScore(true);
    } catch (err) {
      console.error(err);
      toast(`自動扒譜失敗：${err.message || err}`);
      renderStatus();
    } finally { busy = false; $('vAutoBtn').disabled = false; }
  }
  /** Write the score from the last analysis (again, after the bar lines or tempo were corrected). */
  function buildScore(first = false) {
    if (!auto) return;
    let out;
    try { out = videoScore(auto.notes, auto.rhythm, { offset: auto.offset, title: auto.title }); }
    catch (err) { toast(err.message); renderStatus(); return; }
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(out.tex, api.settings);
    const score = importer.readScore();
    const fresh = out.bars.slice(0, score.masterBars.length).map((t, k) => ({ bar: k, occ: 0, ms: t * 1000 }));
    writePoints(score, api.settings, [], fresh);
    editor.load(score);
    video.currentTime = Math.max(0, out.bars[0] - 0.3);
    $('vAutoResult').hidden = false;
    $('vAutoInfo').textContent = `♩=${out.bpm} · ${score.masterBars.length} 小節`;
    renderStatus();
    if (first) toast(`寫好了：${out.notes} 個音、${score.masterBars.length} 小節，每小節都已經對齊影片。這是草稿：音高是聽出來的，弦格、節奏細節和技巧請校對。小節線位置不對的話，用「← 一拍 / 一拍 →」或「這裡是第一拍」修正。`);
  }
  function shiftDownbeat(beats) { if (!auto) return; auto.rhythm.downbeat += beats; buildScore(); }
  function downbeatHere() {
    if (!auto) return;
    const beat = Math.round(timeToBeat(video.currentTime - auto.offset, auto.rhythm.beats));
    auto.rhythm.downbeat = beat;
    buildScore();
    toast('小節線已對齊到這一拍');
  }
  function retempo(factor) {
    if (!auto) return;
    auto.rhythm = analyseRhythm(auto.samples, auto.rate, auto.notes, { bpm: auto.rhythm.bpm * factor });
    buildScore();
  }

  function flash() { const b = $('vTapBtn'); b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit'); }
  function renderStatus() {
    if (!media) return;
    const bar = cursorBar() + 1;
    $('vMarkBtn').textContent = `這裡是第 ${bar} 小節開頭`;
    $('vTapStartBtn').classList.toggle('on', !!tapping);
    $('vTapStartBtn').textContent = tapping ? '完成' : '邊聽邊點';
    $('vTapRow').hidden = !tapping;
    panel.classList.toggle('tapping', !!tapping);
    const s = $('videoStatus');
    if (tapping) {
      const next = tapping.order[tapping.start + tapping.taps.length];
      s.textContent = next ? `每個小節的第一拍點一下（M 鍵或大按鈕）。下一下 = 第 ${next.bar + 1} 小節${next.occ ? `（第 ${next.occ + 1} 次）` : ''}。按「完成」或空白鍵結束。`
        : '已經點到最後一個小節，按「完成」。';
      return;
    }
    const pts = api.score ? readPoints(api.score) : [];
    s.textContent = pts.length
      ? `已對齊 ${pts.length} 個點，第一個：第 ${pts[0].bar + 1} 小節 = ${fmt(pts[0].ms)}`
      : '還沒對齊：第 1 小節 = 影片開頭，照譜上的速度走。';
  }

  // ---- wiring ----
  $('videoBtn').onclick = () => (media ? (panel.hidden = !panel.hidden) : $('videoInput').click());
  $('videoInput').onchange = e => { const f = e.target.files?.[0]; if (f) attach(f); e.target.value = ''; };
  $('videoReplaceBtn').onclick = () => $('videoInput').click();
  $('videoCloseBtn').onclick = () => detach();
  $('videoSizeBtn').onclick = () => { panel.classList.toggle('big'); $('videoSizeBtn').textContent = panel.classList.contains('big') ? '縮小' : '放大'; };
  video.onclick = () => (tapping ? tap() : togglePlay());
  $('vBackBtn').onclick = () => { video.currentTime = Math.max(0, video.currentTime - 0.05); };
  $('vFwdBtn').onclick = () => { video.currentTime = video.currentTime + 0.05; };
  $('vMarkBtn').onclick = () => markHere();
  $('vTapStartBtn').onclick = () => (tapping ? finishTapping() : startTapping());
  $('vTapBtn').onpointerdown = e => { e.preventDefault(); tap(); };
  $('vFromBtn').onclick = () => setRange('from');
  $('vToBtn').onclick = () => setRange('to');
  $('vAutoBtn').onclick = () => autoTranscribe();
  $('vBeatEarlierBtn').onclick = () => shiftDownbeat(-1);
  $('vBeatLaterBtn').onclick = () => shiftDownbeat(1);
  $('vBarHereBtn').onclick = () => downbeatHere();
  $('vDoubleBtn').onclick = () => retempo(2);
  $('vHalfBtn').onclick = () => retempo(0.5);
  $('vUpBtn').onclick = () => retempo(1.5);
  $('vDownBtn').onclick = () => retempo(2 / 3);
  $('vEarlierBtn').onclick = () => shiftAll(-50);
  $('vLaterBtn').onclick = () => shiftAll(50);
  $('vClearBtn').onclick = () => clearAll();
  panel.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  // While tapping, M / Enter tap and Space finishes; nothing reaches the editor.
  document.addEventListener('keydown', e => {
    if (!tapping || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyM' || e.code === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) tap(); }
    else if (e.code === 'Space' || e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finishTapping(e.code === 'Space'); }
  }, true);
  // Drag the panel by its title bar.
  $('videoHead').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => {
      panel.style.left = `${Math.min(innerWidth - 60, Math.max(0, ev.clientX - dx))}px`;
      panel.style.top = `${Math.min(innerHeight - 40, Math.max(0, ev.clientY - dy))}px`;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });

  return {
    attach, detach,
    get mediaName() { return media?.name ?? null; },
    onCursor: () => renderStatus(),
    onScore: () => renderStatus()
  };
}
