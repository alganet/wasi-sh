// run(): execute a shell script non-interactively and collect its output.
// stdin is a fixed buffer (then EOF), so nothing ever blocks on the user —
// which means NO SharedArrayBuffer and NO COOP/COEP headers are needed for
// this entire use case. In a browser the work runs off-thread in a plain
// postMessage Worker by default; pass inline:true (the node default) to run
// on the calling thread instead.
import { WasiShim, WasiExit } from './shim.mjs';
import { resolveArgv, mergeEnv, resolveWasm, resolveWasmForWorker, fixedInput, toBytes, toRequestBytes, fixedRequests, resolveBuiltins, resolveHost } from './options.mjs';

const DEC = new TextDecoder();

// Options: { command | script | args, stdin, files, env, wasm, inline,
//            onOutput, workerUrl, worker, builtins, requests }
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
    fs: options.fs,
    stdout: sink('stdout'),
    stderr: sink('stderr'),
    input: fixedInput(options.stdin),
    requests: fixedRequests(toRequestBytes(options.requests)),
    builtins: await resolveBuiltins(options.builtins),
    host: await resolveHost(options.host),
    suspendable: !!options.suspendable,
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  let exitCode = 0;
  try {
    // See worker.mjs: a Suspending import needs a promising export above it,
    // and the shim has already checked the engine has both.
    if (shim.suspendable) await WebAssembly.promising(instance.exports._start)();
    else instance.exports._start();
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
  // Handlers are functions and postMessage structured-clones its payload, so
  // `builtins` cannot cross into a stock worker. Registering them inside a
  // custom worker module with serve() is the supported route.
  // A store has methods and `builtins` are functions; structured clone keeps
  // neither, so both have to be registered inside the worker with serve().
  if (options.fs && !options.worker && !options.workerUrl) {
    throw new Error(
      'run({ fs }) needs a worker that registers the store: a filesystem cannot '
      + 'be structured-cloned into a Worker. Either pass inline:true to run on '
      + "the calling thread, or call serve({ fs }) from 'wasi-sh/worker' in a "
      + 'worker module and pass it as workerUrl.'
    );
  }
  if (options.host && !options.worker && !options.workerUrl) {
    throw new Error(
      'run({ host }) needs a worker that registers the port: a capability object '
      + 'cannot be structured-cloned into a Worker. Either pass inline:true to run '
      + "on the calling thread, or call serve({ host }) from 'wasi-sh/worker' in a "
      + 'worker module and pass it as workerUrl.'
    );
  }
  if (options.builtins && !options.worker && !options.workerUrl) {
    throw new Error(
      'run({ builtins }) needs a worker that registers them: handler functions '
      + 'cannot be structured-cloned into a Worker. Either pass inline:true to '
      + 'run on the calling thread, or write a worker module that calls '
      + "serve({ builtins }) from 'wasi-sh/worker' and pass it as workerUrl. "
      + 'See the host builtins section of the wasi-sh README.'
    );
  }
  const { argv, extraFiles } = resolveArgv(options);
  const wasm = await resolveWasmForWorker(options.wasm);
  const worker = options.worker
    || (options.workerUrl
      ? new Worker(options.workerUrl, { type: 'module' })
      : new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }));
  const chunks = { stdout: [], stderr: [] };
  const result = new Promise((resolve, reject) => {
    worker.addEventListener('message', (e) => {
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
    });
    // addEventListener, not onmessage/onerror: a caller-supplied `worker` may
    // already have handlers of its own (a serve() module does), and assigning
    // would silently clobber them.
    worker.addEventListener('error', (e) => reject(e.error || new Error(e.message || 'worker error')));
  });
  const msg = {
    ...wasm, // { module } or { wasmBytes }
    files: { ...extraFiles, ...(options.files || {}) },
    args: argv,
    env: mergeEnv(options.env),
    stdin: toBytes(options.stdin),
    // Bytes, so they structured-clone into a stock worker exactly as stdin
    // does — the whole channel is data here, and none of it is a live object.
    requests: toRequestBytes(options.requests),
  };
  worker.postMessage(msg, msg.wasmBytes ? [msg.wasmBytes.buffer] : []);
  try {
    return await result;
  } finally {
    if (!options.worker) worker.terminate();
  }
}
