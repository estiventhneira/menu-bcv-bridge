// Windows console hardening (0.5.3).
//
// Field incident (2026-09-06/07): a bridge "died" for 10+ hours with jobs
// piling up pending, and came back the moment someone pressed Enter in its
// console window. Nothing had crashed — a click inside the window had put
// the classic Windows console (conhost) into QuickEdit "Seleccionar" mode,
// and while a selection is active every write to the console BLOCKS.
// stdout is synchronous on Windows, the bridge logs on every event, so the
// first log() after the click froze the whole event loop: no heartbeat, no
// claims, no realtime pings. From the DB it is indistinguishable from a
// process that exited without a restart wrapper.
//
// The fix is to turn QuickEdit off on our own console at startup, via the
// Win32 console API. The compiled binary runs on Bun, so kernel32 is one
// bun:ffi dlopen away — no native addon, no extra install step, and the
// self-updater carries it to every PC. Under node (dev) or on macOS/Linux
// this is a no-op.
//
// Not covered on purpose: Edit → Mark from the title-bar menu and Ctrl+S
// (scroll lock) still pause output; both need deliberate keystrokes, not a
// stray click.

const STD_INPUT_HANDLE = 0xfffffff6; // (DWORD)-10
const ENABLE_QUICK_EDIT_MODE = 0x0040;
const ENABLE_EXTENDED_FLAGS = 0x0080;

/**
 * The console input mode with QuickEdit cleared. ENABLE_EXTENDED_FLAGS must
 * be set for the QuickEdit bit to be honoured at all (without it the console
 * keeps its registry default). Pure — unit-tested from the app's vitest.
 */
export function quickEditDisabledMode(mode) {
  return ((mode | ENABLE_EXTENDED_FLAGS) & ~ENABLE_QUICK_EDIT_MODE) >>> 0;
}

/**
 * Disables QuickEdit on the console this process is attached to.
 * Returns a short status string for the log; never throws.
 */
export async function disableQuickEdit({ log } = {}) {
  if (process.platform !== "win32") return "skipped:platform";
  if (typeof Bun === "undefined") return "skipped:runtime";
  let lib = null;
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    lib = dlopen("kernel32.dll", {
      GetStdHandle: { args: [FFIType.u32], returns: FFIType.ptr },
      GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    const handle = lib.symbols.GetStdHandle(STD_INPUT_HANDLE);
    if (!handle) return "skipped:no-stdin";
    // Out-parameter: GetConsoleMode writes the DWORD into this buffer. Fails
    // (returns 0) when stdin is not a console — a hidden task, a pipe.
    const out = new Uint32Array(1);
    if (!lib.symbols.GetConsoleMode(handle, ptr(out))) return "skipped:no-console";
    const current = out[0];
    const next = quickEditDisabledMode(current);
    if (next === current) return "already-off";
    if (!lib.symbols.SetConsoleMode(handle, next)) return "failed";
    log?.("console: modo de edición rápida desactivado (un clic en la ventana ya no congela el bridge)");
    return "disabled";
  } catch (e) {
    log?.(`console: no se pudo ajustar el modo de la consola: ${e?.message ?? e}`);
    return "failed";
  } finally {
    try { lib?.close(); } catch {}
  }
}
