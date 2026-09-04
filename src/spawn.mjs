// spawn(): an interactive shell session — a terminal-agnostic byte duplex.
// The worker parks on a SharedArrayBuffer stdin ring (Atomics.wait) so the
// guest's blocking `read` and timed `read -t` behave like a real terminal's.
//
// The Session contract is the ENTIRE surface a terminal integration touches:
//   session.write(data)       keystrokes in (strings are UTF-8-encoded)
//   session.onOutput(fn)      raw output bytes out (fn(bytes, channel))
//   session.end()             stdin EOF
//   session.interrupt()       cooperative ^C into whatever is running
//   session.terminate()       hard-kill the worker
//   session.post(request)     hand the RUNNING guest a host request (opt-in,
//                             via requestBufferSize; read at /dev/hostreq)
//   session.endRequests()     no more of them: the guest's loop ends
// plus lifecycle: onExit/onError subscriptions and the `exited` promise.
// A terminal is anything that feeds write() and renders onOutput — geometry
// is just env: { COLUMNS, LINES }, passed by whoever owns the terminal.
import { createRing, RingWriter, frameRequest } from './ring.mjs';
import { resolveArgv, mergeEnv, resolveWasmForWorker } from './options.mjs';

const ENC = new TextEncoder();

// Options: { args | command | script, files, env, wasm,
//            stdinBufferSize, requestBufferSize, worker, workerUrl,
//            onOutput, onExit, onError }
// Host builtins are registered INSIDE the worker with serve() — handler
// functions cannot be structured-cloned — so there is no `builtins` option
// here; point workerUrl at your serve() module instead.
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
  // Live objects — handler functions, a store, a capability port — cannot be
  // structured-cloned, so there is no `builtins`/`fs`/`host` option here: they
  // are registered inside the worker with serve(). Accepting one and dropping
  // it silently would hand back a session that looks right and reaches
  // nothing, which is the failure a capability is least able to report — every
  // /dev/host open would be EPERM with no reason given. run() already refuses
  // the same way.
  for (const name of ['builtins', 'fs', 'host']) {
    if (!options[name]) continue;
    throw new Error(
      `spawn({ ${name} }) is not supported: a live object cannot be structured-cloned into `
      + `a Worker. Call serve({ ${name} }) from 'wasi-sh/worker' at the top of a worker `
      + 'module and pass it as workerUrl.'
    );
  }
  // run()'s option, and here it would be a queue that is complete before the
  // session starts — the one thing an interactive session is not. Silently
  // ignoring it would hand back a session whose dev-server loop ended before
  // the first keystroke, which looks exactly like a working one.
  if (options.requests) {
    throw new Error(
      'spawn({ requests }) is not supported: a session is live, so its requests are too. '
      + 'Grant the channel with requestBufferSize and hand each request over with '
      + 'session.post(request) — run({ requests }) is the pre-staged form.'
    );
  }
  const { argv, extraFiles } = resolveArgv(options);
  const wasm = await resolveWasmForWorker(options.wasm);
  const sab = createRing(options.stdinBufferSize ?? 65536);
  // Opt-in, and a size IS the grant — there is no second way to say the same
  // thing. Without one the guest's /dev/hostreq is EPERM, so a dev-server loop
  // refuses to start rather than parking on a request that can never arrive.
  const reqBytes = options.requestBufferSize;
  if (reqBytes !== undefined && !(Number.isFinite(reqBytes) && reqBytes > 0)) {
    // A truthy non-size (`true`, '64k') would either build a 29-byte ring that
    // overflows on the first request or, worse, read as no grant at all and
    // leave every /dev/hostreq open EPERM with nothing said about why.
    throw new Error(`spawn({ requestBufferSize }) must be a positive number of bytes; got ${JSON.stringify(reqBytes)}.`);
  }
  const reqSab = reqBytes ? createRing(reqBytes) : null;
  const worker = options.worker
    || (options.workerUrl
      ? new Worker(options.workerUrl, { type: 'module' })
      : new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }));
  const ringWriter = new RingWriter(sab);
  const session = new Session(worker, ringWriter, options.worker == null,
    reqSab && new RingWriter(reqSab, { channel: 'host request', sizeOption: 'requestBufferSize' }));
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
    reqSab,
    // Hand the shell its own line editor: history, arrow keys, ^C and tab
    // completion, all inside the guest. It is what makes isatty() true, and
    // the terminal must then stop editing lines itself — see shim.mjs's fd
    // table, and README's "Terminals: bring your own".
    tty: !!options.tty,
    // Let the guest SUSPEND when it has nothing to read, instead of parking
    // the worker thread. Without it a shell drawing its own prompt owns the
    // thread between keystrokes, and nothing else in that worker — a host
    // builtin the page wants to call, a message, a timer — runs until a key
    // arrives. Needs JSPI; the shim checks and says so through
    // `shim.suspendInput`.
    suspendInput: !!options.suspendInput,
  };
  worker.postMessage(msg, msg.wasmBytes ? [msg.wasmBytes.buffer] : []);
  // Bounded: a custom worker module that top-level-awaits before installing a
  // message handler drops the startup message entirely, and an unbounded await
  // here would hang spawn() forever with nothing to show for it.
  await session._readyWithin(options.readyTimeoutMs ?? 30000);
  return session;
}

