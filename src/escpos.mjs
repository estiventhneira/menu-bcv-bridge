// Mirror of src/lib/printing/escpos.ts, ported to ESM/JS.
// Kept in sync manually — both files implement the same byte sequence.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const CODEPAGE_PC858 = 19;

const PC858_MAP = (() => {
  const map = Object.create(null);
  for (let i = 0x20; i <= 0x7e; i++) map[String.fromCharCode(i)] = i;
  const ext = [
    ["Ç", 0x80], ["ü", 0x81], ["é", 0x82], ["â", 0x83], ["ä", 0x84],
    ["à", 0x85], ["å", 0x86], ["ç", 0x87], ["ê", 0x88], ["ë", 0x89],
    ["è", 0x8a], ["ï", 0x8b], ["î", 0x8c], ["ì", 0x8d], ["Ä", 0x8e],
    ["Å", 0x8f], ["É", 0x90], ["æ", 0x91], ["Æ", 0x92], ["ô", 0x93],
    ["ö", 0x94], ["ò", 0x95], ["û", 0x96], ["ù", 0x97], ["ÿ", 0x98],
    ["Ö", 0x99], ["Ü", 0x9a], ["ø", 0x9b], ["£", 0x9c], ["Ø", 0x9d],
    ["á", 0xa0], ["í", 0xa1], ["ó", 0xa2], ["ú", 0xa3], ["ñ", 0xa4],
    ["Ñ", 0xa5], ["ª", 0xa6], ["º", 0xa7], ["¿", 0xa8], ["¡", 0xad],
    ["«", 0xae], ["»", 0xaf], ["€", 0xd5], ["·", 0xfa],
    // Uppercase accented vowels (synced from escpos.ts): station names go
    // through .toUpperCase() on split comandas (158), and "CAFÉ"/"MARISCOS
    // FRÍOS" must render on bridge printers too, not as "?".
    ["Á", 0xb5], ["Â", 0xb6], ["À", 0xb7], ["Ê", 0xd2], ["Ë", 0xd3],
    ["È", 0xd4], ["Í", 0xd6], ["Î", 0xd7], ["Ï", 0xd8], ["Ì", 0xde],
    ["Ó", 0xe0], ["Ô", 0xe2], ["Ò", 0xe3], ["Ú", 0xe9], ["Û", 0xea],
    ["Ù", 0xeb],
    [" ", 0x20], ["\n", 0x0a], ["\t", 0x09], ["\r", 0x0d],
  ];
  for (const [ch, code] of ext) map[ch] = code;
  return map;
})();

const ASCII_FALLBACK = {
  "—": "-", "–": "-", "−": "-",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "…": "...", "•": "*", "·": ".", "→": "->", "←": "<-",
};

function encodeText(text) {
  const out = [];
  for (const ch of text) {
    let code = PC858_MAP[ch];
    if (code === undefined) {
      const fb = ASCII_FALLBACK[ch];
      if (fb !== undefined) {
        for (const fc of fb) out.push(PC858_MAP[fc] ?? 0x3f);
        continue;
      }
      code = 0x3f;
    }
    out.push(code);
  }
  return out;
}

export class EscPos {
  constructor() { this.bytes = []; this.init(); }
  push(...b) { for (const x of b) this.bytes.push(x & 0xff); return this; }
  init() { this.push(ESC, 0x40); this.push(ESC, 0x74, CODEPAGE_PC858); return this; }
  align(a) {
    const n = a === "center" ? 1 : a === "right" ? 2 : 0;
    return this.push(ESC, 0x61, n);
  }
  style(s = {}) {
    let n = 0;
    if (s.font === "B") n |= 0b0000_0001;
    if (s.bold) n |= 0b0000_1000;
    if (s.doubleHeight) n |= 0b0001_0000;
    if (s.doubleWidth) n |= 0b0010_0000;
    if (s.underline) n |= 0b1000_0000;
    this.push(ESC, 0x21, n);
    // ESC ! reselects font A/B (bit 0), so font C must be re-asserted with
    // ESC M 2 after every style change (mirror of escpos.ts).
    if (s.font === "C") this.push(ESC, 0x4d, 2);
    return this;
  }
  // ESC G n — double-strike (darker print). Unaffected by ESC ! n.
  doubleStrike(on) { return this.push(ESC, 0x47, on ? 1 : 0); }
  // ESC SP n — right-side character spacing in dots (0..255).
  charSpacing(dots) {
    return this.push(ESC, 0x20, Math.max(0, Math.min(255, Math.round(dots))));
  }
  // ESC 3 n / ESC 2 — line spacing (n/180") or font default.
  lineSpacing(dots) {
    if (dots > 0) return this.push(ESC, 0x33, Math.min(255, Math.round(dots)));
    return this.push(ESC, 0x32);
  }
  // GS ! n — character magnification, w/h in 1..8 (high/low nibble).
  magnify(w, h) {
    const cw = Math.max(1, Math.min(8, Math.round(w)));
    const ch = Math.max(1, Math.min(8, Math.round(h)));
    return this.push(GS, 0x21, ((cw - 1) << 4) | (ch - 1));
  }
  text(s) { return this.push(...encodeText(s)); }
  line(s = "") { if (s) this.text(s); return this.push(LF); }
  feed(n = 1) { for (let i = 0; i < n; i++) this.push(LF); return this; }
  rule(chars, ch = "-") { return this.line(ch.repeat(chars)); }
  // Two-column line: label flush-left, value flush-right, padded to `width`.
  twoCol(label, value, width) {
    const v = value.slice(0, Math.max(0, width - 1));
    const maxLabel = Math.max(0, width - v.length - 1);
    const l = label.length > maxLabel ? label.slice(0, maxLabel - 1) + "…" : label;
    const pad = width - l.length - v.length;
    return this.line(l + " ".repeat(Math.max(1, pad)) + v);
  }
  // GS v 0 — raster bit image (1-bit rows, MSB first, 1 = black dot).
  // Loop (not spread): data can be several KB.
  raster(data, widthBytes, height) {
    this.push(
      GS, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
    );
    for (let i = 0; i < data.length; i++) this.bytes.push(data[i] & 0xff);
    return this;
  }
  cut() { return this.push(GS, 0x56, 0x01); }
  build() { return Buffer.from(this.bytes); }
}

export function wrap(text, width) {
  const lines = [];
  for (const para of text.split("\n")) {
    if (para.length <= width) { lines.push(para); continue; }
    const words = para.split(/(\s+)/);
    let cur = "";
    for (const w of words) {
      if ((cur + w).length <= width) cur += w;
      else if (w.length > width) {
        if (cur) lines.push(cur);
        cur = "";
        for (let i = 0; i < w.length; i += width) lines.push(w.slice(i, i + width));
      } else {
        lines.push(cur.trimEnd());
        cur = w.trimStart();
      }
    }
    if (cur) lines.push(cur.trimEnd());
  }
  return lines;
}
