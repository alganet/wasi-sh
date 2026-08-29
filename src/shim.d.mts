/** Thrown by proc_exit; `code` is the guest's exit status. */
export class WasiExit extends Error {
  constructor(code: number);
  code: number;
}

/** Pluggable stdin. Only pollReadable/read are required. */
export interface ShimInput {
  /** Data available? May wait up to `ms` for some to arrive; `ms` null waits
   *  indefinitely, which is what an untimed guest poll does. Only an input
   *  offering winchPending is ever asked to wait indefinitely. */
  pollReadable(ms: number | null): boolean;
  /** Non-blocking read of up to `max` bytes (possibly empty). */
  read(max: number): Uint8Array;
  /** Park until data or EOF (worker threads only). */
  readBlocking?(max: number): Uint8Array;
  /** Sleep for a poll timeout. */
  wait?(ms: number): void;
  /** True when no more data will ever arrive (stdin EOF). */
  closed?(): boolean;
  /** Current terminal geometry (0 = unknown); backs ioctl(TIOCGWINSZ). */
  winsize?(): { rows: number; cols: number };
  /** Is a resize queued? A peek, and the marker that this input can be woken
   *  by something other than bytes — poll_oneoff parks indefinitely only when
   *  it is present. */
  winchPending?(): boolean;
  /** Consume a pending resize; backs the guest's synthesized SIGWINCH. */
  takeWinch?(): boolean;
}

import type { FileSystem } from './fs.mjs';

export type Files = Record<string, string | Uint8Array>;

/** The in-memory FS, as a host builtin sees it. Relative paths resolve against
 *  the builtin's `cwd`. */
export interface HostFs {
  /** Absolutize against cwd and normalize (`..` clamps at root). */
  resolve(path: string): string;
  /** File contents, or null if absent or a directory. Always a fresh copy. */
  read(path: string): Uint8Array | null;
  /** Create or overwrite a file. False if the parent directory is missing. */
  write(path: string, data: string | Uint8Array | ArrayLike<number>): boolean;
  exists(path: string): boolean;
  stat(path: string): { type: 'file' | 'dir'; size: number } | null;
  /** Entry names, or null if not a directory. */
  list(path: string): string[] | null;
  /** False if it exists already or the parent directory is missing. */
  mkdir(path: string): boolean;
  /** Unlink a file, or remove an empty directory. */
  remove(path: string): boolean;
}

/** What a host builtin is handed. Everything is materialized before the call. */
export interface BuiltinContext {
  /** argv[0] is the command name as typed. */
  argv: string[];
  /** The guest's LIVE environment: exports plus this command's VAR=x prefixes. */
  env: Record<string, string>;
  /** The shell's working directory (from getcwd, not $PWD). */
  cwd: string;
  /**
   * Read up to `max` bytes of stdin. Empty means EOF. Blocking — on an
   * interactive session with a live stdin ring this PARKS the whole session
   * until the embedder writes or calls end(); there is no ^C.
   */
  stdin(max?: number): Uint8Array;
  /** Write to fd 1 — wherever the shell put it (pipe, file, terminal). */
  stdout(data: string | Uint8Array): void;
  /** Write to fd 2 — likewise. */
  stderr(data: string | Uint8Array): void;
  fs: HostFs;
}

/**
 * A host builtin: argv in, exit status out, in-process — like a busybox
 * applet, and just as much NOT a process.
 *
 * MUST be synchronous. The guest is a synchronous wasm stack frame below the
 * call and there is nothing to await into; returning a Promise is reported as
 * an error rather than silently succeeding. Do async setup once, up front —
 * see serve({ async builtins() {...} }).
 *
 * The return value becomes `$?`, truncated to 8 bits like wait(2). Throwing is
 * contained: the message goes to stderr and the command fails, but the shell
 * survives.
 */
export type BuiltinHandler = (ctx: BuiltinContext) => number;

/** A name → handler map, the 95% case. */
export type BuiltinMap = Record<string, BuiltinHandler>;

/**
 * The resolved contract the shim consumes. Implement it directly instead of
 * passing a map when the namespace is dynamic (a whole bin/ directory, a lazy
 * index) rather than a fixed set of keys.
 */
