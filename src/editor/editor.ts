// Tab editor: an edit cursor on the rendered score, keyboard entry, and undo/redo.
// All score changes go through `apply()`, which snapshots, mutates via ops.ts, normalizes and re-renders.
import * as alphaTab from '@coderline/alphatab';
import * as ops from './ops.ts';
import type { Cursor, Technique } from './ops.ts';

type Score = alphaTab.model.Score;

export interface EditorState {
  editable: boolean;
  bar: number; barCount: number; beat: number; beatCount: number;
  guitarString: number; stringCount: number;
  pitch: number | null; fret: number | null;
  duration: number; dotted: boolean; triplet: boolean; isRest: boolean;
  tech: ReturnType<typeof ops.techniqueState> | null;
  alternatives: { string: number; guitarString: number; fret: number; current: boolean }[];
  fill: { used: number; total: number };
  badBars: number[];
  canUndo: boolean; canRedo: boolean; dirty: boolean;
  song: { tempo: number; key: number; minor: boolean; tsNum: number; tsDen: number };
  text: string; chord: string;
  tracks: TrackInfo[];
  view: { tab: boolean; standard: boolean; numbered: boolean };
  drums: boolean; drumHits: number[];
  /** Number of beats selected as a block (0 = editing single notes). */
  selected: number;
  inputMode: InputMode;
  canPaste: boolean;
}
export type InputMode = 'fret' | 'numbered';
export interface TrackInfo {
  index: number; name: string; program: number; volume: number; mute: boolean; solo: boolean;
  visible: boolean; active: boolean; strings: number; percussion: boolean; tuning: number[]; capo: number;
}
export interface EditorHooks {
  /** Called whenever the cursor or score changes so the toolbar can refresh. */
  onState(state: EditorState): void;
  toast(message: string): void;
  /** Keyboard editing only happens while this returns true (score view visible, no dialog open). */
  isActive(): boolean;
  playPause(): void;
}

const TECH_KEYS: Record<string, Technique> = {
  KeyH: 'hammer', KeyS: 'slide', KeyB: 'bend', KeyV: 'vibrato', KeyP: 'palmMute',
  KeyL: 'letRing', KeyX: 'dead', KeyN: 'harmonic', KeyT: 'tap', KeyG: 'ghost'
};

const KEY_FALLBACK: Record<string, string> = { '-': 'Minus', '_': 'Minus', '=': 'Equal', '+': 'Equal', '.': 'Period', '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight' };

export class TabEditor {
  cursor: Cursor = { track: 0, bar: 0, beat: 0, string: 6 };
  dirty = false;
  private api: alphaTab.AlphaTabApi;
  private host: HTMLElement;
  private hooks: EditorHooks;
  private history = new ops.History();
  private ownScore: Score | null = null;
  private overlay: HTMLDivElement;
  private beatEl: HTMLDivElement;
  private cursorEl: HTMLDivElement;
  private lastDigit: { key: string; time: number; value: number } | null = null;
  private revealCursor = false;
  private badEl: HTMLDivElement;
  private playFromCursor = false;
  private visible = new Set<number>([0]);
  /** Note value used when writing into an untouched bar: the last value the player worked with. */
  private inputDuration = 4;
  /** Block selection: from `anchor` to the cursor, whole beats. Null = editing single notes. */
  private anchor: ops.Pos | null = null;
  private selEl: HTMLDivElement;
  private clipboard: Map<string, unknown>[] = [];
  inputMode: InputMode = 'fret';

  constructor(api: alphaTab.AlphaTabApi, host: HTMLElement, hooks: EditorHooks) {
    this.api = api; this.host = host; this.hooks = hooks;
    this.overlay = document.createElement('div'); this.overlay.className = 'gs-overlay';
    this.beatEl = document.createElement('div'); this.beatEl.className = 'gs-beat';
    this.cursorEl = document.createElement('div'); this.cursorEl.className = 'gs-cursor';
    this.badEl = document.createElement('div');
    this.selEl = document.createElement('div');
    this.overlay.append(this.badEl, this.selEl, this.beatEl, this.cursorEl);
    api.scoreLoaded.on(score => { if (score !== this.ownScore) this.reset(score); });
    api.postRenderFinished.on(() => { this.ensureOverlay(); this.drawBadBars(); this.draw(); this.emit(); });
    host.addEventListener('mousedown', e => this.onMouseDown(e));
    document.addEventListener('keydown', e => this.onKeyDown(e));
  }

  /** True when this score object was produced by an edit rather than opened from a file. */
  isOwn(score: Score): boolean { return score === this.ownScore; }

