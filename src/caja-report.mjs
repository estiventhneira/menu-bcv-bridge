// Mirror of src/lib/printing/templates/caja-report.ts, in JS/ESM.
// Both files render identical bytes for the same payload — see the byte-parity
// test in src/lib/printing/templates/caja-report.test.ts.

import { EscPos, wrap } from "./escpos.mjs";

const DEFAULT_COLS = 48;

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mo} ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

export function renderCajaReport(p, cols = DEFAULT_COLS, settings = {}) {
  const COLS = Math.max(16, Math.round(cols) || DEFAULT_COLS);
  const COLS_BIG = Math.floor(COLS / 2);
  const esc = new EscPos();

  if (settings.font === "intensa") esc.doubleStrike(true);
  if (settings.char_spacing && settings.char_spacing > 0) {
    esc.charSpacing(settings.char_spacing);
  }

  const bodyH =
    settings.text_size === "pequeno" ? 1
    : settings.text_size === "grande" ? 3
    : settings.text_size === "extra" ? 4
    : 2;
  const headH = Math.max(2, bodyH);
  const usesMagnify = bodyH > 2;

  const sizeControlsSpacing = bodyH !== 2;
  const lsStep = settings.line_spacing || 0;
  // Negative steps tighten below the printer default; feeds floored at 12
  // dots so escpos never falls back to ESC 2 (mirror of caja-report.ts).
  const lsFor = (hMul) => Math.max(12, 24 * hMul + 8 + lsStep * 12);
  if (!sizeControlsSpacing && lsStep !== 0) {
    esc.lineSpacing(Math.max(12, 48 + lsStep * 12));
  }

  const emphasis = (b = {}) => ({
    bold: b.bold || settings.bold_all,
    underline: b.underline,
    font: settings.font === "B" ? "B" : settings.font === "C" ? "C" : undefined,
  });
  const scaled = (widthMul, heightMul, b = {}) => {
    if (sizeControlsSpacing) esc.lineSpacing(lsFor(heightMul));
    if (heightMul <= 2 && widthMul <= 2) {
      esc.style({
        ...emphasis(b),
        doubleHeight: heightMul === 2,
        doubleWidth: widthMul === 2,
      });
    } else {
      esc.magnify(widthMul, heightMul);
      esc.style(emphasis(b));
    }
  };
  const med = (b = {}) => scaled(1, bodyH, b);
  const big = (b = {}) => scaled(2, headH, b);
  const plain = () => {
    if (usesMagnify) esc.magnify(1, 1);
    esc.style({});
  };

  if (p.logo?.data) {
    try {
      const bytes = new Uint8Array(Buffer.from(p.logo.data, "base64"));
      const bytesPerRow = Math.ceil(p.logo.width / 8);
      const targetBytes = Math.floor((COLS * 12) / 8);
      if (
        p.logo.height > 0 &&
        bytes.length === bytesPerRow * p.logo.height &&
        bytesPerRow <= targetBytes
      ) {
        const padLeft = Math.floor((targetBytes - bytesPerRow) / 2);
        const padded = new Uint8Array(targetBytes * p.logo.height);
        for (let y = 0; y < p.logo.height; y++) {
          padded.set(
            bytes.subarray(y * bytesPerRow, (y + 1) * bytesPerRow),
            y * targetBytes + padLeft,
          );
        }
        esc.align("left").raster(padded, targetBytes, p.logo.height).feed(1);
      }
    } catch {
      // ignore — fall through to the text-only report
    }
  }

  esc.align("center");
  big({ bold: true });
  for (const ln of wrap(p.restaurant_name, COLS_BIG)) esc.line(ln);
  esc.line(p.title.slice(0, COLS_BIG));
  plain();
  med({ bold: true });
  esc.line(p.status_label.slice(0, COLS));
  plain();
  esc.feed(1);

  esc.align("left");
  med();
  if (p.caja_number) esc.twoCol("Caja", `#${p.caja_number}`, COLS);
  esc.line(`Abrió: ${formatTime(p.opened_at)}`);
  if (p.opened_by) for (const ln of wrap(`  por ${p.opened_by}`, COLS)) esc.line(ln);
  if (p.closed_at) {
    esc.line(`Cerró: ${formatTime(p.closed_at)}`);
    if (p.closed_by) for (const ln of wrap(`  por ${p.closed_by}`, COLS)) esc.line(ln);
  }
  if (p.duration_label) esc.twoCol("Duración", p.duration_label, COLS);
  plain();

  for (const section of p.sections) {
    med();
    esc.rule(COLS);
    plain();
    esc.align("center");
    med({ bold: true });
    esc.line(section.title.slice(0, COLS));
    plain();
    esc.align("left");

    for (const row of section.rows) {
      if (row.t === "kv") {
        med(row.strong ? { bold: true } : {});
        esc.twoCol(row.label, row.value, COLS);
        plain();
      } else if (row.t === "note") {
        med();
        for (const ln of wrap(row.text, COLS)) esc.line(ln);
        plain();
      } else {
        const stacked = row.contado != null || row.diff != null;
        if (!stacked) {
          med(row.flag ? { bold: true } : {});
          esc.twoCol(row.label, row.esperado, COLS);
          plain();
          continue;
        }
        med(row.flag ? { bold: true } : {});
        esc.line(row.label.slice(0, COLS));
        plain();
        med();
        esc.twoCol("  Esperado", row.esperado, COLS);
        if (row.contado != null) esc.twoCol("  Contado", row.contado, COLS);
        plain();
        if (row.diff != null) {
          med(row.flag ? { bold: true } : {});
          esc.twoCol("  Diferencia", row.diff, COLS);
          plain();
        }
      }
    }
  }

  med();
  esc.rule(COLS);
  plain();
  esc.align("center");
  med();
  esc.line(`Impreso ${formatTime(p.printed_at)}`);
  for (const ln of wrap(p.restaurant_name, COLS)) esc.line(ln);
  plain();

  esc.feed(settings.feed_before_cut ?? 3);
  esc.cut();
  return esc.build();
}
