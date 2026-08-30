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
import { WasiShim, WasiExit } from './shim.mjs';
import { RingReader } from './ring.mjs';
import { fixedInput, fixedRequests, resolveBuiltins, resolveHost } from './options.mjs';

let config = {};
let started = false;

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
  started = true;
  const { module, wasmBytes, files, args, env, sab, reqSab, stdin, requests } = e.data;
  try {
    const input = sab ? new RingReader(sab).toInput() : fixedInput(stdin);
    // Builtin setup and wasm compilation are independent; overlapping them
    // hides an interpreter-sized init behind the compile.
    const [builtins, host, compiled] = await Promise.all([
      resolveBuiltins(config.builtins).catch((ex) => {
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
