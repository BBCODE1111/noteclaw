// Export the score as pictures (PNG, transparent PNG) and as a PDF.
// The score is rendered a second time, off screen, with alphaTab's canvas engine at high resolution, so the
// export does not depend on the zoom or the size of the window, and the edit cursor never shows up in it.
import * as alphaTab from '@coderline/alphatab';

const A4 = 297 / 210;

/**
 * Render `score` (the given tracks) to canvases cut at line breaks, each at most `maxHeight` CSS pixels tall.
 * @returns {Promise<HTMLCanvasElement[]>}
 */
export async function renderPages(score, trackIndexes, { width = 1100, pixelRatio = 2, background = '#ffffff', ink = null, maxHeight = Infinity, fontDirectory, staves } = {}) {
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', left: '-20000px', top: '0', width: `${width}px`, background: 'transparent' });
  document.body.append(host);
  const copy = alphaTab.model.JsonConverter.jsObjectToScore(alphaTab.model.JsonConverter.scoreToJsObject(score), new alphaTab.Settings());
  if (staves) for (const t of copy.tracks) for (const s of t.staves) staves(s);
  const settings = new alphaTab.Settings();
  settings.fillFromJson({
    core: { engine: 'html5', fontDirectory, enableLazyLoading: false, useWorkers: false },
    display: { layoutMode: alphaTab.LayoutMode.Page },
    player: { enablePlayer: false },
    notation: { rhythmMode: alphaTab.TabRhythmMode.ShowWithBars, rhythmHeight: 22 }
  });
  const api = new alphaTab.AlphaTabApi(host, settings);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('匯出逾時')), 30000);
      api.postRenderFinished.on(() => { clearTimeout(timer); resolve(); });
      api.error.on(e => { clearTimeout(timer); reject(e); });
      api.renderScore(copy, trackIndexes);
    });
    const surface = host.querySelector('.at-surface');
    const fullHeight = surface.offsetHeight, fullWidth = surface.offsetWidth;
    // Cut only between lines of music.
    const systems = api.boundsLookup?.staffSystems ?? [];
    const breaks = [0];
    let pageTop = 0;
    for (const sys of systems) {
      const top = sys.visualBounds.y - 12, bottom = sys.visualBounds.y + sys.visualBounds.h + 12;
      if (bottom - pageTop > maxHeight && top > pageTop) { breaks.push(top); pageTop = top; }
    }
    breaks.push(fullHeight);
    const parts = [...surface.querySelectorAll('canvas')].map(c => ({ c, x: c.parentElement.offsetLeft + c.offsetLeft, y: c.parentElement.offsetTop + c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }));
    const pages = [];
    for (let i = 0; i + 1 < breaks.length; i++) {
      const top = breaks[i], height = Math.max(1, breaks[i + 1] - top);
      const out = document.createElement('canvas');
      out.width = Math.ceil(fullWidth * pixelRatio); out.height = Math.ceil(height * pixelRatio);
      const g = out.getContext('2d');
      if (background) { g.fillStyle = background; g.fillRect(0, 0, out.width, out.height); }
      for (const p of parts) if (p.y < top + height && p.y + p.h > top) g.drawImage(p.c, p.x * pixelRatio, (p.y - top) * pixelRatio, p.w * pixelRatio, p.h * pixelRatio);
      // Coloured ink (white notation for dark video). alphaTab's own colour settings are not applied reliably to
      // every section of a canvas render, so the finished picture is recoloured instead: every drawn pixel takes the
      // ink colour and keeps its transparency, which also keeps the edges smooth.
      if (ink && !background) {
        const img = g.getImageData(0, 0, out.width, out.height), d = img.data;
        for (let k = 0; k < d.length; k += 4) if (d[k + 3]) { d[k] = ink[0]; d[k + 1] = ink[1]; d[k + 2] = ink[2]; }
        g.putImageData(img, 0, 0);
      }
      pages.push(out);
    }
    return pages;
  } finally {
    api.destroy();
    host.remove();
  }
}

const toBlob = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

/** PNG pictures. Long scores come out as several files, cut between lines, so each stays a usable size. */
export async function exportPng(score, tracks, { transparent = false, white = false, fontDirectory, staves } = {}) {
  const pages = await renderPages(score, tracks, { width: 1400, pixelRatio: 2, background: transparent ? null : '#ffffff', ink: white ? [255, 255, 255] : null, maxHeight: 2400, fontDirectory, staves });
  return Promise.all(pages.map(toBlob));
}

/** A4 PDF, one image per page at print resolution. */
export async function exportPdf(score, tracks, { fontDirectory, staves } = {}) {
  const width = 1000;
  const pages = await renderPages(score, tracks, { width, pixelRatio: 2.5, background: '#ffffff', maxHeight: width * A4 - 40, fontDirectory, staves });
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const margin = 10, usable = 210 - margin * 2;
  pages.forEach((page, i) => {
    if (i) pdf.addPage();
    const h = usable * page.height / page.width;
    pdf.addImage(page.toDataURL('image/png'), 'PNG', margin, margin, usable, h, undefined, 'FAST');
  });
  return pdf.output('blob');
}
