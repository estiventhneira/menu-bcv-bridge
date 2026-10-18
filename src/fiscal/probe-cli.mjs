// `print-bridge fiscal-probe [PORT]` (bridge 0.9.0) — read a máquina fiscal's
// identity for the hardware checklist (design 2026-10-07). Sends ONLY ENQ,
// SV, S1 and S3: safe on a fiscalized unit (spec §11). Without a port it
// lists the serial ports it can see.

import { createHkaSession } from "./hka-session.mjs";
import { probeMachine } from "./hka-invoice.mjs";
import { listSerialPorts, openSerialLink } from "./serial-link.mjs";

/**
 * @param {string[]} args
 * @param {{ out?: (line: string) => void }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runFiscalProbe(args, opts = {}) {
  const out = opts.out ?? ((line) => console.log(line));
  const port = args.find((a) => !a.startsWith("-"));
  if (!port) {
    const ports = await listSerialPorts();
    out(ports.length ? "Puertos seriales:" : "No se encontraron puertos seriales.");
    for (const p of ports) out(`  ${p.path}  ${p.name}${p.vid ? `  (USB ${p.vid}:${p.pid})` : ""}`);
    out("Uso: print-bridge fiscal-probe <PUERTO>   (solo lee: ENQ, SV, S1, S3)");
    return ports.length ? 0 : 1;
  }

  let link;
  try {
    link = await openSerialLink(port);
  } catch (e) {
    out(`No se pudo abrir ${port}: ${e.message}`);
    return 1;
  }
  const session = createHkaSession(link);
  try {
    const r = await probeMachine(session);
    if (!r.ok) {
      out(`La máquina no respondió: ${r.message}`);
      return 1;
    }
    const s = r.status;
    out(`Modelo: ${r.model} (${r.model === "ZZP" ? "ACLAS PP9-PLUS" : "no es PP9-PLUS"})  País: ${r.country}`);
    out(`Registro: ${r.s1.registro}   RIF: ${r.s1.rif}`);
    out(`Modo: ${s.mode === "fiscal" ? "fiscal" : "entrenamiento"}   Estado: STS1=0x${s.sts1.toString(16)} STS2=0x${s.sts2.toString(16)}${s.message ? ` (${s.message})` : ""}`);
    out(`Última factura: ${r.s1.lastFactura}   Última NC: ${r.s1.lastNotaCredito}   Último DNF: ${r.s1.lastNoFiscal}`);
    out(`Contadores S1 campo 10 / 11: ${r.s1.fmReportCounter} / ${r.s1.zCounter}  (el bridge lee el 11 como contador de Z)`);
    out(`Fecha/hora: ${r.s1.date} ${r.s1.time}`);
    out(`Tasas: ${r.s3.rates.map((x, i) => `T${i + 1} ${x.bp / 100}% tipo ${x.type}`).join("  ")}${r.s3.igtf ? `  IGTF ${r.s3.igtf.bp / 100}%` : ""}`);
    out(`Banderas: 21=${r.s3.flags[21]}  50=${r.s3.flags[50]}  63=${r.s3.flags[63]}`);
    return 0;
  } finally {
    await session.close();
  }
}
