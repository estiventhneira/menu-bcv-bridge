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
    ["«", 0xae], ["»", 0xaf], ["€", 0xd5],
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
    if (s.bold) n |= 0b0000_1000;
    if (s.doubleHeight) n |= 0b0001_0000;
    if (s.doubleWidth) n |= 0b0010_0000;
    if (s.underline) n |= 0b1000_0000;
    return this.push(ESC, 0x21, n);
  }
  text(s) { return this.push(...encodeText(s)); }
  line(s = "") { if (s) this.text(s); return this.push(LF); }
  feed(n = 1) { for (let i = 0; i < n; i++) this.push(LF); return this; }
  rule(chars, ch = "-") { return this.line(ch.repeat(chars)); }
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