export interface HostBuiltins {
  /** Is this a host builtin? Must NOT run it — `type` and `command -v` ask. */
  lookup(name: string): boolean;
  /** Execute; the return value becomes `$?`. */
  run(ctx: BuiltinContext): number;
}

/**
 * One host verb. Gets the request's payload bytes (empty when the request line
 * carried none) and the verb that selected it; answers with the response bytes,
 * or nothing.
 *
 * MUST be synchronous, for the same reason a builtin must: the guest is a wasm
 * stack frame below the call and there is nothing to await into. Returning a
 * Promise fails the write and says so. Do async setup once, up front — see
 * serve({ async host() {...} }).
 */
export type HostVerb = (payload: Uint8Array, verb: string) => Uint8Array | ArrayBuffer | ArrayBufferView | string | null | void;

/**
 * A verb → handler map, the 95% case. An unregistered verb fails the write.
 *
 * A map is told from a `HostPort` by its `request` method, so a verb literally
 * named `request` is ambiguous: alone it is read as a port, and alongside other
 * verbs it is refused rather than guessed at — the two shapes hand their
 * handler the same two arguments in the opposite order.
 */
export type HostVerbMap = Record<string, HostVerb>;

/**
 * The resolved port the shim consumes. Implement it directly instead of passing
 * a map when the namespace is dynamic, or to wrap another port in an allowlist.
 *
 * Throwing is contained: the write fails with EIO and the shell survives.
 */
export interface HostPort {
  request(verb: string, payload: Uint8Array): Uint8Array | ArrayBuffer | ArrayBufferView | string | null | void;
}

export interface WasiShimOptions {
  /** Full argv; busybox is a multicall binary, argv[0] selects the applet. */
  args?: string[];
  env?: Record<string, string>;
  /**
   * FS content at absolute paths. With the default store this is an in-memory
   * mount, writable inside the sandbox (copy-on-write; your buffers are never
   * mutated, state dies with the run). With `fs`, these files are written into
   * that store — the one thing a mount is allowed to change about it.
   */
  files?: Files;
  /**
   * The filesystem this shell runs on (see `wasi-sh/fs`). Omitted, it gets
   * memoryFs(files) — a sealed sandbox, exactly as before. A store is
   * injected, never ambient: a read-only store is a read-only shell, with
   * nothing shell-side to bypass it. /dev/null stays the shim's either way.
   */
  fs?: FileSystem;
  stdout?: (bytes: Uint8Array) => void;
  stderr?: (bytes: Uint8Array) => void;
  input?: ShimInput;
  /**
   * Host builtins: JS-backed names added to the shell's command namespace.
   * Absent, the shell behaves exactly as it did before — an unregistered name
   * is a plain 127 "not found".
   */
  builtins?: HostBuiltins;
  /**
   * The host port: what a script can reach outside the sandbox, as verbs on
   * /dev/host. A request is a line written there — a verb, optionally a space
   * and a payload — and the answer is read back from the same name:
   *
   *     printf 'clipboard.read\n' > /dev/host
   *     paste=$(cat /dev/host)
   *
   * Capabilities are injected, never ambient: with no port the device is still
   * there and every open is EPERM, so a script can tell "not granted" from
   * "no such thing".
   */
  host?: HostPort;
}

/**
 * Minimal WASI preview1 shim plus the env.__host_* hooks: __host_pipe /
 * __host_dup / __host_dup2 backing busybox's fork-free pipes, __host_winsize /
 * __host_winch for terminal geometry, and __host_builtin_lookup /
 * __host_builtin_run for host builtins.
 */
export class WasiShim {
  constructor(options?: WasiShimOptions);
  /** Call after instantiation with instance.exports.memory. */
  bindMemory(memory: WebAssembly.Memory): void;
  /** The import object for WebAssembly.instantiate. */
  imports(): WebAssembly.Imports;
  /**
   * Register a character device in the /dev overlay. The path must be under
   * /dev — the only namespace the overlay owns — and the inode is assigned
   * here, so listing, stat and open always answer for the same set of names.
   *
   * `write` returns an errno to refuse the write, or nothing for success;
   * `open` refuses the open the same way.
   */
  addDevice(path: string, device: {
    read(max: number): Uint8Array;
    write?(bytes: Uint8Array): number | void;
    open?(): number | void;
  }): this;
}
