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
  /**
   * Cooperative interrupts posted so far — a monotonic count, not a flag, so
   * there is nothing to consume. Work in flight reads it once at entry and
   * compares; absent, ctx.interrupted() is permanently false. Backs
   * Session.interrupt().
   */
  interruptCount?(): number;
  /**
   * The one-byte signal cell raise() writes beside the count, for a guest that
   * polls memory rather than calling anything of ours. Present, the shim clears
   * it as each host builtin is dispatched — the same fresh start the count gets
   * from its baseline, so a ^C raised while nothing was running is not read as
   * the next command's own.
   */
  signalBuffer?(): Uint8Array;
}

/**
 * The inbound request channel: stdin's contract aimed the other way. No
 * terminal half, because a request is not a keystroke — but the same park,
 * read, EOF shape, so a SAB ring reader serves both without an adapter.
 */
export type ShimRequests = Pick<ShimInput, 'pollReadable' | 'read' | 'readBlocking' | 'closed'>;

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
   * until the embedder writes or calls end(). Session.interrupt() does not end
   * it: the wait wakes, but no bytes have appeared, so the read parks again.
   */
  stdin(max?: number): Uint8Array;
  /**
   * Write to fd 1 — wherever the shell put it (pipe, file, terminal).
   *
   * THROWS if the write was refused, which only a device does (`/dev/host`
   * with no port, or a verb that failed). Left uncaught it costs this command
   * and gives the script a non-zero `$?` to act on, which is what a `cmd >
   * /dev/host || fallback` needs.
   */
  stdout(data: string | Uint8Array): void;
  /** Write to fd 2 — likewise, and it can be refused for the same reasons. */
  stderr(data: string | Uint8Array): void;
  fs: HostFs;
  /**
   * Has a cooperative interrupt (Session.interrupt()) landed since this
   * command started? Poll it at your own safe points and bail out; nothing can
   * unwind the handler from outside, because it runs on the guest's own stack.
   * Return 130 (128 + SIGINT) so `$?` reads as a shell script expects.
   *
   * Scoped to this invocation, so a ^C typed at the prompt before the command
   * ran does not cancel it. Always false when the session has no interrupt
   * channel — run(), or a fixed stdin.
   */
  interrupted(): boolean;
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
export type BuiltinHandler = (ctx: BuiltinContext) => number | Promise<number>;

/** A name → handler map, the 95% case. */
export type BuiltinMap = Record<string, BuiltinHandler>;

/**
 * A command namespace that changes while the session runs — see
 * `builtinRegistry()`.
 *
 * A HostBuiltins with two more methods on it, so it can be passed as
 * `builtins` unchanged. Its point is `define`: a handler that may await (see
 * WasiShimOptions.suspendable) can fetch what a new command needs and then
 * register the command, from inside the running session.
 */
