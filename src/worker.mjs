// Web Worker entry: runs the shell off the main thread. Serves both modes —
// interactive spawn() (a SAB stdin ring the worker parks on via Atomics.wait)
// and non-interactive run() (a fixed stdin buffer, plain postMessage, no SAB).
//
// Startup message: { module | wasmBytes, files, args, env, sab? , stdin? }
// Outbound:        { type:'out', channel:'stdout'|'stderr', bytes }
//                  { type:'ready' } after instantiation, before _start()
//                  { type:'exit', code } | { type:'error', msg }
import { WasiShim, WasiExit } from './shim.mjs';
import { RingReader } from './ring.mjs';
import { fixedInput } from './options.mjs';

self.onmessage = async (e) => {
  const { module, wasmBytes, files, args, env, sab, stdin } = e.data;
  try {
    const input = sab ? new RingReader(sab).toInput() : fixedInput(stdin);
    const compiled = module || await WebAssembly.compile(wasmBytes);
    const post = (channel) => (b) => self.postMessage({ type: 'out', channel, bytes: b }, [b.buffer]);
    const shim = new WasiShim({
      args, env, files,
      stdout: post('stdout'),
      stderr: post('stderr'),
      input,
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
};
