import * as alphaTab from '@coderline/alphatab';
import { midiName } from './fingering.js';
import { DRUM_KIT, setKeySignature } from './editor/ops.ts';
import { initLive } from './ui/live.js';
import { midiToAlphaTex } from './midi-import.js';
import { TabEditor } from './editor/editor.ts';
import { mountIcons } from './ui/icons.js';
import { initPanels } from './ui/panels.js';
import { exportGuitarPro, exportProject, importProject, PROJECT_EXTENSION, PROJECT_EXTENSIONS } from './io/files.ts';
import { exportPng, exportPdf } from './io/image-export.js';
import './style.css';

const $ = id => document.getElementById(id);
const SAMPLE = String.raw`\title "First Lick"
\tempo 110
\track "Lead Guitar"
.
:8 5.6 7.6 8.6 7.6 8.5 10.5 7.6 5.6 |
:8 8.5 10.5 12.5 10.5 :4 8.5 7.5 |
:16 9.4 11.4 12.4 9.3 :8 10.3 12.3 10.3 9.3 :4 12.3 |
:4 10.4 :8 9.4 7.4 :2 9.4 |`;

let fileName = 'First Lick.gp', currentTrack = 0;
mountIcons();
const api = new alphaTab.AlphaTabApi($('alphaTab'), {
  core: { fontDirectory: `${import.meta.env.BASE_URL}font/`, includeNoteBounds: true },
  player: { enablePlayer: true, enableCursor: true, enableSeekToClick: false, enablePlaybackRangeSelection: false,
    // The score scrolls inside its own panel, so alphaTab must be told which element to scroll while playing.
    scrollElement: $('scoreScroll'), scrollMode: alphaTab.ScrollMode.Continuous, scrollOffsetY: -30,
    soundFont: `${import.meta.env.BASE_URL}soundfont/sonivox.sf2` },
  notation: { rhythmMode: alphaTab.TabRhythmMode.ShowWithBars, rhythmHeight: 22 }
});
function showToast(str) { const t=$('toast'); t.textContent=str;t.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>t.classList.remove('show'),3600); }
function setStatus(str, error=false) { $('status').textContent=str; $('status').classList.toggle('error',error); }
function basename(s) { return String(s || 'Untitled').replace(/[^A-Za-z0-9\u4e00-\u9fff._\- ]/g,'_').slice(0,90); }
function download(bytes, name, mime='application/octet-stream') {
  const data = bytes instanceof Uint8Array || bytes instanceof ArrayBuffer ? bytes : new TextEncoder().encode(bytes);
  const blob = new Blob([data], {type:mime}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=basename(name); a.click(); setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function presentTrack(track) { return track?.name || track?.shortName || `Track ${track?.index+1}`; }
function setView(name) {
  document.querySelectorAll('[data-view]').forEach(e=>e.classList.toggle('active',e.dataset.view===name));
  document.querySelectorAll('.view').forEach(e=>e.classList.toggle('active',e.id===name+'View'));
  if (name==='score') setTimeout(()=>api.render(),100);
}
function onScoreLoaded(score) {
  if (!score) return;
  if (editor.isOwn(score)) { $('pageTitle').textContent = score.title || 'Untitled'; return; }
  $('titleInput').value = score.title || 'Untitled';
  $('artistInput').value = score.artist || '';
  $('pageTitle').textContent = score.title || 'Untitled';
  $('transcribeBpm').value = score.tempo || 110;
  currentTrack=Math.min(currentTrack,score.tracks.length-1);
  panels.reset();
  $('fileLabel').textContent = fileName.toUpperCase();
  $('subTitle').textContent = `${score.artist ? score.artist + ' · ' : ''}${score.tracks.length} 軌 · ♩=${score.tempo || 110}`;
  // Opened files start in the view the player chose (tablature by default), whatever the file asked for.
  panels.applyView(score); api.render();
  setStatus('譜面已載入');
}

// ---- tab editor (cursor, keyboard entry, undo/redo) ----
const DURATION_NAMES = {1:'全音符',2:'2 分音符',4:'4 分音符',8:'8 分音符',16:'16 分音符',32:'32 分音符',64:'64 分音符'};
const BEND_NAMES = {2:'半音',4:'全音',6:'一個半音',8:'兩個全音'};
const beatsText = ticks => String(+(Math.abs(ticks)/960).toFixed(3));
function onEditorState(st) {
  $('undoBtn').disabled = !st.canUndo; $('redoBtn').disabled = !st.canRedo;
  document.querySelectorAll('#editorPanel button').forEach(b => { b.disabled = !st.editable && !/Bar/.test(b.id); });
  panels.onState(st);
  if (api.score) $('subTitle').textContent = `${api.score.artist ? api.score.artist + ' · ' : ''}${st.tracks.length} 軌 · ♩=${st.song.tempo}`;
  $('readout').hidden = !st.editable; $('selectionLabel').hidden = st.editable;
  // Strings-only controls are hidden on a drum track; the drum pad replaces them.
  for (const id of ['techBtns', 'pitchBtns', 'inputModeBtns']) $(id).hidden = st.drums;
  $('drumPad').hidden = !st.drums;
  if (st.drums) document.querySelectorAll('#drumPad button').forEach(b => b.classList.toggle('on', st.drumHits.includes(Number(b.dataset.out))));
  document.querySelectorAll('#inputModeBtns button').forEach(b => b.classList.toggle('on', b.dataset.input === st.inputMode));
  $('pasteBtn').disabled = !st.canPaste;
  $('selInfo').textContent = st.selected ? `已選 ${st.selected} 拍 · Esc 取消` : '';
  if (!st.editable) { $('selectionLabel').textContent = '這個軌道目前不能編輯（只有弦樂器和鼓組可以）'; $('fillLabel').textContent = ''; $('samePitchChoices').replaceChildren(); return; }
  $('roBar').textContent = `${st.bar+1}/${st.barCount}`;
  $('roPos').textContent = `${st.beat+1}/${st.beatCount}`;
  $('roString').textContent = st.drums ? '鼓' : st.guitarString;
  $('roFret').textContent = st.isRest ? '休' : st.drums ? st.drumHits.length : st.fret ?? '–';
  $('roNote').textContent = st.drums ? (DRUM_KIT.filter(p => st.drumHits.includes(p.out)).map(p => p.name).join('+') || '–') : st.pitch === null ? '–' : midiName(st.pitch);
  const diff = st.fill.total - st.fill.used;
  const others = st.badBars.filter(i => i !== st.bar).length;
  $('fillLabel').textContent = (diff ? `這個小節${diff > 0 ? '少' : '多'} ${beatsText(diff)} 拍` : '') + (others ? `${diff ? '，' : ''}${diff ? '另有' : '有'} ${others} 個小節拍數不符` : '');
  document.querySelectorAll('#durationBtns button').forEach(b => b.classList.toggle('on', Number(b.dataset.dur) === st.duration));
  $('dotBtn').classList.toggle('on', st.dotted); $('tripletBtn').classList.toggle('on', st.triplet); $('restBtn').classList.toggle('on', st.isRest);
  document.querySelectorAll('#techBtns button').forEach(b => {
    b.classList.toggle('on', !!st.tech?.[b.dataset.tech]);
    if (b.dataset.tech === 'bend') b.querySelector('span').textContent = st.tech?.bend ? `推弦 ${BEND_NAMES[st.tech.bendValue] || ''}` : '推弦';
  });
  const row = $('samePitchChoices'); row.replaceChildren();
  if (st.alternatives.length > 1) st.alternatives.forEach(a => {
    const b = document.createElement('button');
    b.textContent = `第 ${a.guitarString} 弦 ${a.fret} 格`; b.classList.toggle('on', a.current);
    b.title = '同一個音高改到這個位置';
    b.onclick = () => { if (!a.current) editor.moveNoteToString(a.string); };
    row.append(b);
  });
  if (st.dirty) setStatus('有未儲存的修改');
}
const editor = new TabEditor(api, $('alphaTab'), {
  onState: onEditorState,
  toast: msg => showToast(msg),
  isActive: () => $('scoreView').classList.contains('active') && $('helpModal').hidden,
  playPause: () => togglePlay()
});
const panels = initPanels({ api, editor, $, toast: showToast });
$('undoBtn').onclick = () => editor.undo();
// Drum pad: one button per kit piece, the same as number keys 1–0 on a drum track.
$('drumPad').append(...DRUM_KIT.map(p => { const b = document.createElement('button'); b.dataset.out = p.out; b.innerHTML = `<span>${p.name}</span><kbd>${p.key}</kbd>`; b.onclick = () => editor.toggleDrum(p.id); return b; }));
document.querySelectorAll('#inputModeBtns button').forEach(b => b.onclick = () => editor.setInputMode(b.dataset.input));
$('sharpBtn').onclick = () => editor.shiftPitch(1); $('flatBtn').onclick = () => editor.shiftPitch(-1);
$('octUpBtn').onclick = () => editor.shiftPitch(12); $('octDownBtn').onclick = () => editor.shiftPitch(-12);
$('selectBeatBtn').onclick = () => editor.selectBeat();
$('copyBtn').onclick = () => editor.copy(); $('cutBtn').onclick = () => editor.cut(); $('pasteBtn').onclick = () => editor.paste();
$('redoBtn').onclick = () => editor.redo();
document.querySelectorAll('#durationBtns button').forEach(b => b.onclick = () => editor.setDuration(Number(b.dataset.dur)));
document.querySelectorAll('#techBtns button').forEach(b => b.onclick = () => editor.technique(b.dataset.tech));
$('dotBtn').onclick = () => editor.toggleDot();
$('tripletBtn').onclick = () => editor.toggleTriplet();
$('restBtn').onclick = () => editor.makeRest();
$('insertBeatBtn').onclick = () => editor.insertBeat();
$('deleteBeatBtn').onclick = () => editor.deleteBeat();
$('insertBarBtn').onclick = () => editor.insertBarAfter();
$('deleteBarBtn').onclick = () => editor.deleteBar();
// Toolbar clicks must not steal keyboard focus from the score.
document.querySelector('.edit-dock').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
api.scoreLoaded.on(onScoreLoaded);
api.error.on(err => { console.error('alphaTab',err);setStatus('載入/播放失敗',true);showToast(`alphaTab: ${err?.message || '檔案無法讀取'}`); });
api.playerPositionChanged.on(e=>{
  const now=e.currentTime || 0, end=e.endTime||0;
  $('timeText').textContent=timeLabel(now);$('songDuration').textContent=timeLabel(end);
  if (end>0) $('seekBar').value=String(Math.round(now/end*1000));
});
api.playerStateChanged.on(e=>{ const on=e.state===alphaTab.synth.PlayerState.Playing; $('playBtn').classList.toggle('playing', on); document.body.classList.toggle('is-playing', on); });
api.playerReady.on(()=>setStatus('可播放 / 可編輯'));
function timeLabel(ms) { const n=Math.max(0,Math.floor(ms/1000));return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'); }
$('fitBtn').onclick=()=>{api.settings.display.scale = api.settings.display.scale>=1.2 ? 0.85 : +(api.settings.display.scale+0.1).toFixed(2);$('fitBtn').textContent=Math.round(api.settings.display.scale*100)+'%';api.updateSettings();api.render();};
$('trackSelect').onchange=()=>{if(!api.score)return;currentTrack=Number($('trackSelect').value);editor.setTrack(currentTrack);};
$('titleInput').onchange=()=>editor.apply(score=>{score.title=$('titleInput').value;},{needsStrings:false});
$('artistInput').onchange=()=>editor.apply(score=>{score.artist=$('artistInput').value;},{needsStrings:false});
// Playback starts from the edit cursor whenever the cursor was moved (or Stop was pressed) since the last start; otherwise it resumes.
function togglePlay() {
  if (api.playerState !== alphaTab.synth.PlayerState.Playing && editor.takePlayFromCursor()) {
    const tick = editor.cursorTick();
    if (tick !== null) api.tickPosition = tick;
  }
  api.playPause();
}
$('playBtn').onclick=()=>togglePlay();
$('stopBtn').onclick=()=>{api.stop();editor.requestPlayFromCursor();};
$('loopBtn').onclick=()=>{api.isLooping=!api.isLooping;$('loopBtn').classList.toggle('engaged',api.isLooping);showToast(api.isLooping?'已開啟整曲循環':'已關閉循環');};
$('seekBar').oninput=()=>{if(api.endTime)api.timePosition=api.endTime*Number($('seekBar').value)/1000;};
$('speedSlider').oninput=()=>{const speed=Number($('speedSlider').value)/100;api.playbackSpeed=speed;$('speedValue').textContent=Math.round(speed*100)+'%';};
$('openBtn').onclick=()=>$('fileInput').click();
$('fileInput').onchange=async e=>{if(e.target.files?.[0])await openFile(e.target.files[0]);e.target.value='';};
async function openFile(file) {
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());
    fileName=file.name; currentTrack=0;editor.cursor.track=0;
    if (/\.midi?$/i.test(file.name)) {
      const result=midiToAlphaTex(bytes,{title:file.name.replace(/\.midi?$/i,'')});
      const importer=new alphaTab.importer.AlphaTexImporter(); importer.initFromString(result.tex,api.settings);
      const score=importer.readScore();
      // Write the key into the score so numbered notation (簡譜) shows the right "1 =", and switch 簡譜 on.
      if(result.key) setKeySignature(score,0,result.key.sharps,result.key.minor);
      panels.view.numbered=true;
      editor.load(score);
      const kinds={drums:'鼓',guitar:'吉他',bass:'貝斯',score:'五線譜'};
      let note=`已匯入 ${result.tracks.length} 軌（${result.tracks.map(t=>`${t.name}：${kinds[t.kind]}`).join('、')}）。`;
      if(result.key) note+=`調性：${result.key.name}${result.key.fromFile?'（檔案內標示）':'（依音符推算，可在左側修改）'}。`;
      if(result.simplifiedChords) note+=`有 ${result.simplifiedChords} 個和弦在吉他上按不出來，省略了 ${result.droppedChordNotes} 個音。`;
      if(result.skippedDrums) note+=`${result.skippedDrums} 個鼓組裡沒有的打擊音沒有寫入。`;
      if(result.tempoChangeWarning) note+='曲中變速只用了第一個速度。';
      showToast(note);
    } else if (new RegExp(`\\.(${PROJECT_EXTENSIONS.join('|')})$`,'i').test(file.name)) { editor.load(importProject(new TextDecoder().decode(bytes), api.settings)); }
    else if (/\.(txt|alphatex)$/i.test(file.name)) {const tex=new TextDecoder().decode(bytes);$('alphaTexInput').value=tex;api.tex(tex);}
    else api.load(bytes);
    setView('score');
  } catch(err) {console.error(err);setStatus('檔案載入失敗',true);showToast(err.message||'檔案不支援');}
}
function newProject(){fileName='Untitled.gp';currentTrack=0;editor.cursor.track=0;api.tex(SAMPLE);$('alphaTexInput').value=SAMPLE;setView('score');}
$('newBtn').onclick=()=>{if(confirm('建立新譜會取代目前未儲存的修改。繼續？'))newProject();};
$('saveBtn').onclick=()=>{
  if(!api.score)return showToast('沒有可儲存的譜');
  try{
    const out=exportGuitarPro(api.score,api.settings);
    download(out.bytes,`${api.score.title||'Untitled'}.gp`);editor.markSaved();setStatus('已下載 .gp 檔');
    // Guitar Pro stores a bend as at most four points: say so instead of losing detail silently.
    if(out.approximated) showToast(`已存成 .gp。有 ${out.approximated} 個複雜的推弦／搖桿曲線超出 GP 格式的能力，已簡化成最接近的形狀。要完整保留請另外「儲存專案檔」。`);
  }catch(e){showToast('GP 匯出失敗：'+e.message);}
};
$('projectBtn').onclick=()=>{if(!api.score)return;try{download(exportProject(api.score),`${api.score.title||'Untitled'}.${PROJECT_EXTENSION}`,'application/json');editor.markSaved();setStatus('已下載專案檔');}catch(e){showToast('專案檔儲存失敗：'+e.message);}};
$('midiBtn').onclick=()=>{try{api.downloadMidi();}catch(e){showToast('MIDI 匯出失敗：'+e.message);}};
$('texBtn').onclick=()=>{if(!api.score)return;try{const ex=new alphaTab.exporter.AlphaTexExporter();const result=ex.export(api.score,api.settings);download(result,`${api.score.title||'Untitled'}.alphatex`,'text/plain');}catch(e){showToast('alphaTex 匯出失敗：'+e.message);}};
// Pictures and PDF of what is on screen (shown tracks and staves), rendered off screen at high resolution.
async function exportImages(kind){
  if(!api.score) return;
  const name=basename(api.score.title||'Untitled');
  const options={fontDirectory:`${import.meta.env.BASE_URL}font/`};
  setStatus('匯出中…');
  try{
    if(kind==='pdf'){ download(new Uint8Array(await (await exportPdf(api.score,editor.visibleTracks(),options)).arrayBuffer()),`${name}.pdf`,'application/pdf'); }
    else{
      const blobs=await exportPng(api.score,editor.visibleTracks(),{...options,transparent:kind==='clear',white:kind==='clear'&&$('pngWhite').checked});
      for(const [i,b] of blobs.entries()) download(new Uint8Array(await b.arrayBuffer()),`${name}${kind==='clear'?'-去背':''}${blobs.length>1?`-${i+1}`:''}.png`,'image/png');
      if(blobs.length>1) showToast(`譜比較長，分成 ${blobs.length} 張圖（在換行處切開）。`);
    }
    setStatus('已匯出');
  }catch(e){console.error(e);setStatus('匯出失敗',true);showToast('匯出失敗：'+e.message);}
}
$('pdfBtn').onclick=()=>exportImages('pdf');
$('pngBtn').onclick=()=>exportImages('png');
$('pngClearBtn').onclick=()=>exportImages('clear');
$('helpBtn').onclick=()=>$('helpModal').hidden=false;
$('closeHelp').onclick=()=>$('helpModal').hidden=true;
$('helpModal').onclick=e=>{if(e.target===$('helpModal'))$('helpModal').hidden=true;};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
$('sampleTexBtn').onclick=()=>$('alphaTexInput').value=SAMPLE;
$('composeApply').onclick=()=>{const t=$('alphaTexInput').value.trim();if(!t)return showToast('請先輸入 AlphaTex 譜');if(api.score&&!confirm('這會覆蓋目前的譜面，建議先儲存。繼續？'))return;fileName='ChatGPT score.gp';currentTrack=0;editor.cursor.track=0;api.tex(t);setView('score');};
initLive({
  $, toast: showToast, setStatus, hasScore: () => !!api.score, download,
  onTex: (tex, notes, warning = '') => {
    $('alphaTexInput').value = tex;
    fileName = 'Recorded.gp'; currentTrack = 0; editor.cursor.track = 0; api.tex(tex); setView('score');
    showToast(`已產生 ${notes.length} 個音符的譜。${warning || '音高是實測的，弦、格和技巧是推測的，請校對。'}`);
  }
});
// Browser drag/drop / keyboard shortcuts.
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer?.files?.[0])openFile(e.dataTransfer.files[0]);});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')$('helpModal').hidden=true;
  if((e.metaKey||e.ctrlKey)&&e.key==='o'){e.preventDefault();$('fileInput').click();}
  if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();$('saveBtn').click();}
});
$('alphaTexInput').value=SAMPLE;
api.tex(SAMPLE);

// Debug handle, development server only.
if (import.meta.env.DEV) window.__gs = { api, alphaTab, editor, openFile };