  private reset(score: Score): void {
    this.history.clear();
    this.dirty = false;
    this.lastDigit = null;
    const track = Math.min(this.cursor.track, score.tracks.length - 1);
    const strings = score.tracks[track].staves[0].tuning.length || 6;
    this.cursor = ops.clampCursor(score, { track, bar: 0, beat: 0, string: strings });
    this.visible = new Set([this.cursor.track]);
    this.anchor = null;
  }
  // ---- playback position ----
  /** Tick where the beat under the cursor starts, for starting playback there. */
  cursorTick(): number | null {
    const score = this.api.score; if (!score) return null;
    return ops.beatOf(score, ops.clampCursor(score, this.cursor))?.absolutePlaybackStart ?? null;
  }
  requestPlayFromCursor(): void { this.playFromCursor = true; }
  /** True once after the cursor was moved or Stop was pressed; the caller then starts playback at the cursor. */
  takePlayFromCursor(): boolean { const v = this.playFromCursor; this.playFromCursor = false; return v; }

  markSaved(): void { this.dirty = false; this.emit(); }

  /** Make a track the one being edited (it is shown if it was hidden). */
  setTrack(track: number): void {
    const score = this.api.score; if (!score) return;
    this.cursor = ops.clampCursor(score, { ...this.cursor, track, string: 99 });
    this.visible.add(this.cursor.track);
    this.lastDigit = null; this.anchor = null;
    this.revealCursor = true;
    this.renderVisible(score);
  }
  /** Show or hide a track in the score. The track being edited always stays visible. */
  toggleVisible(track: number): void {
    const score = this.api.score; if (!score) return;
    if (this.visible.has(track)) { if (track === this.cursor.track) return; this.visible.delete(track); }
    else this.visible.add(track);
    this.renderVisible(score);
  }
  /** Tracks currently shown in the score (what an export should contain). */
  visibleTracks(): number[] { const score = this.api.score; return score ? this.visibleIndexes(score) : []; }
  private visibleIndexes(score: Score): number[] {
    const list = [...this.visible].filter(i => i < score.tracks.length).sort((a, b) => a - b);
    return list.length ? list : [this.cursor.track];
  }
  private renderVisible(score: Score): void {
    this.api.renderTracks(this.visibleIndexes(score).map(i => score.tracks[i]));
  }
  /** Replace the whole score with one loaded from a file. */
  load(score: Score): void { this.ownScore = null; this.cursor.track = 0; this.api.renderScore(score, [0]); }
  /** Re-render after a display-only change (which staves are shown). */
  refresh(): void { this.api.render(); }

