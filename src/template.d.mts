// Minimal typings so src/ tests can byte-compare the bridge mirror against
// the TS renderer (see kitchen-ticket.test.ts). Keep in sync with template.mjs.
import type { RasterFont } from "./raster-text.mjs";

export function renderKitchenTicket(
  p: unknown,
  cols?: number,
  settings?: unknown,
  opts?: { rasterFont?: RasterFont | null; paperDots?: number },
): Buffer;
