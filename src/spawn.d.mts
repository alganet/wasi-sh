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
  /**
   * Grant the inbound host-request channel, sized in bytes — a second SAB ring
   * in the same format, which is what session.post() writes into and the guest
   * reads at /dev/hostreq.
   *
   * A size IS the grant; there is no second way to say it. Absent, the guest's
   * /dev/hostreq is EPERM, so a dev-server loop refuses to start rather than
   * parking on a request that can never arrive. The capacity is also the cap
   * on unread requests: post() throws RingOverflowError when the guest is not
   * consuming, which is the host's problem to size.
   */
  requestBufferSize?: number;
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
   * Hand the RUNNING guest a host request, read as a line from /dev/hostreq.
   * Needs requestBufferSize; without it this throws rather than dropping the
   * request into a channel the guest cannot open.
   *
   * This is the one direction postMessage cannot go. A live session is a single
   * synchronous _start() frame, so a message posted to a running shell worker
   * is not slow — it is not delivered until the guest happens to yield. The
   * request travels through shared memory the guest reads at its blocking
   * point, which wakes it in under a millisecond.
   *
   * Fire-and-forget: a request the guest is still handling has nothing to
   * return, so the answer comes back as an ordinary outbound verb on
   * /dev/host. One line per request — an embedded newline is refused here,
   * where something can be done about it, rather than forging a second request
   * at the guest.
   */
  post(request: string | Uint8Array | ArrayBuffer | ArrayBufferView): number;
  /**
   * No more requests are coming. The guest's read hits EOF, which is the only
   * thing that ever ends `while read -r req <&3; do ...; done 3< /dev/hostreq`.
   */
  endRequests(): void;
  /**
   * Report a terminal resize (cols × rows). Stores live geometry and
   * synthesizes SIGWINCH in the guest, so a `trap ... WINCH` handler runs and
   * `stty size` / ioctl(TIOCGWINSZ) return the new size. Call from the
   * terminal's resize handler (e.g. xterm's term.onResize).
   */
  resize(cols: number, rows: number): void;
  /**
   * Deliver a cooperative interrupt — the ^C a wasm guest cannot be sent.
   * There are no signals here, so a long-running command holds the worker and
   * terminate() is otherwise the only escape, which takes the filesystem and
   * every warm instance with it.
   *
   * Cooperative: it raises a count in shared memory and wakes the guest. What
   * it cancels is whatever chose to look — a host builtin polling
   * ctx.interrupted(), a language runtime with an interrupt hook. Work that
   * ignores it is not stopped, and terminate() remains the answer then.
   *
   * Bind it to ^C only while a command is running: at the prompt that byte is
   * the shell's own, and a terminal that swallows 0x03 unconditionally takes
   * it away from the guest.
   */
  interrupt(): void;
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