  // ---- editing pipeline ----
  /** Run a model mutation as one undoable step. The mutation may return a new cursor. */
  apply(mutate: (score: Score, cursor: Cursor) => Cursor | void, options: { coalesce?: boolean; needsStrings?: boolean | 'strings' } = {}): boolean {
    const score = this.api.score;
    if (!score) return false;
    const need = options.needsStrings === false ? 'any' : options.needsStrings === 'strings' ? 'strings' : 'writable';
    if (need === 'writable' && !ops.isWritable(score, this.cursor.track)) { this.hooks.toast('這個軌道目前不能編輯（只有弦樂器和鼓組可以）'); return false; }
    if (need === 'strings' && !ops.isEditable(score, this.cursor.track)) {
      this.hooks.toast(ops.isDrums(score, this.cursor.track) ? '鼓組軌請用數字鍵 1–0 輸入鼓點' : '這個軌道不是弦樂器，無法用六線譜編輯'); return false;
    }
    const before = { data: ops.serialize(score), cursor: { ...this.cursor } };
    let next: Cursor | void;
    try { next = mutate(score, this.cursor); }
    catch (err) { this.hooks.toast((err as Error).message); return false; }
    if (next) this.cursor = next;
    if (options.coalesce) this.history.dropLast();
    this.history.record(before);
    this.dirty = true;
    this.show(ops.normalize(score, this.api.settings).score);
    return true;
  }
  /** Like `apply`, for edits that rebuild the score data directly (paste). */
  private applyData(build: (score: Score, cursor: Cursor) => Map<string, unknown>): boolean {
    const score = this.api.score; if (!score) return false;
    const before = { data: ops.serialize(score), cursor: { ...this.cursor } };
    let data: Map<string, unknown>;
    try { data = build(score, this.cursor); } catch (err) { this.hooks.toast((err as Error).message); return false; }
    this.history.record(before);
    this.dirty = true;
    this.show(ops.normalize(ops.deserialize(data, this.api.settings), this.api.settings).score);
    return true;
  }
  /** Run an edit on every selected beat, or on the cursor when nothing is selected. */
  private applyEach(fn: (score: Score, c: Cursor, first: boolean) => void, options: { needsStrings?: boolean | 'strings' } = {}): void {
    const list = this.selection();
    if (!list) { this.apply((s, c) => { fn(s, c, true); }, options); return; }
    this.apply((s, c) => { list.forEach((p, i) => fn(s, { ...c, bar: p.bar, beat: p.beat, string: -1 }, i === 0)); }, options);
  }
  /** The selected beats, or null when editing single notes. */
  private selection(): ops.Pos[] | null {
    const score = this.api.score;
    return score && this.anchor ? ops.beatsBetween(score, this.cursor.track, this.anchor, this.cursor) : null;
  }
  // ---- block selection and clipboard ----
  selectBeat(): void { this.anchor = { bar: this.cursor.bar, beat: this.cursor.beat }; this.draw(); this.emit(); }
  clearSelection(): void { if (!this.anchor) return; this.anchor = null; this.draw(); this.emit(); }
  selectAll(): void {
    const score = this.api.score; if (!score) return;
    const last = score.masterBars.length - 1;
    this.anchor = { bar: 0, beat: 0 };
    this.cursor = ops.clampCursor(score, { ...this.cursor, bar: last, beat: 999 });
    this.draw(); this.emit();
  }
  copy(): boolean {
    const score = this.api.score; if (!score) return false;
    const list = this.selection() ?? [{ bar: this.cursor.bar, beat: this.cursor.beat }];
    this.clipboard = ops.copyBeats(score, this.cursor.track, list);
    this.hooks.toast(`已複製 ${list.length} 拍`); this.emit();
    return true;
  }
  cut(): void {
    const list = this.selection() ?? [{ bar: this.cursor.bar, beat: this.cursor.beat }];
    if (!this.copy()) return;
    const first = list[0];
    this.apply((s, c) => { ops.deleteBeats(s, c.track, list); return { ...c, bar: first.bar, beat: first.beat }; });
    this.anchor = null;
  }
  paste(): void {
    if (!this.clipboard.length) { this.hooks.toast('剪貼簿是空的，先選取拍子再按 ⌘C'); return; }
    const score = this.api.score; if (!score) return;
    if (!ops.isWritable(score, this.cursor.track)) return;
    const pasted = this.clipboard.length;
    this.anchor = null;
    if (this.applyData((s, c) => ops.pasteBeats(s, c, this.clipboard))) {
      const now = this.api.score!;
      // Select what was pasted so it can be moved on or changed at once.
      this.anchor = { bar: this.cursor.bar, beat: ops.isBlankBar(score, this.cursor) ? 0 : this.cursor.beat };
      const end = ops.beatsBetween(now, this.cursor.track, this.anchor, { bar: now.masterBars.length - 1, beat: 999 })[pasted - 1];
      if (end) this.cursor = { ...this.cursor, bar: end.bar, beat: end.beat };
      this.draw(); this.emit();
    }
  }
  private show(score: Score): void {
    this.ownScore = score;
    this.cursor = ops.clampCursor(score, this.cursor);
    this.revealCursor = true;
    this.visible.add(this.cursor.track);
    this.api.renderScore(score, this.visibleIndexes(score));
  }
  undo(): void { this.travel(true); }
  redo(): void { this.travel(false); }
  private travel(back: boolean): void {
    const score = this.api.score; if (!score) return;
    const current = { data: ops.serialize(score), cursor: { ...this.cursor } };
    const entry = back ? this.history.undo(current) : this.history.redo(current);
    if (!entry) { this.hooks.toast(back ? '沒有可以復原的步驟' : '沒有可以重做的步驟'); return; }
    this.cursor = entry.cursor;
    this.dirty = true;
    this.lastDigit = null;
    this.show(ops.deserialize(entry.data, this.api.settings));
  }

