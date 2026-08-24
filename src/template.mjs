// Mirror of src/lib/printing/templates/kitchen-ticket.ts, in JS/ESM.
// Both files render identical bytes for the same payload.

import { EscPos, wrap } from "./escpos.mjs";

const DEFAULT_COLS = 48;

function formatHeader(p) {
  if (p.order_type === "takeout") return "PARA LLEVAR";
  if (p.order_type === "delivery") return "DELIVERY";
  if (p.table_label) return `MESA ${p.table_label}`;
  return "MESA -";
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mo} ${hh}:${mm}`;
  } catch { return iso; }
}

function formatMoney(amount, currency, usdSymbol = "$") {
  const fixed = currency === "USD" ? Number(amount).toFixed(2) : Math.round(Number(amount)).toString();
  const sym = currency === "USD" ? usdSymbol : currency === "VES" ? "Bs" : "$";
  return currency === "USD" ? `${sym}${fixed}` : `${fixed} ${sym}`;
}

function centerIn(s, width) {
  if (s.length >= width) return s.slice(0, width);
  const total = width - s.length;
  const left = Math.floor(total / 2);
  return " ".repeat(left) + s + " ".repeat(total - left);
}

// Mirror of bucketForKind / resolveLineToggles in src/lib/printing/print-settings.ts.
// Line visibility resolves per ticket KIND: `lines` is the shared base (all
// pre-split configs live there), `lines_comanda` / `lines_caja` layer on top.
function bucketForKind(kind) {
  return kind === "customer_ticket" ? "caja" : "comanda";
}

function resolveLineToggles(settings, kind) {
  const base = settings.lines ?? {};
  const over =
    bucketForKind(kind) === "caja" ? settings.lines_caja : settings.lines_comanda;
  if (!over) return base;
  const merged = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

export function renderKitchenTicket(p, cols = DEFAULT_COLS, settings = {}) {
  const COLS = Math.max(16, Math.round(cols) || DEFAULT_COLS);
  const COLS_BIG = Math.floor(COLS / 2);
  const esc = new EscPos();
  const L = resolveLineToggles(settings, p.kind);
  const usdSymbol = settings.usd_symbol ?? "$";

  // ----- Per-printer formatting (mirror of kitchen-ticket.ts) -----
  // Only emitted when non-default so an unconfigured printer prints
  // byte-identical to before.
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
  // Line spacing follows the text height when size != normal (see
  // kitchen-ticket.ts); normal keeps the printer default.
  const sizeControlsSpacing = bodyH !== 2;
  const lsStep = settings.line_spacing || 0;
  // Negative steps tighten below the printer default; feeds floored at 12
  // dots so escpos never falls back to ESC 2 (mirror of kitchen-ticket.ts).
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

  // ----- Logo (letterhead) -----
  // Mirror of the logo block in kitchen-ticket.ts: GS v 0 raster, centered
  // by zero-byte row padding to cols × 12 dots. Skip (don't clip) logos
  // wider than the paper; a corrupt raster must never kill a receipt.
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
            y * targetBytes + padLeft
          );
        }
        esc.align("left").raster(padded, targetBytes, p.logo.height).feed(1);
      }
    } catch {
      // ignore — fall through to the text-only ticket
    }
  }

  if (p.kind === "kitchen_modification") {
    esc.align("center");
    big({ bold: true });
    esc.line(p.modification_type === "cancelled" ? "ANULADO" : "AGREGADO");
    plain();
    esc.feed(1);
  } else if (p.kind === "test") {
    esc.align("center");
    big({ bold: true });
    esc.line("TEST");
    plain();
    esc.feed(1);
  } else if (p.kind === "customer_ticket" && L.caja_banner === true) {
    // Inverted default: the recibo banner only prints when explicitly enabled.
    esc.align("center");
    big({ bold: true });
    esc.line("CAJA / CLIENTE");
    plain();
    esc.feed(1);
  }

  const showOrdenNumero = L.orden_numero !== false;
  const showTipoOrden = L.tipo_orden !== false;
  if (showOrdenNumero || showTipoOrden) {
    esc.align("center");
    big({ bold: true });
    if (showOrdenNumero) esc.line(`ORDEN #${p.order_number}`);
    if (showTipoOrden) esc.line(formatHeader(p));
    plain();
    esc.feed(1);
  }

  // ----- Station header (158, mirror of kitchen-ticket.ts) -----
  if (L.estacion !== false && p.station_label) {
    esc.align("center");
    med({ bold: true });
    esc.line(`ESTACIÓN: ${p.station_label.toUpperCase()}`);
    plain();
    esc.feed(1);
  }

  esc.align("left");
  med();
  if (L.mesero !== false && p.waiter_name) {
    for (const ln of wrap(`Mesero: ${p.waiter_name}`, COLS)) esc.line(ln);
  }
  if (L.cliente !== false && p.customer_name && p.kind === "customer_ticket") {
    for (const ln of wrap(`Cliente: ${p.customer_name}`, COLS)) esc.line(ln);
  }
  if (L.hora !== false) {
    esc.line(`Hora: ${formatTime(p.created_at)}`);
  }
  plain();

  med();
  esc.rule(COLS);
  plain();

  // Section separators (158, mirror of kitchen-ticket.ts). Empty map when
  // `sections` is absent → byte-identical legacy loop.
  const sectionAt = new Map();
  for (const s of p.sections ?? []) sectionAt.set(s.index, s.label);
  const allItems = p.items ?? [];
  for (let itemIdx = 0; itemIdx < allItems.length; itemIdx++) {
    const item = allItems[itemIdx];
    if (sectionAt.has(itemIdx)) {
      const label = sectionAt.get(itemIdx) ?? null;
      med();
      esc.rule(COLS);
      plain();
      med({ bold: true });
      esc.line(label ? `ESTACIÓN: ${label.toUpperCase()}` : "SIN ESTACIÓN");
      plain();
    }
    const qty = `${item.quantity}x `;
    const wrapped = wrap(item.name, COLS - qty.length);
    const money =
      L.item_prices !== false && p.kind === "customer_ticket" && p.financials && item.line_total != null
        ? formatMoney(item.line_total, p.financials.currency, usdSymbol)
        : null;
    const first = qty + (wrapped[0] ?? "");
    // Price rides the name line when it fits; long names keep the historic
    // price-on-its-own-line fallback (mirror of kitchen-ticket.ts).
    const inline = money !== null && first.length + 1 + money.length <= COLS;
    med({ bold: true });
    if (inline) {
      esc.text(first);
      med();
      esc.line(" ".repeat(COLS - first.length - money.length) + money);
      if (wrapped.length > 1) med({ bold: true });
    } else {
      esc.line(first);
    }
    for (let i = 1; i < wrapped.length; i++) esc.line(" ".repeat(qty.length) + wrapped[i]);
    if (money !== null && !inline) {
      med();
      const pad = Math.max(1, COLS - money.length);
      esc.line(" ".repeat(pad) + money);
    }
    med();
    if (
      L.customizations !== false &&
      item.customizations &&
      item.customizations.length > 0
    ) {
      for (const c of item.customizations) {
        for (const ln of wrap(c, COLS - 2)) esc.line("  " + ln);
      }
    }
    if (L.item_notes !== false && item.notes && item.notes.trim()) {
      for (const ln of wrap(`Nota: ${item.notes.trim()}`, COLS - 2)) esc.line("  " + ln);
    }
    plain();
  }

  // ----- Other-stations hint (158, mirror of kitchen-ticket.ts) -----
  if (
    L.estacion !== false &&
    p.other_stations_units != null &&
    p.other_stations_units > 0
  ) {
    const n = p.other_stations_units;
    med();
    esc.line(
      n === 1
        ? "+ 1 artículo en otra estación"
        : `+ ${n} artículos en otras estaciones`
    );
    plain();
  }

  if (L.notes !== false && p.notes && p.notes.trim()) {
    med();
    esc.rule(COLS);
    plain();
    med({ bold: true });
    esc.line("NOTA:");
    plain();
    med();
    for (const ln of wrap(p.notes.trim(), COLS)) esc.line(ln);
    plain();
  }

  if (p.kind === "customer_ticket" && p.financials) {
    const f = p.financials;
    med();
    esc.rule(COLS);
    plain();

    if (L.subtotal !== false) {
      esc.align("left");
      med();
      const row = (label, value) => {
        const v = formatMoney(value, f.currency, usdSymbol);
        const pad = Math.max(1, COLS - label.length - v.length);
        esc.line(label + " ".repeat(pad) + v);
      };
      row("Subtotal", f.subtotal);
      if (f.delivery_fee && f.delivery_fee > 0) row("Delivery", f.delivery_fee);
      // Matches kitchen-ticket.ts exactly: the charged tip is labeled
      // "(sugerida)" when the restaurant runs the propina-sugerida setting.
      if (f.tip && f.tip > 0) {
        row(f.tip_is_suggested ? "Propina (sugerida)" : "Propina", f.tip);
      }
      if (f.adjustment && f.adjustment !== 0) {
        // Matches kitchen-ticket.ts exactly: an EMPTY note falls back to
        // "Ajuste" too (`?.slice() || "Ajuste"`), not to a blank label.
        row(f.adjustment_note?.slice(0, 16) || "Ajuste", f.adjustment);
      }
      if (f.iva_surcharge && f.iva_surcharge > 0) {
        row(
          (f.iva_surcharge_percent != null
            ? `Recargo IVA ${f.iva_surcharge_percent}%`
            : "Recargo IVA"
          ).slice(0, 16),
          f.iva_surcharge
        );
      }
      plain();
    }

    esc.align("center");
    big({ bold: true });
    const totalStr = formatMoney(f.total, f.currency, usdSymbol);
    esc.line(`TOTAL ${totalStr}`.slice(0, COLS_BIG));
    plain();

    // Impuestos incluidos (186) — disclosure rows INSIDE the total. Kept in
    // sync with kitchen-ticket.ts (both renderers consume the same payload).
    if (f.included_taxes && f.included_taxes.length > 0) {
      esc.align("left");
      med();
      for (const t of f.included_taxes) {
        const label = `Incluye ${t.label}`.slice(0, 20);
        const v = formatMoney(t.amount, f.currency, usdSymbol);
        const pad = Math.max(1, COLS - label.length - v.length);
        esc.line(label + " ".repeat(pad) + v);
      }
      plain();
    }

    // Propina sugerida (168) — optional block under the real total.
    if (
      L.propina_sugerida !== false &&
      f.suggested_tip != null &&
      f.suggested_tip > 0 &&
      f.total_with_suggested_tip != null
    ) {
      med();
      esc.rule(COLS);
      plain();
      esc.align("center");
      med({ bold: true });
      for (const ln of wrap("PROPINA SUGERIDA (OPCIONAL)", COLS)) esc.line(ln);
      plain();
      esc.align("left");
      med();
      const sugRow = (label, value) => {
        const v = formatMoney(value, f.currency, usdSymbol);
        const pad = Math.max(1, COLS - label.length - v.length);
        esc.line(label + " ".repeat(pad) + v);
      };
      sugRow(
        f.suggested_tip_percent != null
          ? `Propina ${f.suggested_tip_percent}%`.slice(0, 16)
          : "Propina",
        f.suggested_tip
      );
      plain();
      med({ bold: true });
      sugRow("TOTAL CON PROPINA", f.total_with_suggested_tip);
      plain();
    }

    // FORMA DE PAGO — how the customer actually paid (one row per tender).
    // Re-synced with kitchen-ticket.ts in 168: this section had been missing
    // here, so bridge-driven printers silently omitted it (and Vuelto).
    if (L.forma_de_pago !== false && f.payments && f.payments.length > 0) {
      med();
      esc.rule(COLS);
      plain();
      esc.align("center");
      med({ bold: true });
      esc.line("FORMA DE PAGO");
      plain();
      esc.align("left");
      med();
      for (const pay of f.payments) {
        const v = formatMoney(pay.amount, pay.currency, usdSymbol);
        // Reserve the value's width; wrap a long label across lines so the
        // amount never collides with it.
        const labelWidth = Math.max(1, COLS - v.length - 1);
        const wrapped = wrap(pay.label, labelWidth);
        const first = wrapped[0] ?? "";
        const pad = Math.max(1, COLS - first.length - v.length);
        esc.line(first + " ".repeat(pad) + v);
        for (let i = 1; i < wrapped.length; i++) esc.line(wrapped[i]);
      }
      if (f.change && f.change > 0) {
        const v = formatMoney(f.change, f.currency, usdSymbol);
        const label = "Vuelto";
        const pad = Math.max(1, COLS - label.length - v.length);
        esc.line(label + " ".repeat(pad) + v);
      }
      plain();
    }

    if (L.currency_table !== false && f.totals_by_currency && f.totals_by_currency.length > 0) {
      const order = ["USD", "VES", "COP"];
      const cells = order
        .map((cur) => f.totals_by_currency.find((t) => t.currency === cur))
        .filter(Boolean);

      // Second value row: same currencies, suggested tip included. Same gates
      // as the suggestion block above, and only when every column has a figure.
      const tipRow =
        L.propina_sugerida !== false &&
        f.suggested_tip != null &&
        f.suggested_tip > 0 &&
        f.totals_by_currency_with_tip
          ? cells.map((c) =>
              f.totals_by_currency_with_tip.find((t) => t.currency === c.currency)
            )
          : [];
      const withTip = tipRow.every((c) => !!c) ? tipRow : [];

      if (cells.length > 0) {
        med();
        esc.rule(COLS);
        plain();
        esc.align("center");
        med({ bold: true });
        esc.line("TOTAL EN MONEDAS");
        plain();

        const colWidth = Math.floor(COLS / cells.length);
        const valueRow = (row) =>
          row
            .map((c) => centerIn(formatMoney(c.amount, c.currency, usdSymbol), colWidth))
            .join("");
        esc.align("left");
        med({ bold: true });
        esc.line(cells.map((c) => centerIn(c.currency, colWidth)).join(""));
        if (withTip.length > 0) {
          med({ bold: true });
          esc.line("SIN PROPINA");
        }
        med();
        esc.line(valueRow(cells));
        if (withTip.length > 0) {
          med({ bold: true });
          esc.line(
            (f.suggested_tip_percent != null
              ? `CON PROPINA ${f.suggested_tip_percent}%`
              : "CON PROPINA"
            ).slice(0, COLS)
          );
          med();
          esc.line(valueRow(withTip));
        }
        plain();
      }
    }

    // The rate the Bs/COP figures above were computed at. Printed so the
    // customer's copy carries the quote, not just the result.
    if (f.rate_line) {
      esc.align("center");
      plain();
      esc.line(f.rate_line);
    }
  }

  if (L.restaurant_footer !== false) {
    med();
    esc.rule(COLS);
    plain();
    esc.align("center");
    med();
    for (const ln of wrap(p.restaurant_name, COLS)) esc.line(ln);
    plain();
  }

  esc.feed(settings.feed_before_cut ?? 3);
  esc.cut();
  return esc.build();
}