export interface BuiltinRegistry extends HostBuiltins {
  /** Add or replace a command. Throws on a name ash could never resolve. */
  define(name: string, handler: BuiltinHandler): BuiltinRegistry;
  /** Drop a command. True if it was there. */
  remove(name: string): boolean;
  /** Is it registered? */
  has(name: string): boolean;
  names(): string[];
}


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
  /**
   * Every registered name, for tab completion — the guest's own Tab lists
   * them beside the applets, this shell's builtins, its functions and its
   * aliases.
   *
   * OPTIONAL, and deliberately so: listing is a bigger promise than looking
   * up, and a lazy namespace that can answer `lookup('php')` may have no way
   * to enumerate itself. Omit it and completion simply never mentions these
   * commands; everything else about them is unchanged. A plain map gets it for
   * free — its keys are the list.
   *
   * Read once, on the first completion, and not re-read afterwards: the walk
   * asks for one name at a time and a list that changed underneath it would
   * skip or repeat entries.
   */
  names?(): string[];
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
 * `request` must be the only function the object OWNS — that is what tells a
 * port from a `HostVerbMap` with a verb named `request`, and the two swap their
 * handler's arguments. Helpers belong on a prototype (a class port is fine) or
 * closed over; an object owning both is refused rather than guessed at.
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
  /**
   * Called immediately before the guest stops writing — every read and poll it
   * can park in, and every call out to your own code (`builtins`, `host`).
   *
   * For a caller that BATCHES what `stdout` and `stderr` hand it: the batch is
   * finished when the guest stops writing, because the prompt is the last
   * thing a shell writes before it parks on a keystroke. A timer instead would
   * leave the terminal blank until one fired.
   *
   * The calls out are about ORDER rather than latency. A handler that posts to
   * the page itself would otherwise have its message overtake output the guest
   * wrote before calling it.
   *
   * Omit it and every write goes through as it happens.
   */
  beforeBlock?: () => void;
  input?: ShimInput;
  /**
   * Report fds 0/1/2 as a terminal, i.e. make `isatty()` true on them by
   * withholding FD_SEEK and FD_TELL from their rights — which is exactly what
   * "not seekable, therefore a tty" means to wasi-libc.
   *
   * That single bit is what turns ash interactive and hands the guest its own
   * line editor: prompt, echo, history, arrows and Tab completion. Default
   * false; see spawn({ tty }) for why it is opt-in.
   */
  tty?: boolean;
  /**
   * Host builtins: JS-backed names added to the shell's command namespace.
   * Absent, the shell behaves exactly as it did before — an unregistered name
   * is a plain 127 "not found".
   */
  builtins?: HostBuiltins;
  /**
   * May a host builtin AWAIT?
   *
   * Off by default, and the default is the contract every session had until
   * now: a handler returning a promise is refused, loudly, because the guest
   * is a synchronous stack frame below the import and a thenable coerces to
   * i32 0 — silent success with the real work landing later.
   *
   * On, and given an engine with JSPI, the guest's whole wasm stack suspends
   * for the duration of the handler — ash's own setjmp frames included, so a
   * $(...) capture, a pipeline stage, a redirect and `$?` all still mean what
   * they meant. That is what lets a command go and fetch an interpreter and
   * then register more commands with `builtinRegistry`, mid-session.
   *
   * Feature-detected rather than trusted: without `WebAssembly.Suspending`
   * this is ignored and the shell is the one it always was. Read
   * `shim.suspendable` back for what was actually decided — the caller needs
   * it, because the export must be entered through `WebAssembly.promising`
   * for a suspending import to be legal.
   *
   * Costs nothing when nothing suspends: measured at 6.3 µs per builtin call
   * either way.
   */
  suspendable?: boolean;
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
  net?: NetPort;
  /**
   * The inbound half of that port: requests the HOST hands to a RUNNING guest,
   * read as lines from /dev/hostreq. A running guest owns its worker and its
   * event loop never turns, so nothing reaches a live session by postMessage —
   * this channel is shared memory the guest reads at a blocking point, which
   * makes a dev server an ordinary shell loop:
   *
   *     while read -r req <&3; do handle "$req"; done 3< /dev/hostreq
   *
   * Granted separately from `host` — a session may be able to ask the host
   * without being able to be asked. Absent, the device is there and every open
   * is EPERM, so the loop refuses to start rather than parking on a request
   * that can never arrive; end-of-stream is EOF, which ends it. The reply goes
   * back out as an ordinary verb on /dev/host.
   */
  requests?: ShimRequests;
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
   * Register a character device in the /dev overlay. The path must be a name
   * directly under /dev — the only namespace the overlay owns, and flat
   * because `ls /dev` lists basenames — and the inode is assigned here, so
   * listing, stat and open always answer for the same set of names.
   *
   * At least one of `read`/`write` is required; the missing half means what it
   * says (nothing to read, nothing that may be written). `write` returns an
   * errno to refuse a write, or nothing for success, and `open` refuses an
   * open the same way. `read` speaks that same vocabulary: bytes, or an errno
   * — which is how a device that can block says EAGAIN, since an empty read
   * already means EOF.
   *
   * `poll` is optional and its PRESENCE is the signal. Without it the device
   * is readable the moment it is asked. With it, poll_oneoff asks before
   * reporting readable — required of any device whose read can WAIT, because
   * otherwise the wait lands in the read that follows and nothing there can
   * end it. It must answer true at end-of-stream too, so the read behind it
   * gets to report EOF.
   *
   * `owner` identifies the OPEN DESCRIPTION a call arrives through — fresh per
   * open, shared across dup/dup2 as POSIX shares a file offset. A device
   * holding per-exchange state uses it as that state's boundary; one that does
   * not can ignore it.
   */
  addDevice(path: string, device: {
    read?(max: number, owner: object, nonblock: boolean): Uint8Array | number;
    write?(bytes: Uint8Array, owner: object): number | void;
    open?(): number | void;
    /** True when a read would not block — including at end-of-stream. `ms`
     *  null means park indefinitely, which is what an untimed guest poll does. */
    poll?(ms: number | null): boolean;
  }): this;
}

/**
 * Sockets, for a guest that asks for one.
 *
 * WASI preview1 can neither create a connection nor dial with it, so this is
 * the whole of what the shim cannot do for itself. Absent, `socket()` fails
 * with EAFNOSUPPORT and nothing else changes.
 *
 * A handle is whatever this object wants it to be; the shim only holds it.
 * Reading and writing are the descriptor's own `fd_read`/`fd_write`.
 */
export interface NetPort {
  /** A name's address, dotted quad, or null if it has none. */
  resolve(hostname: string): string | null;
  /** Open a connection. Throwing refuses it. */
  connect(address: string, port: number): unknown;
  send(handle: unknown, bytes: Uint8Array): number;
  /** Bytes; empty for EOF, null for "nothing yet". */
  recv(handle: unknown, max: number): Uint8Array | null;
  poll(handle: unknown): { readable: boolean; writable: boolean; hup?: boolean };
  close(handle: unknown): void;
}
