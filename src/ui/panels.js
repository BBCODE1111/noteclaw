// Side panels and transport extras: song settings, tracks/mixer, view modes, annotations, loop and metronome.
import { GM_INSTRUMENTS, GM_FAMILIES, GUITAR_PROGRAMS, instrumentIcon } from './gm.js';
import { TUNINGS, tuningId } from '../editor/ops.ts';

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const noteName = p => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

const MAJOR = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MINOR = ['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];
const accidentals = k => (k === 0 ? '' : `（${Math.abs(k)}${k > 0 ? '♯' : '♭'}）`);

export function initPanels({ api, editor, $, toast }) {
  const view = { tab: true, standard: false, numbered: false };
  let last = null;
  const idle = el => document.activeElement !== el;
  const set = (el, value) => { if (idle(el) && el.value !== String(value)) el.value = String(value); };

  // ----- song settings -----
  for (const [minor, names, label] of [[false, MAJOR, '大調'], [true, MINOR, '小調']]) {
    const group = document.createElement('optgroup'); group.label = label;
    names.forEach((name, i) => group.append(new Option(`${name} ${label}${accidentals(i - 7)}`, `${i - 7}:${minor ? 1 : 0}`)));
    $('keySelect').append(group);
  }
  $('bpmInput').onchange = () => editor.setTempo(Number($('bpmInput').value));
  $('keySelect').onchange = () => { const [k, m] = $('keySelect').value.split(':').map(Number); editor.setKey(k, m === 1); $('keySelect').blur(); };
  const applyTs = () => editor.setTimeSignature(Number($('tsNum').value), Number($('tsDen').value));
  $('tsNum').onchange = applyTs;
  $('tsDen').onchange = () => { applyTs(); $('tsDen').blur(); };

  // ----- which staves are shown -----
  /** Apply the chosen staves to a score. Tracks without strings fall back to standard notation. */
  function applyView(score) {
    for (const track of score.tracks) for (const staff of track.staves) {
      if (staff.isPercussion) { staff.showTablature = false; staff.showNumbered = false; staff.showStandardNotation = true; continue; }
      const stringed = staff.tuning?.length > 0;
      staff.showTablature = stringed && view.tab;
      staff.showNumbered = view.numbered;
      staff.showStandardNotation = view.standard || (!view.numbered && !(stringed && view.tab));
    }
  }
  document.querySelectorAll('#viewBtns button').forEach(b => b.onclick = () => {
    const mode = b.dataset.viewmode;
    if (view[mode] && Object.values(view).filter(Boolean).length === 1) return toast('至少要顯示一種譜');
    view[mode] = !view[mode];
    if (api.score) { applyView(api.score); editor.refresh(); }
    if (!view.tab) toast('要用游標編輯，請把六線譜顯示出來');
  });

  // ----- annotations -----
  for (const [id, apply] of [['chordInput', v => editor.setChord(v)], ['textInput', v => editor.setText(v)]]) {
    const el = $(id);
    el.onchange = () => apply(el.value);
    el.onkeydown = e => {
      if (e.key === 'Enter') el.blur();
      if (e.key === 'Escape') { el.value = id === 'chordInput' ? last?.chord ?? '' : last?.text ?? ''; el.blur(); }
    };
  }

  // ----- tracks -----
  const common = document.createElement('optgroup'); common.label = '常用';
  GUITAR_PROGRAMS.forEach(([n, name]) => common.append(new Option(`${instrumentIcon(n)} ${name}`, n)));
  // The full General MIDI set, grouped into its 16 families with a picture for each.
  const families = GM_FAMILIES.map(([icon, label], f) => {
    const group = document.createElement('optgroup'); group.label = `${icon} ${label}`;
    GM_INSTRUMENTS.slice(f * 8, f * 8 + 8).forEach((name, k) => group.append(new Option(`${instrumentIcon(f * 8 + k)} ${name}`, f * 8 + k)));
    return group;
  });
  $('programSelect').append(common, ...families);
  $('programSelect').onchange = () => { editor.setProgram(editor.cursor.track, Number($('programSelect').value)); $('programSelect').blur(); };
  $('trackVolume').onchange = () => editor.setTrackVolume(editor.cursor.track, Number($('trackVolume').value));
  $('addGuitarBtn').onclick = () => editor.addTrack('guitar');
  $('addBassBtn').onclick = () => editor.addTrack('bass');
  $('addDrumBtn').onclick = () => editor.addDrumTrack();
  $('deleteTrackBtn').onclick = () => {
    const t = last?.tracks.find(x => x.active);
    if (t && confirm(`確定刪除軌道「${t.name}」？（可以用 ⌘Z 復原）`)) editor.deleteTrack(t.index);
  };
  // ----- tuning and capo -----
  const tuningGroups = [['吉他', t => t.strings >= 6 && !t.id.startsWith('bass')], ['貝斯', t => t.id.startsWith('bass')], ['其他', t => t.id === 'uke']];
  for (const [label, test] of tuningGroups) {
    const group = document.createElement('optgroup'); group.label = label;
    TUNINGS.filter(test).forEach(t => group.append(new Option(t.name, t.id)));
    $('tuningSelect').append(group);
  }
  $('tuningSelect').append(new Option('自訂（在下面逐弦調整）', 'custom'));
  for (let f = 0; f <= 12; f++) $('capoSelect').append(new Option(f ? `第 ${f} 格` : '不夾', f));
  const activeTrack = () => last?.tracks.find(t => t.active);
  $('tuningSelect').onchange = () => {
    const preset = TUNINGS.find(t => t.id === $('tuningSelect').value);
    const t = activeTrack();
    if (preset && t) editor.setTuning(t.index, preset.pitches, $('keepPitchCheck').checked);
    $('tuningSelect').blur();
  };
  $('capoSelect').onchange = () => { const t = activeTrack(); if (t) editor.setCapo(t.index, Number($('capoSelect').value)); $('capoSelect').blur(); };
  /** One note picker per string, lowest string on the left the way a guitarist reads a tuning. */
  function renderStrings(t) {
    const box = $('stringPitches');
    const key = t.tuning.join(',');
    if (box.dataset.key === key && box.contains(document.activeElement)) return;
    box.dataset.key = key; box.replaceChildren();
    [...t.tuning].reverse().forEach((pitch, i) => {
      const sel = document.createElement('select');
      sel.title = `第 ${t.tuning.length - i} 弦`;
      for (let p = Math.max(0, pitch - 12); p <= Math.min(127, pitch + 12); p++) sel.append(new Option(noteName(p), p));
      sel.value = String(pitch);
      sel.onchange = () => {
        const pitches = [...t.tuning]; pitches[t.tuning.length - 1 - i] = Number(sel.value);
        editor.setTuning(t.index, pitches, $('keepPitchCheck').checked);
      };
      box.append(sel);
    });
  }

  function renderTracks(st) {
    const list = $('trackList'); list.replaceChildren();
    for (const t of st.tracks) {
      const row = document.createElement('div'); row.className = 'trk' + (t.active ? ' active' : '');
      const name = document.createElement('button'); name.className = 'trk-name';
      name.textContent = `${t.percussion ? '🥁' : instrumentIcon(t.program)} ${t.index + 1}. ${t.name}`; name.title = t.percussion ? '打擊樂軌（只能顯示和播放）' : t.strings ? '點一下編輯這個軌道' : '非弦樂器軌（只能顯示和播放）';
      name.onclick = () => editor.setTrack(t.index);
      const mini = (act, label, on, title, fn) => { const b = document.createElement('button'); b.className = 'mini' + (on ? ' on' : ''); b.dataset.act = act; b.textContent = label; b.title = title; b.onclick = fn; return b; };
      row.append(name,
        mini('show', '顯', t.visible, '在譜面上顯示這個軌道', () => editor.toggleVisible(t.index)),
        mini('solo', 'S', t.solo, '獨奏', () => editor.setSolo(t.index, !t.solo)),
        mini('mute', 'M', t.mute, '靜音', () => editor.setMute(t.index, !t.mute)));
      list.append(row);
    }
    const sel = $('trackSelect');
    if (sel.options.length !== st.tracks.length || [...sel.options].some((o, i) => o.textContent !== `${i + 1}. ${st.tracks[i].name}`)) {
      sel.replaceChildren(...st.tracks.map(t => new Option(`${t.index + 1}. ${t.name}`, t.index)));
    }
    const active = st.tracks.find(t => t.active);
    if (active) {
      sel.value = String(active.index);
      set($('programSelect'), active.program);
      $('programSelect').disabled = active.percussion;
      set($('trackVolume'), active.volume);
      const stringed = !active.percussion && active.strings > 0;
      $('tuningBox').hidden = !stringed;
      if (stringed) {
        set($('tuningSelect'), tuningId(active.tuning) ?? 'custom');
        set($('capoSelect'), active.capo);
        renderStrings(active);
      }
    }
    $('deleteTrackBtn').disabled = st.tracks.length <= 1;
  }

  // ----- loop a range of bars, metronome, count-in -----
  const loop = { a: null, b: null };
  function applyLoop() {
    if (loop.a === null) { api.playbackRange = null; $('loopLabel').textContent = ''; }
    else {
      const from = Math.min(loop.a, loop.b), to = Math.max(loop.a, loop.b);
      const range = editor.barRange(from, to);
      if (!range) return;
      api.playbackRange = range; api.isLooping = true;
      $('loopLabel').textContent = from === to ? `循環第 ${from + 1} 小節` : `循環 ${from + 1}–${to + 1} 小節`;
    }
    $('loopABtn').classList.toggle('on', loop.a !== null); $('loopBBtn').classList.toggle('on', loop.a !== null);
    $('loopBtn').classList.toggle('engaged', api.isLooping);
  }
  $('loopABtn').onclick = () => { loop.a = editor.cursor.bar; if (loop.b === null) loop.b = loop.a; applyLoop(); };
  $('loopBBtn').onclick = () => { loop.b = editor.cursor.bar; if (loop.a === null) loop.a = loop.b; applyLoop(); };
  $('loopClearBtn').onclick = () => { loop.a = loop.b = null; api.isLooping = false; applyLoop(); };
  const toggle = (id, prop) => $(id).onclick = () => { const on = api[prop] === 0; api[prop] = on ? 1 : 0; $(id).classList.toggle('on', on); };
  toggle('metronomeBtn', 'metronomeVolume');
  toggle('countInBtn', 'countInVolume');
  // The player forgets solo/mute and the loop range whenever the MIDI is rebuilt after an edit.
  api.midiLoaded.on(() => { editor.syncMixer(); if (loop.a !== null) applyLoop(); });

  function onState(st) {
    last = st;
    document.querySelectorAll('#viewBtns button').forEach(b => b.classList.toggle('on', !!view[b.dataset.viewmode]));
    set($('bpmInput'), st.song.tempo);
    set($('tsNum'), st.song.tsNum); set($('tsDen'), st.song.tsDen);
    set($('keySelect'), `${st.song.key}:${st.song.minor ? 1 : 0}`);
    set($('chordInput'), st.chord); set($('textInput'), st.text);
    $('chordInput').disabled = $('textInput').disabled = !st.editable;
    if (loop.a !== null && Math.max(loop.a, loop.b) >= st.barCount) { loop.a = loop.b = null; applyLoop(); }
    renderTracks(st);
  }
  /** Forget the loop when another song is opened. */
  function reset() { loop.a = loop.b = null; $('loopLabel').textContent = ''; $('loopABtn').classList.remove('on'); $('loopBBtn').classList.remove('on'); }
  return { onState, applyView, reset, view };
}
