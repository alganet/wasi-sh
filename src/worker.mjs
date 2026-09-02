// Web Worker entry: runs the shell off the main thread. Serves both modes —
// interactive spawn() (a SAB stdin ring the worker parks on via Atomics.wait)
// and non-interactive run() (a fixed stdin buffer, plain postMessage, no SAB).
//
// Two ways in:
//   default   run()/spawn() point a plain `new Worker(...)` at this module and
//             get a shell with no host builtins.
//   serve()   a CUSTOM worker module imports it to register host builtins, a
//             filesystem, or the host port. Handlers are FUNCTIONS and
//             postMessage structured-clones its payload, so registering them
//             HERE, inside the worker, is the only way `builtins`, `fs` and
//             `host` can reach a browser session. Point run()/spawn() at your
//             module with `workerUrl`.
//
// serve() must be called SYNCHRONOUSLY at module evaluation, before any
// top-level await. A task can never interleave with synchronous script
// execution, so a synchronous call always wins the startup message; a module
// that awaits first hands that message to whatever handler exists at that
// moment — this one, with no builtins — and the shell would silently run
// without them. serve() detects that and says so instead. Async setup belongs
// inside builtins(), which is awaited before the module is instantiated.
//
// Startup message: { module | wasmBytes, files, args, env, sab?, reqSab?, stdin?, requests? }
// `requests` is the inbound host-port channel, pre-framed: bytes, so it crosses
// structured clone exactly as stdin does. Nothing about it is a live object.
// Outbound:        { type:'out', channel:'stdout'|'stderr', bytes }
//                  { type:'ready' } after instantiation, before _start()
//                  { type:'exit', code } | { type:'error', msg }
//
// A message carrying no wasm is NOT the startup message and is left alone, so
// a serve() module can `addEventListener('message', ...)` for handoffs of its
// own — a SharedArrayBuffer for serve({ fs }) is the one that forces it.
import { WasiShim, WasiExit } from './shim.mjs';
import { RingReader } from './ring.mjs';
import { fixedInput, fixedRequests, resolveBuiltins, resolveHost } from './options.mjs';

let config = {};
let started = false;

// A worker module has one `message` event and two things want it: this shim's
// startup message, and whatever the module's own listener is waiting for. A
// SharedArrayBuffer is the case that forces the question — `serve({ fs })` is
// documented to wait on a store the page posts, and a store cannot be
// structured-cloned any more than a builtin can, so the SAB behind it has to
// arrive as an ordinary message. Consuming every message took that away:
// the handoff was read as a startup message, destructured into undefined, and
// the session failed to start naming a wasm nobody passed.
//
// So the shell starts on a message that carries wasm and on no other. That is
// what a startup message structurally IS — there is no shell without it — so
// the check needs no agreement between page and worker beyond the one they
// already have, and every other message is left for the module's own listener.
function isStartup(data) {
  if (!data || typeof data !== 'object') return false;
  return data.module instanceof WebAssembly.Module
    || ArrayBuffer.isView(data.wasmBytes)
    || data.wasmBytes instanceof ArrayBuffer;
}

export function serve(options = {}) {
  if (started) {
    const msg =
      'wasi-sh serve(): called after the shell already started, so its builtins '
      + 'were ignored. Call serve() at the TOP of your worker module, before any '
      + 'top-level await — a startup message that arrives while the module is '
      + 'suspended is delivered without them. Move the async setup inside '
      + 'builtins(), which is awaited before the module is instantiated: '
      + 'serve({ async builtins() { const x = await heavy(); return { name: (ctx) => …x… }; } })';
    self.postMessage({ type: 'error', msg });   // surfaces as a real failure, not a hang
    throw new Error(msg);
  }
  config = options;
}

self.addEventListener('message', async (e) => {
  if (!isStartup(e.data)) return;   // not ours — the module's own listener has it
  // One worker, one guest. A second startup message would build a second shim
  // over the same globals: two shells interleaving on one stdout, two `exit`
  // messages, and a stdin ring with two readers. Reachable by reusing a worker
  // for a second spawn({ worker }), which is a mistake worth naming rather
  // than a state worth entering.
  if (started) {
    self.postMessage({
      type: 'error',
      msg: 'wasi-sh worker: a second shell was asked to start in a worker that already has one. '
        + 'A worker hosts exactly one guest — give each run()/spawn() its own.',
    });
    return;
  }
  started = true;
  const { module, wasmBytes, files, args, env, sab, reqSab, stdin, requests, tty } = e.data;
  try {
    const input = sab ? new RingReader(sab).toInput() : fixedInput(stdin);
    // Builtin setup and wasm compilation are independent; overlapping them
    // hides an interpreter-sized init behind the compile.
    const [builtins, host, compiled] = await Promise.all([
      // `builtins()` is handed the session's own input, which is the only way
      // to reach the things that exist HERE and nowhere else — the signal cell
      // a hosted runtime polls, the terminal geometry it may want at startup.
      // A setup function that takes no argument is unaffected.
      resolveBuiltins(config.builtins, { input }).catch((ex) => {
        throw new Error(`serve({ builtins }): setup failed: ${(ex && ex.message) || ex}`);
      }),
      resolveHost(config.host).catch((ex) => {
        throw new Error(`serve({ host }): setup failed: ${(ex && ex.message) || ex}`);
      }),
      module || WebAssembly.compile(wasmBytes),
    ]);
    const post = (channel) => (b) => self.postMessage({ type: 'out', channel, bytes: b }, [b.buffer]);
    const shim = new WasiShim({
      args, env, files,
      // A store is a live object, so like `builtins` it can only be registered
      // from inside the worker — structured clone would strip its methods.
      // serve({ async fs() {...} }) covers the ones that must be opened first.
      fs: typeof config.fs === 'function' ? await config.fs() : config.fs,
      stdout: post('stdout'),
      stderr: post('stderr'),
      input, builtins, host,
      // A live channel when the session granted one (spawn), the pre-staged
      // queue otherwise (run). The ring reader serves as-is: the inbound
      // channel is stdin's contract aimed the other way, so there is no
      // adapter between them.
      requests: reqSab ? new RingReader(reqSab).toInput() : fixedRequests(requests),
      // Only a session can be one, and only if it said so: see the fd table in
      // shim.mjs for why the shell's own line editor is opt-in.
      tty: !!tty,
    });
    const instance = await WebAssembly.instantiate(compiled, shim.imports());
    shim.bindMemory(instance.exports.memory);
    self.postMessage({ type: 'ready' });
    let code = 0;
    try {
      instance.exports._start();
    } catch (ex) {
      if (ex instanceof WasiExit) code = ex.code;
      else { self.postMessage({ type: 'error', msg: String(ex && ex.message || ex) }); return; }
    }
    self.postMessage({ type: 'exit', code });
  } catch (ex) {
    self.postMessage({ type: 'error', msg: String(ex && ex.message || ex) });
  }
});
