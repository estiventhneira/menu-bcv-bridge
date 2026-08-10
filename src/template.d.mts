// Minimal typings so src/ tests can byte-compare the bridge mirror against
// the TS renderer (see kitchen-ticket.test.ts). Keep in sync with template.mjs.
export function renderKitchenTicket(
  p: unknown,
  cols?: number,
  settings?: unknown,
): Buffer;