export class Session {
  constructor(worker, ringWriter, ownsWorker, requestWriter) {
    this.worker = worker;
    this._ring = ringWriter;
    this._requests = requestWriter || null;
    this._ownsWorker = ownsWorker;
    this._outputFns = new Set();
    this._exitFns = new Set();
    this._errorFns = new Set();
    let readyResolve, readyReject;
    this._ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
    this.exited = new Promise((res) => { this._exitResolve = res; });
    // Reject-before-ready surfaces instantiation failures through spawn().
    this._ready.catch(() => {});
    worker.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'out') {
        // Two shapes, and both are current. `runs` is a whole guest turn, which
        // is what serve() sends so that a page paints once for a redraw rather
        // than once per write() (see worker.mjs); the single-run form is what a
        // worker module posts when it has something of its own to put on the
        // terminal. Either way each run reaches onOutput exactly as it always
        // did, in order, with its own channel.
        if (m.runs) {
          for (const r of m.runs) {
            const bytes = new Uint8Array(r.bytes);
            for (const fn of this._outputFns) fn(bytes, r.channel);
          }
        } else {
          const bytes = new Uint8Array(m.bytes);
          for (const fn of this._outputFns) fn(bytes, m.channel);
        }
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
    });
    // addEventListener, not onmessage/onerror: a caller-supplied `worker` may
    // already have handlers of its own (a serve() module does), and assigning
    // would silently clobber them.
    worker.addEventListener('error', (e) => {
      const err = e.error || new Error(e.message || 'worker error');
      readyReject(err);
      for (const fn of this._errorFns) fn(err);
      this._exit(134);   // as above: never leave `exited` pending on a worker error
    });
  }

  // `ready`, but it always settles. A worker that never answers is otherwise
  // indistinguishable from a slow one, and the usual cause is a custom serve()
  // module that awaited before registering — so name that in the message.
  _readyWithin(ms) {
    if (!(ms > 0)) return this._ready;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._exit(134);
        reject(new Error(
          `spawn(): the worker did not report ready within ${ms}ms. Two things cause `
          + 'this. Either setup is simply slow — a serve({ builtins }) that fetches a '
          + 'runtime is bounded by the visitor\'s connection, not by this default, and '
          + 'wants a readyTimeoutMs of its own. Or a custom worker module top-level-'
          + 'awaited before calling serve(), and the startup message arrived while the '
          + 'module was suspended, so it was delivered to no one.'
        ));
      }, ms);
      const clear = (fn) => (v) => { clearTimeout(t); fn(v); };
      this._ready.then(clear(resolve), clear(reject));
    });
  }

  // Feed stdin. Strings are UTF-8-encoded; bytes pass through.
  write(data) {
    this._ring.write(typeof data === 'string' ? ENC.encode(data) : data);
  }

  // Signal stdin EOF: the guest drains buffered input, then reads EOF.
  end() { this._ring.end(); }

  // Deliver a cooperative interrupt — the ^C a wasm guest cannot be sent.
  // There are no signals here, so a long-running command holds the worker, and
  // terminate() was the only way out — which kills the filesystem and every
  // warm instance with it, in a session the user was working in.
  //
  // Cooperative, and that word is the whole contract: this raises a count in
  // shared memory and wakes the guest. What it cancels is whatever chose to
  // look — a host builtin polling ctx.interrupted() at its own safe points, a
  // language runtime with an interrupt hook. Nothing that ignores it is
  // stopped, and terminate() is still the answer when nothing looks.
  //
  // Bind it to ^C only while a command is running: at the prompt the byte
  // belongs to the shell's own line editing, so a terminal that swallows 0x03
  // unconditionally takes it away from the guest.
  interrupt() { this._ring.interrupt(); }

  // Deliver a POSIX signal. `interrupt()` is `raise(2)`.
  raise(signo) { this._ring.raise(signo); }

  // The one-byte cell a guest with its own signal handling polls, for handing
  // to whatever is hosted inside this session.
  //
  // It crosses `postMessage` as a live view rather than a copy — a Uint8Array
  // over a SharedArrayBuffer is structured-cloneable and stays shared — which
  // is the only way it can reach a worker that must read it while nothing on
  // this thread is running. CPython's `setInterruptBuffer()` takes it as it is.
  signalBuffer() { return this._ring.signal; }

  // Report a terminal resize (cols × rows). Stores the live geometry and
  // synthesizes a SIGWINCH in the guest: a shell with `trap ... WINCH` runs
  // its handler, and `stty size` / ioctl(TIOCGWINSZ) then return the new size.
  // wasm has no signals and env is frozen at spawn, so this shared-memory path
  // is how geometry reaches a RUNNING guest — call it from the terminal's own
  // resize handler (e.g. xterm's term.onResize). No-op if the guest doesn't
  // trap WINCH; the fresh size is still there for the next `stty size`.
  resize(cols, rows) { this._ring.resize(cols, rows); }

  // Hand the RUNNING guest a host request, read at /dev/hostreq. This is the
  // one direction postMessage cannot go: a live session is one synchronous
  // _start() frame, so a message posted to it is not slow, it is not delivered
  // — measured at +303ms posted, +3020ms handled, and only because the wait
  // expired. The request goes through shared memory the guest reads at its
  // blocking point, which wakes it in single-digit ms.
  //
  // Fire-and-forget: the answer comes back as an ordinary outbound verb on
  // /dev/host, because a request the guest is still handling has nothing to
  // return yet. One line per request, and both refusals happen here rather
  // than at the guest — an embedded newline would forge a second request, and
  // an overflowing ring is a guest that is not consuming, which is the host's
  // problem to size.
  post(request) {
    if (!this._requests) {
      throw new Error(
        'session.post() needs the inbound channel, which this session was not granted: '
        + 'pass spawn({ requestBufferSize: 65536 }). Granting it is what makes '
        + '/dev/hostreq openable in the guest.'
      );
    }
    return this._requests.write(frameRequest(request));
  }

  // No more requests are coming. The guest's read hits EOF, so
  // `while read -r req <&3; do ...; done` ends and the script carries on —
  // the only thing that ever ends that loop.
  endRequests() {
    if (this._requests) this._requests.end();
  }

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
