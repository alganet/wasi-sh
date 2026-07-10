/** Thrown by proc_exit; `code` is the guest's exit status. */
export class WasiExit extends Error {
  constructor(code: number);
  code: number;
}

/** Pluggable stdin. Only pollReadable/read are required. */
export interface ShimInput {
  /** Data available? May wait up to `ms` for some to arrive. */
  pollReadable(ms: number): boolean;
  /** Non-blocking read of up to `max` bytes (possibly empty). */
  read(max: number): Uint8Array;
  /** Park until data or EOF (worker threads only). */
  readBlocking?(max: number): Uint8Array;
  /** Sleep for a poll timeout. */
  wait?(ms: number): void;
  /** True when no more data will ever arrive (stdin EOF). */
  closed?(): boolean;
}

export type Files = Record<string, string | Uint8Array>;

export interface WasiShimOptions {
  /** Full argv; busybox is a multicall binary, argv[0] selects the applet. */
  args?: string[];
  env?: Record<string, string>;
  /**
   * In-memory FS content, absolute paths. Writable inside the sandbox
   * (copy-on-write; your buffers are never mutated, state dies with the run).
   */
  files?: Files;
  stdout?: (bytes: Uint8Array) => void;
  stderr?: (bytes: Uint8Array) => void;
  input?: ShimInput;
}

/**
 * Minimal WASI preview1 shim plus the env.__host_pipe/__host_dup/__host_dup2
 * hooks backing busybox's fork-free pipes.
 */
export class WasiShim {
  constructor(options?: WasiShimOptions);
  /** Call after instantiation with instance.exports.memory. */
  bindMemory(memory: WebAssembly.Memory): void;
  /** The import object for WebAssembly.instantiate. */
  imports(): WebAssembly.Imports;
}
