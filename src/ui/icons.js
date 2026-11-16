// Toolbar icons as inline SVG so they follow the button's text colour and stay sharp at any zoom.
// Note icons are drawn on a 24×32 grid, control icons on 24×24.
const svg = (w, h, body) =>
  `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const HEAD = '<ellipse cx="9" cy="25" rx="5.2" ry="3.6" transform="rotate(-22 9 25)" fill="currentColor" stroke="none"/>';
const HOLLOW = '<ellipse cx="9" cy="25" rx="4.5" ry="2.9" transform="rotate(-22 9 25)" stroke-width="1.9"/>';
const stem = top => `<path d="M13.7 24V${top}"/>`;
const flags = (count, top, step) =>
  Array.from({ length: count }, (_, i) => `<path d="M13.7 ${top + i * step}c1 4 6.2 4.6 5 10.2"/>`).join('');

export const ICONS = {
  n1: svg(24, 32, '<ellipse cx="12" cy="17" rx="6" ry="4" transform="rotate(-18 12 17)" stroke-width="2.6"/>'),
  n2: svg(24, 32, HOLLOW + stem(5)),
  n4: svg(24, 32, HEAD + stem(5)),
  n8: svg(24, 32, HEAD + stem(5) + flags(1, 5, 0)),
  n16: svg(24, 32, HEAD + stem(5) + flags(2, 5, 5)),
  n32: svg(24, 32, HEAD + stem(3) + flags(3, 3, 4.4)),
  dot: svg(24, 32, '<ellipse cx="9" cy="18" rx="5.2" ry="3.6" transform="rotate(-22 9 18)" fill="currentColor" stroke="none"/><circle cx="19" cy="17" r="2.1" fill="currentColor" stroke="none"/>'),
  triplet: svg(24, 32,
    '<path d="M3 12V8h5.5M21 12V8h-5.5" stroke-width="1.4"/><text x="12" y="11.5" font-size="10" font-weight="700" font-style="italic" text-anchor="middle" fill="currentColor" stroke="none">3</text>' +
    [5, 12, 19].map(x => `<circle cx="${x - 1.6}" cy="26" r="2.3" fill="currentColor" stroke="none"/><path d="M${x} 26V17" stroke-width="1.3"/>`).join('') +
    '<path d="M5 17h14" stroke-width="2.4" stroke-linecap="butt"/>'),
  rest: svg(24, 32, '<path d="M9.5 5 15 12Q10.5 15.5 15.5 21Q9 19 11.5 27" stroke-width="2.2"/>'),
  undo: svg(24, 24, '<path d="M9 6 4.5 10.5 9 15"/><path d="M5 10.5h9.5a4.5 4.5 0 0 1 0 9H11"/>'),
  redo: svg(24, 24, '<path d="M15 6l4.5 4.5L15 15"/><path d="M19 10.5H9.5a4.5 4.5 0 0 0 0 9H13"/>'),
  play: svg(24, 24, '<path d="M8 5v14l11.5-7z" fill="currentColor"/>'),
  pause: svg(24, 24, '<rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor"/>'),
  stop: svg(24, 24, '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6" fill="currentColor"/>'),
  loop: svg(24, 24, '<path d="M16.5 3.5 20 7l-3.5 3.5"/><path d="M4 11.5V10a3 3 0 0 1 3-3h13"/><path d="M7.5 20.5 4 17l3.5-3.5"/><path d="M20 12.5V14a3 3 0 0 1-3 3H4"/>')
};

/** Fill every element carrying data-icon with its SVG. */
export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const icon = ICONS[el.dataset.icon];
    if (icon && !el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', icon);
  });
}
