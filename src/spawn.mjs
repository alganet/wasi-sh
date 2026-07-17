// spawn(): an interactive shell session — a terminal-agnostic byte duplex.
// The worker parks on a SharedArrayBuffer stdin ring (Atomics.wait) so the
// guest's blocking `read` and timed `read -t` behave like a real terminal's.
//
// The Session contract is the ENTIRE surface a terminal integration touches:
//   session.write(data)       keystrokes in (strings are UTF-8-encoded)
//   session.onOutput(fn)      raw output bytes out (fn(bytes, channel))
//   session.end()             stdin EOF
//   session.terminate()       hard-kill the worker
// plus lifecycle: onExit/onError subscriptions and the `exited` promise.
// A terminal is anything that feeds write() and renders onOutput — geometry
// is just env: { COLUMNS, LINES }, passed by whoever owns the terminal.
import { createStdinRing, RingWriter } from './ring.mjs';
import { resolveArgv, mergeEnv, resolveWasmForWorker } from './options.mjs';

const ENC = new TextEncoder();

// Options: { args | command | script, files, env, wasm,
//            stdinBufferSize, worker, workerUrl,
//            onOutput, onExit, onError }
// Resolves to a Session once the worker reports ready (module instantiated,
// _start about to run).
export async function spawn(options = {}) {
  if (typeof SharedArrayBuffer === 'undefined'
    || (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === false)) {
    throw new Error(
      'spawn() needs SharedArrayBuffer, which requires cross-origin isolation. ' +
      'Serve the page with "Cross-Origin-Opener-Policy: same-origin" and ' +
      '"Cross-Origin-Embedder-Policy: require-corp" headers (see the wasi-sh ' +
      'README for static hosts), or use run() — non-interactive execution ' +
      'needs neither.'
    );
  }
  const { argv, extraFiles } = resolveArgv(options);
  const wasm = await resolveWasmForWorker(options.wasm);
  const sab = createStdinRing(options.stdinBufferSize ?? 65536);
  const worker = options.worker
    || (options.workerUrl
      ? new Worker(options.workerUrl, { type: 'module' })
      : new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }));
  const ringWriter = new RingWriter(sab);
  const session = new Session(worker, ringWriter, options.worker == null);
  if (options.onOutput) session.onOutput(options.onOutput);
  if (options.onExit) session.onExit(options.onExit);
  if (options.onError) session.onError(options.onError);
  const env = mergeEnv(options.env);
  // Geometry for an interactive session travels through the winsize ioctl (live,
  // resizable via session.resize()), NOT the environment. Seed the ring from the
  // caller's initial COLUMNS/LINES so the guest's first `stty size` /
  // ioctl(TIOCGWINSZ) is right, then DROP them from the guest env: busybox's
  // `stty size` / get_terminal_width_height prefer COLUMNS/LINES when present and
  // would return that frozen value forever, so a resize would never be seen.
  // (run() keeps them — it has no winsize ioctl and never resizes.)
  const cols0 = parseInt(env.COLUMNS, 10), rows0 = parseInt(env.LINES, 10);
  if (cols0 > 0 && rows0 > 0) ringWriter.seedWinsize(cols0, rows0);
  delete env.COLUMNS;
  delete env.LINES;
  const msg = {
    ...wasm, // { module } or { wasmBytes }
    files: { ...extraFiles, ...(options.files || {}) },
    args: argv,
    env,
    sab,
  };
  worker.postMessage(msg, msg.wasmBytes ? [msg.wasmBytes.buffer] : []);
  await session._ready;
  return session;
}

export class Session {
  constructor(worker, ringWriter, ownsWorker) {
    this.worker = worker;
    this._ring = ringWriter;
    this._ownsWorker = ownsWorker;
    this._outputFns = new Set();
    this._exitFns = new Set();
    this._errorFns = new Set();
    let readyResolve, readyReject;
    this._ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
    this.exited = new Promise((res) => { this._exitResolve = res; });
    // Reject-before-ready surfaces instantiation failures through spawn().
    this._ready.catch(() => {});
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'out') {
        const bytes = new Uint8Array(m.bytes);
        for (const fn of this._outputFns) fn(bytes, m.channel);
      } else if (m.type === 'ready') {
        readyResolve(this);
      } else if (m.type === 'exit') {
        this._exit(m.code);
      } else if (m.type === 'error') {
        const err = new Error(m.msg);
        readyReject(err);
        for (const fn of this._errorFns) fn(err);
        // Settle `exited` too (134 = abnormal, SIGABRT-style): the contract is
        // "exited always settles", and a guest that traps mid-session must not
        // leave `await session.exited` hanging. onError conveys the detail;
        // _exit (idempotent) resolves exited, fires onExit, and disposes.
        this._exit(134);
      }
    };
    worker.onerror = (e) => {
      const err = e.error || new Error(e.message || 'worker error');
      readyReject(err);
      for (const fn of this._errorFns) fn(err);
      this._exit(134);   // as above: never leave `exited` pending on a worker error
    };
  }

  // Feed stdin. Strings are UTF-8-encoded; bytes pass through.
  write(data) {
    this._ring.write(typeof data === 'string' ? ENC.encode(data) : data);
  }

  // Signal stdin EOF: the guest drains buffered input, then reads EOF.
  end() { this._ring.end(); }

  // Report a terminal resize (cols × rows). Stores the live geometry and
  // synthesizes a SIGWINCH in the guest: a shell with `trap ... WINCH` runs
  // its handler, and `stty size` / ioctl(TIOCGWINSZ) then return the new size.
  // wasm has no signals and env is frozen at spawn, so this shared-memory path
  // is how geometry reaches a RUNNING guest — call it from the terminal's own
  // resize handler (e.g. xterm's term.onResize). No-op if the guest doesn't
  // trap WINCH; the fresh size is still there for the next `stty size`.
  resize(cols, rows) { this._ring.resize(cols, rows); }

  // Hard-kill the worker (the guest gets no chance to exit cleanly).
  // Settles `exited` (and fires onExit) with 137, kill -9 style — a session
  // must never leave `await session.exited` hanging.
  terminate() {
    if (this.worker) this.worker.terminate();
    this._exit(137);
  }

  onOutput(fn) { this._outputFns.add(fn); return () => this._outputFns.delete(fn); }
  onExit(fn) { this._exitFns.add(fn); return () => this._exitFns.delete(fn); }
  onError(fn) { this._errorFns.add(fn); return () => this._errorFns.delete(fn); }

  // Single exit path (worker exit message OR terminate) — first caller wins.
  _exit(code) {
    if (this._exited) return;
    this._exited = true;
    this._exitResolve(code);
    for (const fn of this._exitFns) fn(code);
    this._dispose();
  }

  _dispose() {
    if (this._ownsWorker && this.worker) this.worker.terminate();
  }
}
