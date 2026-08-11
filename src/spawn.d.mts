import type { Files } from './shim.mjs';
import type { WasmSource, OutputChannel } from './run.mjs';

export interface SpawnOptions {
  /** Full argv; default ['busybox','sh'] (interactive shell). */
  args?: string[];
  /** Sugar for args: ['busybox','sh','-c', command]. */
  command?: string;
  /** Script text, mounted at /main.sh and executed. */
  script?: string;
  files?: Files;
  /**
   * Merged over PATH=/ HOME=/ TERM=xterm-256color LANG=C.UTF-8.
   * Terminal geometry travels here: env: { COLUMNS: '80', LINES: '24' }.
   */
  env?: Record<string, string>;
  /** Defaults to the bundled busybox.wasm. */
  wasm?: WasmSource;
  /** SAB stdin ring capacity in bytes (default 65536). */
  stdinBufferSize?: number;
  /** Bring-your-own Worker. */
  worker?: Worker;
  /** Alternate URL for the wasi-sh worker module. */
  workerUrl?: URL | string;
  /**
   * How long to wait for the worker's `ready` before rejecting (default
   * 30000; 0 disables). Guards against a custom serve() module that awaited
   * before registering its handler and so never saw the startup message —
   * without a bound, spawn() would simply hang.
   */
  readyTimeoutMs?: number;
  onOutput?: (bytes: Uint8Array, channel: OutputChannel) => void;
  onExit?: (code: number) => void;
  onError?: (err: Error) => void;
}

/**
 * The terminal-agnostic byte duplex. A terminal is anything that feeds
 * write() and renders onOutput() bytes.
 */
export class Session {
  /** Feed stdin. Strings are UTF-8-encoded. */
  write(data: string | Uint8Array): void;
  /** Signal stdin EOF. */
  end(): void;
  /**
   * Report a terminal resize (cols × rows). Stores live geometry and
   * synthesizes SIGWINCH in the guest, so a `trap ... WINCH` handler runs and
   * `stty size` / ioctl(TIOCGWINSZ) return the new size. Call from the
   * terminal's resize handler (e.g. xterm's term.onResize).
   */
  resize(cols: number, rows: number): void;
  /** Hard-kill the worker. Settles `exited` (and fires onExit) with 137. */
  terminate(): void;
  /** Subscribe to output bytes. Returns an unsubscribe function. */
  onOutput(fn: (bytes: Uint8Array, channel: OutputChannel) => void): () => void;
  onExit(fn: (code: number) => void): () => void;
  onError(fn: (err: Error) => void): () => void;
  /**
   * Resolves with the guest's exit code (137 after terminate(), 134 if the
   * worker errored or the guest trapped — onError carries the detail). Always
   * settles — safe to await unconditionally.
   */
  readonly exited: Promise<number>;
  /** Escape hatch. */
  readonly worker: Worker;
}

/**
 * Start an interactive shell session. Requires cross-origin isolation
 * (SharedArrayBuffer); throws early with an actionable message without it.
 * Resolves once the worker is instantiated and about to run.
 */
export function spawn(options?: SpawnOptions): Promise<Session>;
