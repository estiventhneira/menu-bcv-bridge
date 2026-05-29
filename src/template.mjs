// Mirror of src/lib/printing/templates/kitchen-ticket.ts, in JS/ESM.
// Both files render identical bytes for the same payload.

import { EscPos, wrap } from "./escpos.mjs";

const COLS = 48;
const COLS_BIG = 24;

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

function formatMoney(amount, currency) {
  const fixed = currency === "USD" ? Number(amount).toFixed(2) : Math.round(Number(amount)).toString();
  const sym = currency === "USD" ? "$" : currency === "VES" ? "Bs" : "$";
  return currency === "USD" ? `${sym}${fixed}` : `${fixed} ${sym}`;
}

function centerIn(s, width) {
  if (s.length >= width) return s.slice(0, width);
  const total = width - s.length;
  const left = Math.floor(total / 2);
  return " ".repeat(left) + s + " ".repeat(total - left);
}

export function renderKitchenTicket(p) {
  const esc = new EscPos();
  const BIG = { doubleHeight: true, doubleWidth: true };
  const MED = { doubleHeight: true };

  if (p.kind === "kitchen_modification") {
    esc.align("center").style({ bold: true, ...BIG });
    esc.line(p.modification_type === "cancelled" ? "ANULADO" : "AGREGADO");
    esc.style({}).feed(1);
  } else if (p.kind === "test") {
    esc.align("center").style({ bold: true, ...BIG });
    esc.line("TEST");
    esc.style({}).feed(1);
  } else if (p.kind === "customer_ticket") {
    esc.align("center").style({ bold: true, ...BIG });
    esc.line("CAJA / CLIENTE");
    esc.style({}).feed(1);
  }

  esc.align("center").style({ bold: true, ...BIG });
  esc.line(`ORDEN #${p.order_number}`);
  esc.line(formatHeader(p));
  esc.style({}).feed(1);

  esc.align("left").style({ ...MED });
  if (p.waiter_name) {
    for (const ln of wrap(`Mesero: ${p.waiter_name}`, COLS)) esc.line(ln);
  }
  if (p.customer_name && p.kind === "customer_ticket") {
    for (const ln of wrap(`Cliente: ${p.customer_name}`, COLS)) esc.line(ln);
  }
  esc.line(`Hora: ${formatTime(p.created_at)}`);
  esc.style({});

  esc.style({ ...MED }).rule(COLS).style({});

  for (const item of p.items ?? []) {
    esc.style({ bold: true, ...MED });
    const qty = `${item.quantity}x `;
    const wrapped = wrap(item.name, COLS - qty.length);
    esc.line(qty + (wrapped[0] ?? ""));
    for (let i = 1; i < wrapped.length; i++) esc.line(" ".repeat(qty.length) + wrapped[i]);
    if (p.kind === "customer_ticket" && p.financials && item.line_total != null) {
      const money = formatMoney(item.line_total, p.financials.currency);
      esc.style({ ...MED });
      const pad = Math.max(1, COLS - money.length);
      esc.line(" ".repeat(pad) + money);
    }
    esc.style({ ...MED });
    for (const c of item.customizations ?? []) {
      for (const ln of wrap(c, COLS - 2)) esc.line("  " + ln);
    }
    if (item.notes && item.notes.trim()) {
      for (const ln of wrap(`Nota: ${item.notes.trim()}`, COLS - 2)) esc.line("  " + ln);
    }
    esc.style({});
  }

  if (p.notes && p.notes.trim()) {
    esc.style({ ...MED }).rule(COLS).style({});
    esc.style({ bold: true, ...MED }).line("NOTA:").style({});
    esc.style({ ...MED });
    for (const ln of wrap(p.notes.trim(), COLS)) esc.line(ln);
    esc.style({});
  }

  if (p.kind === "customer_ticket" && p.financials) {
    const f = p.financials;
    esc.style({ ...MED }).rule(COLS).style({});

    esc.align("left").style({ ...MED });
    const row = (label, value) => {
      const v = formatMoney(value, f.currency);
      const pad = Math.max(1, COLS - label.length - v.length);
      esc.line(label + " ".repeat(pad) + v);
    };
    row("Subtotal", f.subtotal);
    if (f.delivery_fee && f.delivery_fee > 0) row("Delivery", f.delivery_fee);
    if (f.tip && f.tip > 0) row("Propina", f.tip);
    if (f.adjustment && f.adjustment !== 0) {
      row((f.adjustment_note ?? "Ajuste").slice(0, 16), f.adjustment);
    }
    esc.style({});

    esc.align("center").style({ bold: true, ...BIG });
    const totalStr = formatMoney(f.total, f.currency);
    esc.line(`TOTAL ${totalStr}`.slice(0, COLS_BIG));
    esc.style({});

    if (f.totals_by_currency && f.totals_by_currency.length > 0) {
      const order = ["USD", "VES", "COP"];
      const cells = order
        .map((cur) => f.totals_by_currency.find((t) => t.currency === cur))
        .filter(Boolean);

      if (cells.length > 0) {
        esc.style({ ...MED }).rule(COLS).style({});
        esc.align("center").style({ bold: true, ...MED });
        esc.line("TOTAL EN MONEDAS");
        esc.style({});

        const colWidth = Math.floor(COLS / cells.length);
        esc.align("left").style({ bold: true, ...MED });
        esc.line(cells.map((c) => centerIn(c.currency, colWidth)).join(""));
        esc.style({ ...MED });
        esc.line(
          cells
            .map((c) => centerIn(formatMoney(c.amount, c.currency), colWidth))
            .join("")
        );
        esc.style({});
      }
    }
  }

  esc.style({ ...MED }).rule(COLS).style({});
  esc.align("center").style({ ...MED });
  for (const ln of wrap(p.restaurant_name, COLS)) esc.line(ln);
  esc.style({});

  esc.feed(3);
  esc.cut();
  return esc.build();
}
