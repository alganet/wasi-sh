// Internal option plumbing shared by run() and spawn(): argv/env/wasm
// normalization and the fixed-stdin input adapter. Not a public subpath —
// import from 'wasi-sh' (index) or 'wasi-sh/run' / 'wasi-sh/spawn' instead.
import { frameRequest } from './ring.mjs';

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
//   names()      -> string[] OPTIONAL: every name, for tab completion
// A plain { name: handler } map is the 95% case. An object that ALREADY has
// both methods is passed through untouched — that is the extension point for a
// dynamic namespace (a whole bin/ directory, a lazy index). Requiring BOTH
// methods is what keeps a map containing a command literally named `run` from
// being mistaken for a provider.
//
// names() is third and optional because listing is a strictly bigger promise
// than looking up: lookup() answers one question and a lazy index can always
// do that, while enumerating may be something it genuinely cannot offer. Its
// PRESENCE is the signal, exactly as input.winchPending's is in shim.mjs — a
// provider without it simply contributes no completions, which is also what a
// session with no builtins at all does. A map has nothing to decide: its keys
// ARE the list.
// hasOwn is not paranoia: a bare `typeof map[name] === 'function'` claims
// toString, constructor and valueOf as builtins, so `type toString` would
// answer yes and then dispatch into Object.prototype.
export function hostBuiltins(spec) {
  if (!spec) return undefined;
  if (typeof spec.lookup === 'function' && typeof spec.run === 'function') return spec;
  const pick = (name) => (Object.hasOwn(spec, name) && typeof spec[name] === 'function' ? spec[name] : null);
  return {
    lookup: (name) => pick(name) != null,
    // Own keys only, and filtered through the same pick() lookup() uses, so
    // the list and the answer cannot disagree: a key holding a non-function is
    // not a builtin, and Object.keys would otherwise offer it as one.
    names: () => Object.keys(spec).filter((name) => pick(name) != null),
    run(ctx) {
      const fn = pick(ctx.argv[0]);
      if (!fn) { ctx.stderr(`${ctx.argv[0]}: not found\n`); return 127; }
      return fn(ctx);
    },
  };
}

// A provider whose namespace CHANGES while the session runs.
//
// hostBuiltins() above already passes any object with lookup() and run()
// straight through, so a mutable namespace was always possible; what was
// missing is that nothing said so, and every embedder wrote the same Map by
// hand. This is that Map, with the contract's three methods on it.
//
// It exists because "registration happens once, before _start()" stopped being
// true. A handler that may await (see WasiShimOptions.suspendable) can go and
// FETCH the thing a new command needs — an interpreter, a tool — and then
// define the command, from inside the session, while the shell waits at the
// import. `define` and `remove` are what it calls when it gets back.
//
// Names are checked rather than trusted, and the check is not fussiness: ash
// resolves a name containing a slash as a PATH, never as a builtin, so
// define('bin/thing') would register a command nothing can ever reach. Better
// to refuse it where the mistake is than to leave a command that silently is
// not one.
export function builtinRegistry(initial) {
  const map = new Map();
  const registry = {
    /** Add or replace a command. Returns the registry, so calls chain. */
    define(name, handler) {
      if (typeof name !== 'string' || name === '') {
        throw new Error('builtinRegistry.define: a command needs a non-empty name');
      }
      if (/[/\0\s]/.test(name)) {
        throw new Error(
          `builtinRegistry.define: '${name}' can never be reached as a builtin — ash resolves a `
          + 'name with a slash, a NUL or whitespace in it as a path or as two words, not as a command'
        );
      }
      if (typeof handler !== 'function') {
        throw new Error(`builtinRegistry.define: '${name}' needs a handler function`);
      }
      map.set(name, handler);
      return registry;
    },
    /** Drop a command. True if it was there. */
    remove(name) { return map.delete(name); },
    /** Is it registered? The embedder's question, not the guest's. */
    has(name) { return map.has(name); },
    lookup: (name) => map.has(name),
    names: () => [...map.keys()],
    run(ctx) {
      const fn = map.get(ctx.argv[0]);
      // Reachable when a name is removed between `lookup` and `run` — the two
      // are separate calls from the guest, and a handler that unloads itself
      // is exactly the case this file now exists to serve.
      if (!fn) { ctx.stderr(`${ctx.argv[0]}: not found\n`); return 127; }
      return fn(ctx);
    },
  };
  for (const [name, handler] of Object.entries(initial || {})) registry.define(name, handler);
  return registry;
}

