// run(): execute a shell script non-interactively and collect its output.
// stdin is a fixed buffer (then EOF), so nothing ever blocks on the user —
// which means NO SharedArrayBuffer and NO COOP/COEP headers are needed for
// this entire use case. In a browser the work runs off-thread in a plain
// postMessage Worker by default; pass inline:true (the node default) to run
// on the calling thread instead.
import { WasiShim, WasiExit } from './shim.mjs';
import { resolveArgv, mergeEnv, resolveWasm, resolveWasmForWorker, fixedInput, toBytes } from './options.mjs';

const DEC = new TextDecoder();

// Options: { command | script | args, stdin, files, env, wasm, inline,
//            onOutput, workerUrl, worker }
// Resolves to { stdout, stderr, exitCode }. onOutput streams raw bytes as
// they happen: onOutput(bytes, channel) with channel 'stdout' | 'stderr'.
export async function run(options = {}) {
  const inline = options.inline ?? (typeof Worker === 'undefined');
  return inline ? runInline(options) : runInWorker(options);
}

async function runInline(options) {
  const { argv, extraFiles } = resolveArgv(options);
  const module = await resolveWasm(options.wasm);
  const chunks = { stdout: [], stderr: [] };
  const sink = (channel) => (bytes) => {
    chunks[channel].push(bytes);
    if (options.onOutput) options.onOutput(bytes, channel);
  };
  const shim = new WasiShim({
    args: argv,
    env: mergeEnv(options.env),
    files: { ...extraFiles, ...(options.files || {}) },
    stdout: sink('stdout'),
    stderr: sink('stderr'),
    input: fixedInput(options.stdin),
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  let exitCode = 0;
  try {
    instance.exports._start();
  } catch (e) {
    if (e instanceof WasiExit) exitCode = e.code;
    else throw e;
  }
  return {
    stdout: decodeAll(chunks.stdout),
    stderr: decodeAll(chunks.stderr),
    exitCode,
  };
}

function decodeAll(list) {
  if (list.length === 0) return '';
  if (list.length === 1) return DEC.decode(list[0]);
  let total = 0;
  for (const c of list) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of list) { merged.set(c, off); off += c.length; }
  return DEC.decode(merged);
}

// Browser off-thread mode: same worker module as spawn(), but with a fixed
// stdin buffer instead of a SAB ring — plain postMessage, no Atomics.
async function runInWorker(options) {
  const { argv, extraFiles } = resolveArgv(options);
  const wasm = await resolveWasmForWorker(options.wasm);
  const worker = options.worker
    || (options.workerUrl
      ? new Worker(options.workerUrl, { type: 'module' })
      : new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }));
  const chunks = { stdout: [], stderr: [] };
  const result = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'out') {
        const bytes = new Uint8Array(m.bytes);
        chunks[m.channel].push(bytes);
        if (options.onOutput) options.onOutput(bytes, m.channel);
      } else if (m.type === 'exit') {
        resolve({
          stdout: decodeAll(chunks.stdout),
          stderr: decodeAll(chunks.stderr),
          exitCode: m.code,
        });
      } else if (m.type === 'error') {
        reject(new Error(m.msg));
      }
    };
    worker.onerror = (e) => reject(e.error || new Error(e.message || 'worker error'));
  });
  const msg = {
    ...wasm, // { module } or { wasmBytes }
    files: { ...extraFiles, ...(options.files || {}) },
    args: argv,
    env: mergeEnv(options.env),
    stdin: toBytes(options.stdin),
  };
  worker.postMessage(msg, msg.wasmBytes ? [msg.wasmBytes.buffer] : []);
  try {
    return await result;
  } finally {
    if (!options.worker) worker.terminate();
  }
}
