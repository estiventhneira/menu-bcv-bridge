// Minimal typings so src/ tests can byte-compare the bridge mirror against
// the TS renderer (see caja-report.test.ts). Keep in sync with caja-report.mjs.
import type { RasterFont } from "./raster-text.mjs";

export function renderCajaReport(
  p: unknown,
  cols?: number,
  settings?: unknown,
  opts?: { rasterFont?: RasterFont | null; paperDots?: number },
): Buffer;
