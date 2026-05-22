// One fake fixed-pitch font. xterm and similar will ask QueryFont for any name
// we return; we always reply with these metrics. The values are *measured* at
// startup against the chosen CSS font so xterm's positioning matches what
// Canvas actually renders.
export const FONT = {
  charWidth: 8,
  charHeight: 16,
  ascent: 12,
  descent: 4,
  minChar: 32,
  maxChar: 126,
  defaultChar: 63,                  // '?'
  cssFont: '13px ui-monospace, "SF Mono", "Cascadia Code", "Source Code Pro", Menlo, monospace',
};

export const FAKE_FONT_NAMES = [
  'fixed', '6x13', '7x14', '8x13', '9x15', 'cursor',
];

// Measure the actual glyph advance + ascent/descent of cssFont once on load.
// Without this, our reported metrics drift from what Canvas paints and the
// cursor lands in the wrong column after long lines.
(function measureFont() {
  try {
    const off = new OffscreenCanvas(8, 32);
    const c = off.getContext('2d');
    if (!c) return;
    c.font = FONT.cssFont;
    const m = c.measureText('M');
    if (m.width > 0) FONT.charWidth = Math.ceil(m.width);
    const a = (m as TextMetrics).fontBoundingBoxAscent;
    const d = (m as TextMetrics).fontBoundingBoxDescent;
    if (typeof a === 'number' && typeof d === 'number' && a > 0 && d > 0) {
      FONT.ascent = Math.ceil(a);
      FONT.descent = Math.ceil(d);
      FONT.charHeight = FONT.ascent + FONT.descent;
    }
  } catch {
    /* keep defaults */
  }
})();
