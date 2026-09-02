import type { Files, HostBuiltins, BuiltinMap, HostPort, HostVerbMap, NetPort } from './shim.mjs';
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
  /**
   * Inbound host requests, staged up front: the guest reads them as lines from
   * /dev/hostreq, in order, then EOF.
   *
   * Nothing can arrive DURING a run() — the guest holds the thread for its
   * whole life — so the whole channel is known before the shell starts. That is
   * a dev-server loop with a finite queue, and enough to write the loop
   * against; spawn()'s session.post() is what makes the queue live.
   *
   * Omitted, /dev/hostreq is EPERM and the loop refuses to start. An empty
   * array is a granted channel with nothing in it: the loop runs zero times.
   * Each request must be one line — an embedded newline is refused here, where
   * something can be done about it.
   */
  requests?: string | Uint8Array | Array<string | Uint8Array>;
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
   * Let a host builtin await — see WasiShimOptions.suspendable. Needs JSPI;
   * ignored without it.
   *
   * `inline: true` only, and for the same reason `builtins` is: off-thread,
   * the handlers come from `serve()` inside the worker module, so the decision
   * about whether they may await belongs there too — pass
   * `serve({ suspendable: true })`. One owner, rather than two places that
   * can disagree about one session.
   */
  suspendable?: boolean;
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
  /** Sockets. See NetPort in ./shim.d.mts — absent, socket() fails. */
  net?: NetPort;
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
