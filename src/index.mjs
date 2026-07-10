// wasi-sh: run pure shell scripts in the browser (and node) — busybox ash
// compiled to wasm32-wasi, fork-free.
//
// Two first-class uses:
//   run()    non-interactive: script in, {stdout, stderr, exitCode} out.
//            No SharedArrayBuffer, no special headers — works anywhere.
//   spawn()  interactive Session: a terminal-agnostic byte duplex
//            (write / onOutput / end / lifecycle). Needs cross-origin
//            isolation for its SharedArrayBuffer stdin ring.
//
// Building blocks are exported too — WasiShim (the WASI machine, pluggable
// I/O), the stdin ring, and fetchTree() for mounting remote file trees.
export { run } from './run.mjs';
export { spawn, Session } from './spawn.mjs';
export { fetchTree } from './files.mjs';
export { WasiShim, WasiExit } from './shim.mjs';
export { createStdinRing, RingWriter, RingReader, RingOverflowError } from './ring.mjs';