// The public `builtins` option: a map, a provider, or a factory returning
// either. The factory is the only reason this is async — it exists so a worker
// can `await` a heavy dependency (a wasm interpreter, an OPFS handle) ONCE,
// before _start(), and keep every handler synchronous afterwards.
export async function resolveBuiltins(spec, session) {
  if (!spec) return undefined;
  return hostBuiltins(typeof spec === 'function' ? await spec(session) : spec);
}

// Normalize `host` into the shim's port contract:
//   request(verb, payload) -> bytes | string | null    execute it, synchronously
// A plain { verb: handler } map is the 95% case; handlers get (payload, verb)
// so the common one-verb-one-function shape ignores the second argument. An
// object that ALREADY has request() is passed through untouched — that is the
// extension point for a dynamic namespace, a proxy to another port, or an
// allowlist wrapper around one. A map with a verb literally named `request`
// and nothing else is read as a port; one with other verbs beside it is
// refused, because the two shapes swap their handler's arguments.
//
// hasOwn for the same reason hostBuiltins uses it: a bare property lookup would
// make `toString` and `constructor` reachable verbs.
//
// An unregistered verb THROWS, which the shim reports as a failed write naming
// the verb — the map form has no other way to say "no such capability", and
// answering with silence would look like a verb that ran and had nothing to say.
export function hostPort(spec) {
  if (!spec) return undefined;
  if (typeof spec.request === 'function') {
    // `request` is a plausible verb name, and a map containing one is
    // indistinguishable from a port — while the two call the handler with the
    // SAME two arguments in the OPPOSITE order, which is a bug that looks like
    // working code. When there are other verbs beside it there is no honest
    // guess to make, so say so rather than pick.
    const others = Object.keys(spec).filter((k) => k !== 'request' && typeof spec[k] === 'function');
    if (others.length) {
      throw new Error(
        `host: this object has a request() alongside ${others.join(', ')}, so it reads as both `
        + 'a port and a verb map — and the two hand their handler (verb, payload) and '
        + '(payload, verb) respectively, which is a bug that looks like working code. Say '
        + 'which: if it is a verb MAP, rename the `request` verb or wrap it in a port whose '
        + 'request() dispatches the map; if it is a PORT, request() must be the only '
        + 'function it owns — put the rest on a prototype or close over them.'
      );
    }
    return spec;
  }
  return {
    request(verb, payload) {
      if (!Object.hasOwn(spec, verb) || typeof spec[verb] !== 'function') throw new Error('no such verb');
      return spec[verb](payload, verb);
    },
  };
}

// Pre-staged inbound requests, for run(): the whole channel, known up front.
// Nothing can arrive DURING a run() — the guest holds the thread for its entire
// life, which is the same reason spawn() exists — so the honest shape is a list
// handed over before the shell starts, drained in order, then EOF. That is the
// dev-server loop with a finite queue, and it is enough to write the loop
// against; spawn()'s ring is what makes the queue live.
//
// Returns undefined for no list at all, which is what keeps /dev/hostreq EPERM:
// an empty list is a granted channel with nothing in it (the loop runs zero
// times), and no list is a session that can never be asked.
export function toRequestBytes(list) {
  if (list == null) return undefined;
  const items = Array.isArray(list) ? list : [list];
  const framed = items.map(frameRequest);
  let total = 0;
  for (const f of framed) total += f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of framed) { out.set(f, off); off += f.length; }
  return out;
}

// The shim's inbound channel over those bytes: drain, then EOF. fixedInput's
// contract is already the read half of it — the inbound channel is stdin's
// contract aimed the other way, so there is nothing else to implement.
export function fixedRequests(bytes) {
  return bytes === undefined ? undefined : fixedInput(bytes);
}

// The public `host` option: a verb map, a port, or a factory returning either.
// The factory is awaited before the shell starts, which is where async setup
// belongs — every verb itself must be synchronous.
export async function resolveHost(spec) {
  if (!spec) return undefined;
  return hostPort(typeof spec === 'function' ? await spec() : spec);
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
