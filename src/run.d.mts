import type { Files } from './shim.mjs';

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
