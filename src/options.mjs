// Internal option plumbing shared by run() and spawn(): argv/env/wasm
// normalization and the fixed-stdin input adapter. Not a public subpath —
// import from 'wasi-sh' (index) or 'wasi-sh/run' / 'wasi-sh/spawn' instead.

export const DEFAULT_ENV = {
  PATH: '/',
  HOME: '/',
  TERM: 'xterm-256color',
  LANG: 'C.UTF-8',
};

export const DEFAULT_WASM_URL = new URL('../dist/busybox.wasm', import.meta.url);

// argv precedence: explicit args > command (sh -c) > script (mounted file) >
// interactive shell. busybox is a multicall binary: argv[0] selects the
// applet, so full argv always starts with 'busybox'.
export function resolveArgv({ args, command, script } = {}, mountAt = '/main.sh') {
  if (args) return { argv: args, extraFiles: {} };
  if (command != null) return { argv: ['busybox', 'sh', '-c', command], extraFiles: {} };
  if (script != null) return { argv: ['busybox', 'sh', mountAt], extraFiles: { [mountAt]: script } };
  return { argv: ['busybox', 'sh'], extraFiles: {} };
}

export function mergeEnv(user = {}) {
  return { ...DEFAULT_ENV, ...user };
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node
  && typeof importScripts === 'undefined' && typeof window === 'undefined';

// Accepts URL | string | Response | ArrayBuffer | Uint8Array | WebAssembly.Module
// and yields a compiled Module. In node, file: URLs and plain paths read from
// disk (fetch has no file: support); everywhere else strings/URLs are fetched.
export async function resolveWasm(wasm = DEFAULT_WASM_URL) {
  if (wasm instanceof WebAssembly.Module) return wasm;
  if (typeof Response !== 'undefined' && wasm instanceof Response) return compileResponse(wasm);
  if (wasm instanceof ArrayBuffer || ArrayBuffer.isView(wasm)) return WebAssembly.compile(wasm);
  // URL or string from here on
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    return WebAssembly.compile(await readFile(wasm instanceof URL ? wasm : new URL(wasm, `file://${process.cwd()}/`)));
  }
  return compileResponse(await fetch(wasm));
}

async function compileResponse(res) {
  if (!res.ok) throw new Error(`failed to fetch wasm: ${res.status} ${res.statusText} (${res.url})`);
  // compileStreaming needs the application/wasm MIME; fall back to bytes.
  if (WebAssembly.compileStreaming) {
    try { return await WebAssembly.compileStreaming(res.clone()); } catch { /* MIME */ }
  }
  return WebAssembly.compile(await res.arrayBuffer());
}

// For worker handoff: either the caller's ready Module (structured-clones
// same-origin) or the raw bytes (transferred; the worker compiles). Returns
// { module } or { wasmBytes }.
export async function resolveWasmForWorker(wasm = DEFAULT_WASM_URL) {
  if (wasm instanceof WebAssembly.Module) return { module: wasm };
  if (typeof Response !== 'undefined' && wasm instanceof Response) {
    return { wasmBytes: new Uint8Array(await wasm.arrayBuffer()) };
  }
  if (wasm instanceof ArrayBuffer) return { wasmBytes: new Uint8Array(wasm.slice(0)) };
  if (ArrayBuffer.isView(wasm)) return { wasmBytes: new Uint8Array(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)) };
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(wasm instanceof URL ? wasm : new URL(wasm, `file://${process.cwd()}/`));
    return { wasmBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  }
  const res = await fetch(wasm);
  if (!res.ok) throw new Error(`failed to fetch wasm: ${res.status} ${res.statusText} (${res.url})`);
  return { wasmBytes: new Uint8Array(await res.arrayBuffer()) };
}

const ENC = new TextEncoder();

export function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  return typeof data === 'string' ? ENC.encode(data) : data;
}

// Normalize `builtins` into the shim's host-builtin contract:
//   lookup(name) -> bool     is this a host builtin? (`type` and `command -v`
//                            ask, so it must answer WITHOUT running anything)
//   run(ctx)     -> status   execute it, synchronously
// A plain { name: handler } map is the 95% case. An object that ALREADY has
// both methods is passed through untouched — that is the extension point for a
// dynamic namespace (a whole bin/ directory, a lazy index). Requiring BOTH
// methods is what keeps a map containing a command literally named `run` from
// being mistaken for a provider.
// hasOwn is not paranoia: a bare `typeof map[name] === 'function'` claims
// toString, constructor and valueOf as builtins, so `type toString` would
// answer yes and then dispatch into Object.prototype.
export function hostBuiltins(spec) {
  if (!spec) return undefined;
  if (typeof spec.lookup === 'function' && typeof spec.run === 'function') return spec;
  const pick = (name) => (Object.hasOwn(spec, name) && typeof spec[name] === 'function' ? spec[name] : null);
  return {
    lookup: (name) => pick(name) != null,
    run(ctx) {
      const fn = pick(ctx.argv[0]);
      if (!fn) { ctx.stderr(`${ctx.argv[0]}: not found\n`); return 127; }
      return fn(ctx);
    },
  };
}

// The public `builtins` option: a map, a provider, or a factory returning
// either. The factory is the only reason this is async — it exists so a worker
// can `await` a heavy dependency (a wasm interpreter, an OPFS handle) ONCE,
// before _start(), and keep every handler synchronous afterwards.
export async function resolveBuiltins(spec) {
  if (!spec) return undefined;
  return hostBuiltins(typeof spec === 'function' ? await spec() : spec);
}

// The WasiShim input contract over a fixed byte buffer: drain, then EOF.
// This is the whole of run()'s stdin story — nothing ever blocks on a user.
export function fixedInput(data) {
  const bytes = toBytes(data);
  let off = 0;
  return {
    pollReadable: () => off < bytes.length,
    read(max) {
      const take = bytes.subarray(off, Math.min(off + max, bytes.length));
      off += take.length;
      return take;
    },
    readBlocking(max) { return this.read(max); },
    wait: () => {},
    closed: () => off >= bytes.length,
  };
}
