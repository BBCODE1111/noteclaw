// Saving and loading. Two formats:
//  - Guitar Pro (.gp, GP7 layout) for exchange with other software. That format stores a bend or whammy
//    curve as at most four points, and alphaTab silently omits anything longer, so curves are reduced
//    first and the caller is told how many could not be kept exactly.
//  - NoteClaw project (.noteclaw): alphaTab's complete JSON model. Nothing is lost.
//    Files saved before the rename (.gstudio, format "guitar-studio") still open.
import * as alphaTab from '@coderline/alphatab';

type Score = alphaTab.model.Score;
type Point = alphaTab.model.BendPoint;
const { BendPoint, BendType, WhammyType, JsonConverter } = alphaTab.model;

/** Reduce a pitch curve to the origin / plateau / destination shape Guitar Pro can store. */
export function reduceCurve(points: Point[]): { points: Point[]; exact: boolean } {
  if (points.length <= 4 && (points.length < 4 || points[1].value === points[2].value)) return { points, exact: true };
  let pts = [...points];
  // A flat lead-in or tail carries no information beyond where it ends / starts.
  while (pts.length > 2 && pts[1].value === pts[0].value) pts.shift();
  while (pts.length > 2 && pts[pts.length - 2].value === pts[pts.length - 1].value) pts.pop();
  // Inside a flat stretch only its first and last point matter.
  pts = pts.filter((p, i) => i === 0 || i === pts.length - 1 || p.value !== pts[i - 1].value || p.value !== pts[i + 1].value);
  if (pts.length <= 4 && (pts.length < 4 || pts[1].value === pts[2].value)) return { points: pts, exact: true };
  // Too complex (e.g. bend–release–bend): keep start, the furthest excursion and the end.
  const origin = pts[0], destination = pts[pts.length - 1];
  const peak = pts.reduce((a, b) => (Math.abs(b.value - origin.value) > Math.abs(a.value - origin.value) ? b : a));
  const atPeak = pts.filter(p => p.value === peak.value);
  const m1 = atPeak[0], m2 = atPeak[atPeak.length - 1];
  const out = [origin, m1, m2, destination].filter((p, i, all) => all.indexOf(p) === i);
  return { points: out.map(p => new BendPoint(p.offset, p.value)), exact: false };
}

export interface GpExportReport { bytes: Uint8Array; simplified: number; approximated: number }
/** Export to Guitar Pro without touching the score being edited. */
export function exportGuitarPro(score: Score, settings: alphaTab.Settings): GpExportReport {
  const copy = JsonConverter.jsObjectToScore(JsonConverter.scoreToJsObject(score), settings);
  let simplified = 0, approximated = 0;
  const count = (exact: boolean) => { if (exact) simplified++; else approximated++; };
  for (const track of copy.tracks) for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
    if (beat.whammyBarPoints && beat.whammyBarType !== WhammyType.None) {
      const r = reduceCurve(beat.whammyBarPoints);
      if (r.points !== beat.whammyBarPoints) { beat.whammyBarPoints = r.points; beat.whammyBarType = WhammyType.Custom; count(r.exact); }
    }
    for (const note of beat.notes) {
      if (!note.bendPoints || note.bendType === BendType.None) continue;
      const r = reduceCurve(note.bendPoints);
      if (r.points !== note.bendPoints) { note.bendPoints = r.points; note.bendType = BendType.Custom; count(r.exact); }
    }
  }
  const prepared = simplified + approximated ? JsonConverter.jsObjectToScore(JsonConverter.scoreToJsObject(copy), settings) : copy;
  return { bytes: new alphaTab.exporter.Gp7Exporter().export(prepared, settings), simplified, approximated };
}

export const PROJECT_EXTENSION = 'noteclaw';
/** Extensions a project file may have, including the one used before the app was renamed. */
export const PROJECT_EXTENSIONS = ['noteclaw', 'gstudio'];
const FORMATS = ['noteclaw', 'guitar-studio'];
/** `media` names the video or audio the score is aligned to (the file itself is not stored). */
export function exportProject(score: Score, media: string | null = null): string {
  return JSON.stringify({ format: 'noteclaw', version: 1, ...(media ? { media } : {}), score: JSON.parse(JsonConverter.scoreToJson(score)) });
}
/** Name of the video or audio a project was aligned to, if any. */
export function projectMedia(text: string): string | null {
  try { const m = JSON.parse(text).media; return typeof m === 'string' ? m : null; } catch { return null; }
}
export function importProject(text: string, settings: alphaTab.Settings): Score {
  let data: { format?: string; score?: unknown };
  try { data = JSON.parse(text); } catch { throw new Error('這不是有效的 NoteClaw 專案檔'); }
  if (!FORMATS.includes(data.format ?? '') || !data.score) throw new Error('這不是 NoteClaw 專案檔');
  return JsonConverter.jsonToScore(JSON.stringify(data.score), settings);
}
