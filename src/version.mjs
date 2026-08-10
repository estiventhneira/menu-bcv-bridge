// Bridge version, stamped into the binary at build time.
//
// build.sh passes `--define __BRIDGE_VERSION__='"<package.json version>"'`, so
// a compiled binary carries the real number and reports it on every heartbeat
// (printers.bridge_version) — that's how we tell which restaurants are still
// running an old .exe, since installs never auto-update.
//
// Running from source with node leaves the identifier undeclared. `typeof` on
// an undeclared binding is legal and yields "undefined", so the guard can't
// throw — and "dev" is the honest label for an unbuilt checkout.
export const VERSION =
  typeof __BRIDGE_VERSION__ !== "undefined" ? __BRIDGE_VERSION__ : "dev";
