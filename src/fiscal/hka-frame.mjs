// HKA fiscal protocol — framing (bridge 0.9.0, máquina fiscal host).
//
// The Factory HKA printers (ACLAS PP9-PLUS) speak frames of
//   STX | DATA | ETX | LRC      LRC = XOR(every DATA byte, ETX)
// at 9600 8E1 over a virtual COM port (spec §1-2,
// docs/plans/2026-09-26-fiscal-printer-hka-protocol.md). DATA is single-byte
// ISO-8859-1: several command bytes are Latin-1 code points, so text is NEVER
// encoded as UTF-8 here.

export const STX = 0x02;
export const ETX = 0x03;
export const EOT = 0x04;
export const ENQ = 0x05;
export const ACK = 0x06;
export const NAK = 0x15;
export const ETB = 0x17;
export const LF = 0x0a;

/**
 * XOR of the data bytes and the closing byte (ETX, or ETB on multi-block
 * reads). STX is excluded.
 * @param {Uint8Array | number[]} data
 * @param {number} [end]
 */
export function lrc(data, end = ETX) {
  let x = end;
  for (const b of data) x ^= b;
  return x & 0xff;
}

/** @param {Uint8Array | number[]} data */
export function buildFrame(data) {
  const out = new Uint8Array(data.length + 3);
  out[0] = STX;
  out.set(data, 1);
  out[data.length + 1] = ETX;
  out[data.length + 2] = lrc(data, ETX);
  return out;
}

// Characters outside Latin-1 that show up in menus and names. Anything else
// outside Latin-1 loses its accents (NFD) or becomes "?".
const TRANSLIT = new Map([
  ["‘", "'"], ["’", "'"], ["‚", "'"], ["“", '"'], ["”", '"'],
  ["„", '"'], ["–", "-"], ["—", "-"], ["…", "..."], ["€", "EUR"],
  ["•", "-"], [" ", " "],
]);

/**
 * Text safe to put inside a frame: one line, Latin-1 only, no control bytes
 * (they would end or corrupt the frame, spec §2.3) and no `|` (the item-code
 * delimiter), trimmed to `max` characters.
 * @param {unknown} text
 * @param {number} max
 */
export function sanitizeText(text, max) {
  let s = typeof text === "string" ? text : text == null ? "" : String(text);
  let out = "";
  for (const ch of s.replace(/[\r\n\t]+/g, " ")) {
    const code = ch.codePointAt(0) ?? 0;
    if (TRANSLIT.has(ch)) {
      out += TRANSLIT.get(ch);
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) || ch === "|") {
      // control bytes (C0, DEL, C1) and the code delimiter
    } else if (code <= 0xff) {
      out += ch;
    } else {
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      out += [...base].every((c) => (c.codePointAt(0) ?? 0) <= 0xff) ? base : "?";
    }
  }
  out = out.replace(/ {2,}/g, " ").trim();
  return [...out].slice(0, Math.max(0, max)).join("").trimEnd();
}

/**
 * Latin-1 bytes of an already-sanitized string. Throws on a character the
 * printer can't receive — a builder bug, never user input (sanitizeText
 * runs first).
 * @param {string} text
 */
export function encodeLatin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff || code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      throw new Error(`hka: byte 0x${code.toString(16)} cannot go in a frame`);
    }
    out[i] = code;
  }
  return out;
}

/** Frame for a command string (must already be allowed and sanitized). */
export function frameCommand(command) {
  return buildFrame(encodeLatin1(command));
}

/** Latin-1 bytes of a REPLY (fields are LF-separated) — the simulator's side
 *  of the wire. Commands go through encodeLatin1, which refuses LF. */
export function replyBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new Error(`hka: carácter fuera de Latin-1 en una respuesta`);
    out[i] = code;
  }
  return out;
}

/** Latin-1 decode of a reply's data bytes. */
export function decodeLatin1(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