  // ---- commands used by the toolbar and the keyboard ----
  setInputMode(mode: InputMode): void { this.inputMode = mode; this.lastDigit = null; this.emit(); }
  /** A number key: a fret, a 簡譜 degree, or a drum, depending on the track and the input mode. */
  typeDigit(digit: number): void {
    const score = this.api.score; if (!score) return;
    if (ops.isDrums(score, this.cursor.track)) {
      const piece = ops.DRUM_KIT.find(p => p.key === String(digit));
      if (piece) this.toggleDrum(piece.id);
      return;
    }
    if (this.inputMode === 'numbered') {
      if (digit === 0) { this.makeRest(); return; }
      if (digit > 7) { this.hooks.toast('簡譜只有 1 到 7'); return; }
      this.apply((s, c) => ops.enterDegree(s, c, digit, this.inputDuration), { needsStrings: 'strings' });
      return;
    }
    this.typeFret(digit);
  }
  toggleDrum(id: number): void {
    const piece = ops.DRUM_KIT.find(p => p.id === id); if (!piece) return;
    this.apply((s, c) => ops.toggleDrum(s, c, piece, this.inputDuration));
  }
  shiftPitch(semitones: number): void {
    const list = this.selection();
    if (!list) { this.apply((s, c) => ops.shiftPitch(s, c, semitones), { needsStrings: 'strings' }); return; }
    this.apply((s, c) => { for (const p of list) { const at = { ...c, bar: p.bar, beat: p.beat, string: -1 }; if (ops.beatOf(s, at).notes.length) ops.shiftPitch(s, at, semitones); } }, { needsStrings: 'strings' });
  }
  typeFret(digit: number): void {
    const key = `${this.cursor.track}:${this.cursor.bar}:${this.cursor.beat}:${this.cursor.string}`;
    const now = performance.now();
    const last = this.lastDigit;
    const combined = last && last.key === key && now - last.time < 1000 && last.value > 0 ? last.value * 10 + digit : -1;
    const merge = combined >= 0 && combined <= ops.MAX_FRET;
    const fret = merge ? combined : digit;
    const ok = this.apply((s, c) => ops.setFret(s, c, fret, merge ? 0 : this.inputDuration), { coalesce: merge, needsStrings: 'strings' });
    this.lastDigit = ok && !merge ? { key, time: now, value: digit } : null;
  }
  setDuration(duration: number): void { this.inputDuration = duration; this.applyEach((s, c) => ops.setDuration(s, c, duration)); }
  // ---- song, annotations, tracks ----
  setTempo(bpm: number): void { this.apply(s => ops.setTempo(s, bpm), { needsStrings: false }); }
  setKey(key: number, minor: boolean): void { this.apply((s, c) => ops.setKeySignature(s, c.bar, key, minor), { needsStrings: false }); }
  setTimeSignature(n: number, d: number): void { this.apply((s, c) => ops.setTimeSignature(s, c.bar, n, d), { needsStrings: false }); }
  setText(text: string): void { this.apply((s, c) => ops.setBeatText(s, c, text)); }
  setChord(name: string): void { this.apply((s, c) => ops.setChordName(s, c, name)); }
  addTrack(kind: ops.TrackKind): void {
    this.apply((s, c) => { const i = ops.addTrack(s, kind); this.visible.add(i); return { track: i, bar: c.bar, beat: 0, string: 99 }; }, { needsStrings: false });
  }
  deleteTrack(index: number): void {
    this.apply((s, c) => {
      ops.deleteTrack(s, index);
      this.visible = new Set([...this.visible].filter(i => i !== index).map(i => (i > index ? i - 1 : i)));
      return { ...c, track: c.track > index ? c.track - 1 : Math.min(c.track, s.tracks.length - 1), beat: 0, string: 99 };
    }, { needsStrings: false });
  }
  setProgram(track: number, program: number): void { this.apply(s => ops.setProgram(s, track, program), { needsStrings: false }); }
  setTrackVolume(track: number, volume: number): void { this.apply(s => ops.setTrackVolume(s, track, volume), { needsStrings: false }); }
  setTuning(track: number, pitches: number[], keepPitch: boolean): void {
    let result = { dropped: 0, moved: 0 };
    const ok = this.apply((s, c) => { result = ops.setTuning(s, track, pitches, keepPitch); return { ...c, string: Math.min(c.string, pitches.length) }; }, { needsStrings: false });
    if (!ok) return;
    const notes = [result.moved && `${result.moved} 個音換到別條弦`, result.dropped && `${result.dropped} 個音彈不到、已移除`].filter(Boolean);
    this.hooks.toast(notes.length ? `已換調弦：${notes.join('，')}（⌘Z 可復原）` : '已換調弦');
  }
  setCapo(track: number, fret: number): void { this.apply(s => ops.setCapo(s, track, fret), { needsStrings: false }); }
  renameTrack(track: number, name: string): void { this.apply(s => { s.tracks[track].name = name.trim() || s.tracks[track].name; }, { needsStrings: false }); }
  /** Solo / mute act on the player immediately and are stored with the track; they are not undo steps. */
  setMute(track: number, mute: boolean): void { this.mix(track, t => { t.playbackInfo.isMute = mute; this.api.changeTrackMute([t], mute); }); }
  setSolo(track: number, solo: boolean): void { this.mix(track, t => { t.playbackInfo.isSolo = solo; this.api.changeTrackSolo([t], solo); }); }
  private mix(track: number, fn: (t: alphaTab.model.Track) => void): void {
    const t = this.api.score?.tracks[track]; if (!t) return;
    fn(t); this.dirty = true; this.emit();
  }
  /** Re-apply stored solo / mute to the player; it forgets them whenever the MIDI is regenerated. */
  syncMixer(): void {
    const score = this.api.score; if (!score) return;
    for (const t of score.tracks) { this.api.changeTrackMute([t], t.playbackInfo.isMute); }
    for (const t of score.tracks) if (t.playbackInfo.isSolo) this.api.changeTrackSolo([t], true);
  }
  /** Tick range covering bars `from`..`to` inclusive, for loop playback. */
  barRange(from: number, to: number): { startTick: number; endTick: number } | null {
    const score = this.api.score; if (!score) return null;
    const a = score.masterBars[Math.min(from, to)], b = score.masterBars[Math.max(from, to)];
    return a && b ? { startTick: a.start, endTick: b.start + b.calculateDuration() } : null;
  }
  stepDuration(shorter: boolean): void { this.applyEach((s, c) => ops.stepDuration(s, c, shorter)); }
  toggleDot(): void { let on = false; this.applyEach((s, c, first) => { if (first) on = ops.beatOf(s, c).dots === 0; const b = ops.beatOf(s, c); b.dots = on ? 1 : 0; }); }
  toggleTriplet(): void { let on = false; this.applyEach((s, c, first) => { if (first) on = !ops.beatOf(s, c).hasTuplet; if (ops.beatOf(s, c).hasTuplet !== on) ops.toggleTriplet(s, c); }); }
  makeRest(): void { this.applyEach((s, c) => ops.makeRest(s, c)); }
  technique(t: Technique): void {
    const list = this.selection();
    if (!list) { this.apply((s, c) => ops.toggleTechnique(s, c, t), { needsStrings: 'strings' }); return; }
    // One decision for the whole block: on unless every selected note already has it.
    this.apply((s, c) => {
      const spots = list.map(p => ({ ...c, bar: p.bar, beat: p.beat, string: -1 })).filter(at => ops.beatOf(s, at).notes.length);
      if (!spots.length) throw new Error('選取的範圍裡沒有音符');
      const on = !spots.every(at => ops.techniqueState(s, at)[t]);
      spots.forEach(at => ops.toggleTechnique(s, at, t, on));
    }, { needsStrings: 'strings' });
  }
  /** Delete: the note under the cursor, or in a block selection every note of every selected beat. */
  deleteAtCursor(): void {
    const list = this.selection();
    if (!list) { this.apply((s, c) => ops.deleteAtCursor(s, c)); return; }
    this.apply((s, c) => {
      // Already all rests: remove the beats themselves.
      if (list.every(p => ops.beatOf(s, { ...c, ...p }).notes.length === 0)) { ops.deleteBeats(s, c.track, list); this.anchor = null; return { ...c, ...list[0] }; }
      ops.clearBeats(s, c.track, list);
    });
  }
  deleteBeat(): void {
    const list = this.selection();
    if (!list) { this.apply((s, c) => ops.deleteBeat(s, c)); return; }
    this.apply((s, c) => { ops.deleteBeats(s, c.track, list); return { ...c, ...list[0] }; });
    this.anchor = null;
  }
  insertBeat(): void { this.apply((s, c) => ops.insertBeat(s, c)); }
  insertBarAfter(): void {
    this.apply((s, c) => { ops.insertBar(s, c.bar + 1, ops.beatOf(s, c).duration); return { ...c, bar: c.bar + 1, beat: 0 }; }, { needsStrings: false });
  }
  deleteBar(): void { this.apply((s, c) => { ops.deleteBar(s, c.bar); return { ...c, beat: 0 }; }, { needsStrings: false }); }
  moveNoteToString(modelString: number): void { this.apply((s, c) => ops.moveNoteToString(s, c, modelString), { needsStrings: 'strings' }); }
  addDrumTrack(): void {
    this.apply((s, c) => { const i = ops.addDrumTrack(s); this.visible.add(i); return { track: i, bar: c.bar, beat: 0, string: 1 }; }, { needsStrings: false });
  }

