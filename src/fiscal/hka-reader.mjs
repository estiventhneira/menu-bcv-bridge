// HKA fiscal protocol — incoming byte state machine (bridge 0.9.0).
//
//   IDLE ──ACK/NAK/ENQ/EOT──▶ event
//   IDLE ──STX──▶ DATA ──ETX/ETB──▶ LRC ──any byte──▶ frame event ──▶ IDLE
//
// The LRC can be ANY value, including 0x02/0x03/0x05/0x06/0x15 (the LRC of
// "SV" is 0x06 = ACK, spec §2.2), so exactly one byte after ETX/ETB is always
// consumed as the LRC. A reader that stops at the first ETX leaves that byte
// in the buffer, where it later reads as a phantom ACK.

import { ACK, ENQ, EOT, ETB, ETX, NAK, STX, lrc } from "./hka-frame.mjs";

/** Longest DATA we accept before calling it noise (S3 is ~156 bytes,
 *  U0X ~638; nothing legitimate comes close). */
const MAX_DATA = 4096;

/**
 * @typedef {{ type: "ack" } | { type: "nak" } | { type: "enq" } | { type: "eot" }
 *   | { type: "frame", data: Uint8Array, end: "etx" | "etb", lrcOk: boolean }
 *   | { type: "noise", byte: number }} ReaderEvent
 */

/** @param {(ev: ReaderEvent) => void} onEvent */
export function createFrameReader(onEvent) {
  /** @type {"idle" | "data" | "lrc"} */
  let state = "idle";
  /** @type {number[]} */
  let buf = [];
  let end = ETX;

  return {
    /** @param {Uint8Array | number[]} bytes */
    push(bytes) {
      for (const b of bytes) {
        if (state === "idle") {
          if (b === ACK) onEvent({ type: "ack" });
          else if (b === NAK) onEvent({ type: "nak" });
          else if (b === ENQ) onEvent({ type: "enq" });
          else if (b === EOT) onEvent({ type: "eot" });
          else if (b === STX) {
            state = "data";
            buf = [];
          } else onEvent({ type: "noise", byte: b });
        } else if (state === "data") {
          if (b === ETX || b === ETB) {
            end = b;
            state = "lrc";
          } else if (b === STX) {
            // A new frame started before this one ended: the first was lost.
            onEvent({ type: "noise", byte: b });
            buf = [];
          } else if (buf.length >= MAX_DATA) {
            onEvent({ type: "noise", byte: b });
            state = "idle";
            buf = [];
          } else {
            buf.push(b);
          }
        } else {
          const data = Uint8Array.from(buf);
          onEvent({ type: "frame", data, end: end === ETB ? "etb" : "etx", lrcOk: lrc(data, end) === b });
          state = "idle";
          buf = [];
        }
      }
    },
    /** Drop a half-received frame (e.g. after the link reopened). */
    reset() {
      state = "idle";
      buf = [];
    },
    get state() {
      return state;
    },
  };
}
