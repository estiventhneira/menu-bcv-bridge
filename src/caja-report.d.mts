// Minimal typings so src/ tests can byte-compare the bridge mirror against
// the TS renderer (see caja-report.test.ts). Keep in sync with caja-report.mjs.
export function renderCajaReport(
  p: unknown,
  cols?: number,
  settings?: unknown,
): Buffer;