  private move(dx: number, dy: number, extend = false): void {
    const score = this.api.score; if (!score || !ops.isWritable(score, this.cursor.track)) return;
    this.lastDigit = null;
    if (extend && !this.anchor) this.anchor = { bar: this.cursor.bar, beat: this.cursor.beat };
    if (!extend && dx) this.anchor = null;
    if (dy) { if (ops.isDrums(score, this.cursor.track)) return; this.cursor = ops.moveString(score, this.cursor, dy > 0); }
    else if (dx < 0) { this.cursor = ops.moveLeft(score, this.cursor); }
    else {
      // Moving right may extend the bar or the score; that case is an undoable edit.
      const probe = ops.moveRight(ops.deserialize(ops.serialize(score), this.api.settings), this.cursor);
      if (probe.changed && !extend) { this.apply((s, c) => ops.moveRight(s, c).cursor); return; }
      if (probe.changed) return; // a selection stops at the end of what is written
      this.cursor = probe.cursor;
    }
    this.revealCursor = true;
    this.playFromCursor = true;
    this.draw(); this.emit();
  }

  // ---- input ----
  private onKeyDown(e: KeyboardEvent): void {
    if (!this.hooks.isActive() || !this.api.score) return;
    const target = e.target as HTMLElement | null;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    const mod = e.metaKey || e.ctrlKey;
    const code = e.code || KEY_FALLBACK[e.key] || '';
    if (mod) {
      const shortcuts: Record<string, () => void> = {
        KeyZ: () => (e.shiftKey ? this.redo() : this.undo()), KeyC: () => this.copy(), KeyX: () => this.cut(), KeyV: () => this.paste(), KeyA: () => this.selectAll()
      };
      if (shortcuts[code]) { e.preventDefault(); shortcuts[code](); }
      return;
    }
    if (e.altKey) return;
    // `code` is layout-independent and still works while a Chinese input method is active;
    // the typed character is the fallback where a keyboard does not report one.
    const digit = /^(Digit|Numpad)(\d)$/.exec(code);
    const drums = ops.isDrums(this.api.score, this.cursor.track);
    let handled = true;
    if (digit && !e.shiftKey) this.typeDigit(Number(digit[2]));
    else if (code === 'ArrowLeft') this.move(-1, 0, e.shiftKey);
    else if (code === 'ArrowRight') this.move(1, 0, e.shiftKey);
    else if (code === 'ArrowUp') { if (e.shiftKey) this.shiftPitch(12); else this.move(0, 1); }
    else if (code === 'ArrowDown') { if (e.shiftKey) this.shiftPitch(-12); else this.move(0, -1); }
    else if (code === 'BracketRight') this.shiftPitch(1);
    else if (code === 'BracketLeft') this.shiftPitch(-1);
    else if (code === 'Escape') this.clearSelection();
    else if (code === 'Enter') this.selectBeat();
    else if (code === 'Backspace' || code === 'Delete') { if (e.shiftKey) this.deleteBeat(); else this.deleteAtCursor(); }
    else if (code === 'Minus' || code === 'NumpadSubtract') this.stepDuration(false);
    else if (code === 'Equal' || code === 'NumpadAdd') this.stepDuration(true);
    else if (code === 'Period' || code === 'NumpadDecimal') this.toggleDot();
    else if (code === 'Slash') this.toggleTriplet();
    else if (code === 'KeyR') this.makeRest();
    else if (code === 'KeyI' || code === 'Insert') this.insertBeat();
    else if (code === 'Space') this.hooks.playPause();
    else if (!drums && TECH_KEYS[code]) this.technique(TECH_KEYS[code]);
    else handled = false;
    if (handled) e.preventDefault();
  }

