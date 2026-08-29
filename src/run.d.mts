import type { Files, HostBuiltins, BuiltinMap, HostPort, HostVerbMap } from './shim.mjs';
import type { FileSystem } from './fs.mjs';

export type WasmSource =
  | URL
  | string
  | Response
  | ArrayBuffer
  | Uint8Array
  | WebAssembly.Module;

export type OutputChannel = 'stdout' | 'stderr';

export interface RunOptions {
  /** Script text, mounted at /main.sh and executed. */
  script?: string;
  /** Sugar for args: ['busybox','sh','-c', command]. */
  command?: string;
  /** Full argv (overrides script/command). argv[0] is 'busybox'. */
  args?: string[];
  /** Fixed stdin content; the guest reads it, then EOF. */
  stdin?: string | Uint8Array;
  files?: Files;
  /**
   * The filesystem to run on; omitted, an in-memory store seeded with `files`.
   * A store is a live object, so this needs inline:true — a Worker run
   * registers one with serve({ fs }) instead.
   *
   * `files` are written into it, and so is `script`, which is mounted at
   * /main.sh — worth knowing when the store is a real directory.
   */
  fs?: FileSystem;
  /** Merged over PATH=/ HOME=/ TERM=xterm-256color LANG=C.UTF-8. */
  env?: Record<string, string>;
  /** Defaults to the bundled busybox.wasm. */
  wasm?: WasmSource;
  /** Run on the calling thread (node default) instead of a Worker (browser default). */
  inline?: boolean;
  /** Streaming output callback (bytes as they happen). */
  onOutput?: (bytes: Uint8Array, channel: OutputChannel) => void;
  /** Bring-your-own Worker (not terminated for you). */
  worker?: Worker;
  /** Alternate URL for the wasi-sh worker module. */
  workerUrl?: URL | string;
  /**
   * Host builtins — JS-backed command names, resolved after shell functions,
   * builtins and busybox applets. A name → handler map, a HostBuiltins
   * provider, or a factory (awaited once) returning either.
   *
   * Works directly only when the shell runs on the calling thread — i.e.
   * inline:true, the node default. Handler functions cannot be
   * structured-cloned into a Worker, so in a browser register them INSIDE a
   * worker module with serve() and pass it as `workerUrl`; passing `builtins`
   * to a stock worker throws and says so.
   */
  builtins?: BuiltinMap | HostBuiltins | (() => BuiltinMap | HostBuiltins | Promise<BuiltinMap | HostBuiltins>);
  /**
   * The host port — what this script may reach outside the sandbox, as verbs
   * on /dev/host. A verb → handler map, a HostPort, or a factory (awaited
   * once) returning either. Omitted, the device is there and every open is
   * EPERM.
   *
   * Like `builtins`, it works directly only with inline:true; a capability
   * object cannot be structured-cloned into a Worker, so in a browser register
   * it with serve({ host }) inside a worker module and pass it as `workerUrl`.
   */
  host?: HostVerbMap | HostPort | (() => HostVerbMap | HostPort | Promise<HostVerbMap | HostPort>);
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a shell script non-interactively and collect its output.
 * Needs NO SharedArrayBuffer and no COOP/COEP headers.
 */
export function run(options?: RunOptions): Promise<RunResult>;
