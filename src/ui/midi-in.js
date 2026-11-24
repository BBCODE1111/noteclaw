// "MIDI 輸入" card: record from a MIDI keyboard or MIDI guitar (Web MIDI), then write the score with the
// tempo, bar lines and pitches worked out from what was played.
import { midiToNotes, midiScore } from '../audio/midi-tab.js';
import { midiName, OPEN_STRINGS, BASS_STRINGS } from '../fingering.js';

export function initMidiInput({ $, toast, setStatus, hasScore, onTex }) {
  let access = null, events = [], t0 = 0, recording = false, count = 0;
  const supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  const info = text => { $('midiInfo').textContent = text; };
  if (!supported) {
    info('這個瀏覽器不支援 MIDI（請用 Chrome 或 Edge）');
    $('midiRecBtn').disabled = true;
    return;
  }

  function inputs() { return access ? [...access.inputs.values()] : []; }
  function fillDevices() {
    const sel = $('midiDevice'), keep = sel.value;
    sel.replaceChildren(new Option('所有 MIDI 裝置', ''), ...inputs().map(i => new Option(i.name || 'MIDI 裝置', i.id)));
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
  }
  function onMessage(e) {
    if (!recording) return;
    const chosen = $('midiDevice').value;
    if (chosen && e.target?.id !== chosen) return;
    const data = [...e.data];
    const kind = data[0] & 0xf0;
    if (kind !== 0x90 && kind !== 0x80 && kind !== 0xb0) return; // notes and the sustain pedal
    events.push({ time: (e.timeStamp || performance.now()) - t0, data });
    if (kind === 0x90 && data[2] > 0) { count++; $('midiNote').textContent = midiName(data[1]); info(`錄製中 · 已收到 ${count} 個音`); }
  }
  /** Ask for MIDI access once; listen to every input (the device menu filters). */
  async function connect() {
    if (access) return;
    access = await navigator.requestMIDIAccess({ sysex: false });
    const listen = () => { for (const i of inputs()) i.onmidimessage = onMessage; fillDevices(); };
    access.onstatechange = listen;
    listen();
  }

  $('midiRecBtn').onclick = async () => {
    if (recording) return;
    try { await connect(); }
    catch (e) { toast(`無法使用 MIDI（${String(e.message).replace(/[.。]$/, "")}）。請在瀏覽器的權限提示按「允許」，讓這個網頁使用 MIDI 裝置。`); return; }
    if (!inputs().length) toast('沒有找到 MIDI 裝置。請接上之後再按一次（或先開啟裝置的 USB/藍牙連線）。');
    events = []; count = 0; t0 = performance.now(); recording = true;
    $('midiRecBtn').disabled = true; $('midiRecBtn').classList.add('active'); $('midiRecBtn').textContent = '● 錄製中'; $('midiStopBtn').disabled = false;
    $('midiNote').textContent = '—'; info(`錄製中 · ${inputs().length} 個 MIDI 裝置`);
    setStatus('MIDI 錄製中');
  };
  $('midiStopBtn').onclick = () => {
    if (!recording) return;
    recording = false;
    $('midiRecBtn').disabled = false; $('midiRecBtn').classList.remove('active'); $('midiRecBtn').textContent = '● 開始 MIDI 錄製'; $('midiStopBtn').disabled = true;
    setStatus('可播放 / 可編輯');
    write(midiToNotes(events, performance.now() - t0));
  };

  /** Exposed for testing without a device: write a score from raw messages. */
  function write(notes) {
    if (!notes.length) { info('沒有收到音符'); toast('沒有收到 MIDI 音符。請確認裝置有接上，並在錄製時彈奏。'); return; }
    const instrument = $('recInstrument').value;
    const piano = instrument === 'piano', bass = instrument === 'bass';
    const bpm = $('midiUseBpm').checked ? Number($('transcribeBpm').value) || undefined : undefined;
    try {
      const out = midiScore(notes, { bpm, staff: piano ? 'score' : 'tab', tuning: bass ? BASS_STRINGS : OPEN_STRINGS,
        title: 'MIDI', trackName: piano ? 'Piano' : bass ? 'Bass' : 'Guitar' });
      info(`${notes.length} 個音 · ♩=${out.bpm}${bpm ? '（用設定的速度）' : '（自動偵測）'} · ${out.bars.length - 1} 小節`);
      if (hasScore() && !confirm(`收到 ${notes.length} 個 MIDI 音。產生的譜會取代目前的譜面，要繼續嗎？`)) return;
      onTex(out.tex, notes, `速度 ♩=${out.bpm}${bpm ? '' : '，是從你的彈奏自動抓的'}。音高來自 MIDI，是準的；${piano ? '' : '弦格是推測的，'}小節線若偏了一拍，可以在第一個音前後增刪休止符。`);
    } catch (e) { console.error(e); toast(e.message); }
  }
  return { write, notesFromEvents: midiToNotes };
}