  private surface(): HTMLElement | null { return this.host.querySelector<HTMLElement>('.at-surface'); }
  private ensureOverlay(): void { if (this.overlay.parentElement !== this.host) this.host.append(this.overlay); }

  /** The tablature bar bounds for a bar of the edited staff (the lowest one when notation is also shown). */
  private tabBarBounds(masterBar: alphaTab.rendering.MasterBarBounds, staff: alphaTab.model.Staff) {
    const own = masterBar.bars.filter(b => b.bar.staff === staff);
    return own.length ? own.reduce((a, b) => (b.visualBounds.y > a.visualBounds.y ? b : a)) : null;
  }

  /** Line spacing of the edited staff: strings on tablature, the five lines on a drum staff. */
  private lineGap(staff: alphaTab.model.Staff, height: number): number {
    return height / Math.max((staff.isPercussion ? 5 : staff.tuning.length) - 1, 1);
  }
  /**
   * Click on a string: edit that one note. Click above or below the lines (on the stems and beams): select the
   * whole beat, i.e. every note in it. Shift-click: select every beat from the cursor to here.
   */
  private onMouseDown(e: MouseEvent): void {
    const score = this.api.score, lookup = this.api.boundsLookup, surface = this.surface();
    if (!score || !lookup || !surface) return;
    const rect = surface.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    // The edited track is checked first; clicking another visible track switches to it.
    const order = [this.cursor.track, ...this.visibleIndexes(score).filter(i => i !== this.cursor.track)];
    for (const track of order) {
      if (!ops.isWritable(score, track)) continue;
      const staff = score.tracks[track].staves[0];
      for (const system of lookup.staffSystems) for (const mb of system.bars) {
        const bar = this.tabBarBounds(mb, staff); if (!bar) continue;
        const v = bar.visualBounds, gap = this.lineGap(staff, v.h);
        const reach = staff.isPercussion ? gap * 3 : gap * 2.6;
        if (y < v.y - reach || y > v.y + v.h + reach || x < mb.realBounds.x || x > mb.realBounds.x + mb.realBounds.w) continue;
        const beat = bar.findBeatAtPos(x)?.beat;
        if (!beat || beat.voice.index !== 0) return;
        const outside = y < v.y - gap * 0.6 || y > v.y + v.h + gap * 0.6;
        // Snap to a note of this beat when the click is near one, so the number does not have to be hit exactly.
        const raw = (v.y + v.h - y) / gap + 1;
        const near = staff.isPercussion ? null : beat.notes.reduce<alphaTab.model.Note | null>((best, n) => (Math.abs(n.string - raw) < 0.9 && (!best || Math.abs(n.string - raw) < Math.abs(best.string - raw)) ? n : best), null);
        const string = staff.isPercussion ? 1 : near ? near.string : Math.round(raw);
        const switched = track !== this.cursor.track;
        const from = { bar: this.cursor.bar, beat: this.cursor.beat };
        this.cursor = ops.clampCursor(score, { track, bar: beat.voice.bar.index, beat: beat.index, string: outside ? this.cursor.string : string });
        if (e.shiftKey && !switched) this.anchor = this.anchor ?? from;
        else this.anchor = outside ? { bar: this.cursor.bar, beat: this.cursor.beat } : null;
        this.lastDigit = null;
        this.playFromCursor = true;
        if (switched) this.drawBadBars();
        this.draw(); this.emit();
        return;
      }
    }
  }

