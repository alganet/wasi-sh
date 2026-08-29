/**
 * Worker entry module — reference it by URL, don't import it:
 *   new Worker(new URL('wasi-sh/worker', import.meta.url), { type: 'module' })
 *
 * Startup message: { module | wasmBytes, files, args, env, sab?, stdin? }
 *   sab    → interactive mode (RingReader on the SAB stdin ring)
 *   stdin  → non-interactive mode (fixed buffer, then EOF)
 * Outbound: { type:'out', channel:'stdout'|'stderr', bytes }
 *           { type:'ready' } | { type:'exit', code } | { type:'error', msg }
 */
import type { HostBuiltins, BuiltinMap, HostPort, HostVerbMap } from './shim.mjs';
import type { FileSystem } from './fs.mjs';

export interface ServeOptions {
  /**
   * Host builtins for this worker's shell. A map, a provider, or a factory —
   * the factory is awaited once, before the module is instantiated, which is
   * where any heavy async setup belongs (booting a wasm interpreter, opening
   * OPFS). Handlers themselves must be synchronous.
   */
  builtins?: BuiltinMap | HostBuiltins | (() => BuiltinMap | HostBuiltins | Promise<BuiltinMap | HostBuiltins>);
  /**
   * The filesystem this worker's shell runs on; omitted, it gets the default
   * in-memory store seeded with `files`. Like builtins, a store is a live
   * object that cannot be structured-cloned into a Worker, so this is the only
   * way one reaches a browser session. The factory form is awaited before the
   * shell starts — where opening OPFS or asking for a directory handle goes.
   */
  fs?: FileSystem | (() => FileSystem | Promise<FileSystem>);
  /**
   * The host port for this worker's shell — the browser capabilities a script
   * may reach, as verbs on /dev/host. A map, a port, or a factory awaited
   * before the shell starts; the verbs themselves must be synchronous.
   *
   * This is the only way a port reaches a browser session, and the only place
   * an interactive spawn() can be given one — a capability object cannot be
   * structured-cloned across postMessage. Omitted, every open of /dev/host is
   * EPERM and the session reaches nothing.
   */
  host?: HostVerbMap | HostPort | (() => HostVerbMap | HostPort | Promise<HostVerbMap | HostPort>);
}

/**
 * Configure this worker before the shell starts. Call it SYNCHRONOUSLY at the
 * top of your worker module, before any top-level await: a startup message
 * that arrives while the module is suspended is delivered to no one, and the
 * shell would run without your builtins. Calling it too late throws.
 *
 *   import { serve } from 'wasi-sh/worker';
 *   serve({ async builtins() {
 *     const engine = await boot();
 *     return { hello: (ctx) => { ctx.stdout('hi\n'); return 0; } };
 *   } });
 */
export function serve(options?: ServeOptions): void;