  // ---- cursor drawing ----
  private draw(): void {
    const score = this.api.score, lookup = this.api.boundsLookup, surface = this.surface();
    if (!score || !lookup || !surface || !ops.isWritable(score, this.cursor.track)) { this.overlay.hidden = true; return; }
    this.cursor = ops.clampCursor(score, this.cursor);
    const staff = ops.staffOf(score, this.cursor);
    const drums = staff.isPercussion;
    const column = (p: ops.Pos) => {
      const beat = staff.bars[p.bar]?.voices[0].beats[p.beat];
      const found = beat ? lookup.findBeats(beat) : null;
      if (!found?.length) return null;
      const bounds = found.reduce((a, b) => (b.barBounds.visualBounds.y > a.barBounds.visualBounds.y ? b : a));
      const v = bounds.barBounds.visualBounds;
      return { bounds, v, gap: this.lineGap(staff, v.h) };
    };
    const here = column(this.cursor);
    if (!here) { this.overlay.hidden = true; return; }
    const { bounds, v, gap } = here;
    const y = v.y + v.h - (this.cursor.string - 1) * gap;
    const noteBounds = drums ? null : bounds.notes?.find(n => n.note.string === this.cursor.string)?.noteHeadBounds;
    const x = noteBounds ? noteBounds.x + noteBounds.w / 2 : bounds.onNotesX;
    const w = Math.max(noteBounds ? noteBounds.w + 8 : 0, gap * 1.5), h = gap * 1.25;
    this.overlay.hidden = false;
    this.overlay.style.left = `${surface.offsetLeft}px`;
    this.overlay.style.top = `${surface.offsetTop}px`;
    const block = !!this.anchor;
    // Single-note editing shows the note box; block selection and drums show whole beats.
    this.cursorEl.hidden = block || drums;
    Object.assign(this.cursorEl.style, { left: `${x - w / 2}px`, top: `${y - h / 2}px`, width: `${w}px`, height: `${h}px` });
    Object.assign(this.beatEl.style, { left: `${x - w / 2 - 2}px`, top: `${v.y - gap * 0.75}px`, width: `${w + 4}px`, height: `${v.h + gap * 1.5}px` });
    this.beatEl.classList.toggle('strong', block || drums);
    this.selEl.replaceChildren();
    if (block) {
      for (const p of ops.beatsBetween(score, this.cursor.track, this.anchor!, this.cursor)) {
        const col = column(p); if (!col) continue;
        const r = col.bounds.realBounds, el = document.createElement('div');
        el.className = 'gs-sel';
        Object.assign(el.style, { left: `${r.x}px`, top: `${col.v.y - col.gap * 0.9}px`, width: `${Math.max(r.w, 10)}px`, height: `${col.v.h + col.gap * 1.8}px` });
        this.selEl.append(el);
      }
    }
    if (this.revealCursor) { this.revealCursor = false; this.reveal(); }
  }
  /** Scroll just enough to keep the cursor away from the edges of the score panel. */
  private reveal(): void {
    const scroller = this.host.closest<HTMLElement>('.score-scroll');
    if (!scroller) return;
    const view = scroller.getBoundingClientRect(), box = this.beatEl.getBoundingClientRect();
    const top = view.top + 56, bottom = view.bottom - 56;
    const delta = box.top < top ? box.top - top : box.bottom > bottom ? box.bottom - bottom : 0;
    if (delta) scroller.scrollBy({ top: delta, behavior: 'instant' });
  }

  /** Outline every bar whose beats do not add up to its time signature, with how much is missing or extra. */
  private drawBadBars(): void {
    this.badEl.replaceChildren();
    const score = this.api.score, lookup = this.api.boundsLookup;
    if (!score || !lookup || !ops.isWritable(score, this.cursor.track)) return;
    const staff = ops.staffOf(score, this.cursor);
    const gap = (h: number) => this.lineGap(staff, h);
    for (const index of ops.badBars(score, this.cursor.track)) {
      const mb = lookup.findMasterBarByIndex(index);
      const bar = mb ? this.tabBarBounds(mb, staff) : null;
      if (!mb || !bar) continue;
      const v = bar.visualBounds, pad = gap(v.h) * 0.7;
      const fill = ops.barFill(score, this.cursor.track, index);
      const diff = fill.total - fill.used;
      const box = document.createElement('div'); box.className = 'gs-badbar';
      Object.assign(box.style, { left: `${mb.visualBounds.x}px`, top: `${v.y - pad}px`, width: `${mb.visualBounds.w}px`, height: `${v.h + pad * 2}px` });
      const label = document.createElement('span');
      label.textContent = `${diff > 0 ? '少' : '多'} ${+(Math.abs(diff) / 960).toFixed(2)} 拍`;
      box.append(label);
      this.badEl.append(box);
    }
  }

  state(): EditorState | null {
    const score = this.api.score; if (!score) return null;
    const c = this.cursor = ops.clampCursor(score, this.cursor);
    const editable = ops.isWritable(score, c.track);
    const drums = ops.isDrums(score, c.track);
    const strings = ops.isEditable(score, c.track);
    const beat = ops.beatOf(score, c);
    const staff = ops.staffOf(score, c);
    const count = staff.tuning.length;
    const note = strings ? ops.noteAt(score, c) : null;
    const bar = ops.barOf(score, c), mb = score.masterBars[c.bar];
    if (!beat.isRest) this.inputDuration = beat.duration;
    return {
      editable, bar: c.bar, barCount: score.masterBars.length, beat: c.beat, beatCount: ops.beatsOf(score, c).length,
      guitarString: strings ? ops.guitarString(count, c.string) : 0, stringCount: count,
      pitch: note ? ops.openPitch(staff, note.string) + note.fret : null, fret: note ? note.fret : null,
      duration: beat.duration, dotted: beat.dots > 0, triplet: beat.hasTuplet, isRest: beat.isRest,
      tech: strings ? ops.techniqueState(score, c) : null,
      alternatives: strings && !this.anchor ? ops.alternatePositions(score, c).map(a => ({ ...a, guitarString: ops.guitarString(count, a.string) })) : [],
      fill: ops.barFill(score, c.track, c.bar), badBars: ops.badBars(score, c.track),
      canUndo: this.history.canUndo, canRedo: this.history.canRedo, dirty: this.dirty,
      song: { tempo: score.tempo, key: bar.keySignature, minor: bar.keySignatureType === 1, tsNum: mb.timeSignatureNumerator, tsDen: mb.timeSignatureDenominator },
      text: beat.text ?? '', chord: ops.chordNameAt(score, c),
      tracks: score.tracks.map((t, index) => ({
        index, name: t.name || `Track ${index + 1}`, program: t.playbackInfo.program, volume: t.playbackInfo.volume,
        mute: t.playbackInfo.isMute, solo: t.playbackInfo.isSolo, visible: this.visible.has(index), active: index === c.track,
        strings: t.staves[0].tuning.length, percussion: t.staves[0].isPercussion,
        tuning: [...t.staves[0].tuning], capo: t.staves[0].capo
      })),
      view: { tab: staff.showTablature, standard: staff.showStandardNotation, numbered: staff.showNumbered },
      drums, drumHits: drums ? ops.drumHits(score, c) : [],
      selected: this.selection()?.length ?? 0, inputMode: this.inputMode, canPaste: this.clipboard.length > 0
    };
  }
  private emit(): void { const s = this.state(); if (s) this.hooks.onState(s); }
}
