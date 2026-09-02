// SharedArrayBuffer stdin ring — the one blocking channel between a producer
// (main thread / any feeder) and the shell worker. The worker parks inside
// Atomics.wait so the guest's blocking `read` and timed `read -t` cost nothing;
// the producer stores bytes and Atomics.notify's it awake.
//
// Layout: Int32[head, tail, flags, seq, winRows, winCols, winch, intr] header
// (32 bytes), then the data ring.
// head (written by the producer) and tail (written by the consumer) are
// MONOTONIC byte counters — only the data index is reduced modulo capacity —
// so the distance between them is always the number of unread bytes and the
// ABA problem can't happen. Monotonic in Int32 CELLS, though, so after 2 GiB
// through the channel they wrap negative, and a terminal session is exactly the
// thing that runs long enough. Two's complement makes that harmless provided
// every comparison goes through `behind()` below and every index through
// `index()` — which is why neither counter is ever compared or used raw here. flags bit 0 marks stdin EOF (set once by RingWriter.end()).
//
// seq is a wakeup sequence word bumped by every producer event (write, end, OR
// resize). Consumers load seq FIRST, re-check their condition, then Atomics.wait
// on seq with that loaded value — so an event landing between the check and the
// wait changes seq and the wait returns immediately instead of missing the
// notify. (Waiting on head alone would miss end(), which changes no counter.)
//
// winRows/winCols hold the current terminal geometry and `winch` is a pending
// flag (0/1): the producer's resize() stores the new dims, raises winch, and
// wakes; the guest's synthesized SIGWINCH path reads winch (clearing it) and
// pulls the live dims through ioctl(TIOCGWINSZ). Geometry travels here rather
// than as env because env is frozen at spawn — see ARCHITECTURE / MOAR.
//
// `intr` is the cooperative-interrupt word, and it is a MONOTONIC COUNT rather
// than a flag on purpose. A flag has to be consumed by somebody, and the only
// consumer is whatever happens to be running — so an interrupt posted while
// nothing is (between commands, mid-applet) survives to cancel the NEXT thing,
// which is a ^C the user never typed. A count needs no consumer: a handler
// records the value it started at and compares, so an interrupt is delivered to
// exactly the work that was in flight when it was posted, and to nothing else.
//
// Both sides of the package import this module — the writer (spawn/Session)
// and the reader (worker) — so the format has a single source of truth.

const IDX_HEAD = 0;
const IDX_TAIL = 1;
const IDX_FLAGS = 2;
const IDX_SEQ = 3;
const IDX_WIN_ROWS = 4;
const IDX_WIN_COLS = 5;
const IDX_WINCH = 6;
const IDX_INTR = 7;
// A POSIX signal number for a guest that polls MEMORY rather than calling a
// closure. See `signalBuffer()`. Its own word so that the byte view over it is
// aligned and so that nothing shares a cache line with the counter above.
const IDX_SIGNAL = 8;
const CTRL_WORDS = 9;
const FLAG_EOF = 1;
export const HEADER_BYTES = CTRL_WORDS * 4;

/**
 * The signal this session raises for ^C, and the default for `raise()`.
 *
 * POSIX's number, not one of ours, because the whole point of the byte it is
 * written into is that a guest already knows what to do with it.
 */
export const SIGINT = 2;

// A SharedArrayBuffer sized for `dataBytes` of ring capacity.
//
// One format, two channels. The inbound host-request ring is not a near-copy of
// this one — it IS this one, because a request channel needs head/tail/flags/seq
// and nothing else, and those are a strict subset of what stdin needs. The
// terminal words simply go unused there. So the reader and writer below serve
// both directions with no adapter, and the wake mechanics that took a bug fix
// to get right exist once.
export function createRing(dataBytes = 65536) {
  return new SharedArrayBuffer(HEADER_BYTES + dataBytes);
}
export { createRing as createStdinRing };

// The distance between two monotonic counters, across the Int32 wrap: `(a - b)
// | 0` is the real one whenever it is under 2 GiB, which a ring's capacity
// guarantees, while `a - b` on the raw values reads as about -4 billion the
// moment one side has wrapped and the other has not. src/fs.mjs's journal
// carries the same pair for the same reason (jBehind/jIndex there); they are
// two lines each and duplicated rather than shared, because neither module
// otherwise knows the other exists.
const behind = (a, b) => (a - b) | 0;
// And the same wrap makes a raw `%` negative — which a typed array does not
// throw over, it just drops the write on the floor.
const index = (position, capacity) => ((position % capacity) + capacity) % capacity;

const ENC = new TextEncoder();

// Frame one inbound request for the guest's /dev/hostreq. A request is a LINE
// — the vocabulary the outbound half settled, for the same reason: a write
// boundary is not a frame, because stdio splits where it likes.
//
// Both refusals happen HERE, at the producer, and that is the whole design of
// inbound error reporting. A request arriving at a parked guest has no write to
// fail and no `$?` to reach, so an error it could only learn by reading is one
// it cannot act on. The host can: it is the one holding the request.
//
// A newline inside a request would silently become two requests, the second of
// them forged. An empty one would deliver a blank line, which the outbound half
// already defines as not a request at all.
export function frameRequest(request) {
  const bytes = typeof request === 'string' ? ENC.encode(request)
    : (request instanceof Uint8Array ? request : new Uint8Array(request));
  if (!bytes.length) throw new Error('host request: empty. A request is a line with something on it; a blank line is not a request.');
  const nl = bytes.indexOf(0x0a);
  if (nl >= 0) {
    throw new Error(
      `host request: contains a newline at byte ${nl}, and a request is one line — `
      + 'delivering it would forge a second request out of the remainder. Encode the '
      + 'payload (percent, base64, JSON) or pass a handle the guest fetches with a verb.'
    );
  }
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = 0x0a;
  return out;
}

// Two channels share this ring, so an overflow has to name the one that
// overflowed and the option that sizes it. "increase stdinBufferSize" is a
// wrong answer for a host request, and a wrong answer costs more than none.
export class RingOverflowError extends Error {
  constructor(requested, free, channel = 'stdin', sizeOption = 'stdinBufferSize') {
    super(
      `${channel} ring overflow: tried to write ${requested} bytes but only ${free} are free. ` +
      `The guest is not consuming ${channel} fast enough (or at all); ` +
      `increase ${sizeOption} or throttle writes.`
    );
    this.name = 'RingOverflowError';
    this.channel = channel;
  }
}

// Producer side. Lives on a thread that must never block (the main thread),
// so overflow throws instead of waiting.
export class RingWriter {
  // `channel`/`sizeOption` only ever appear in failures — see RingOverflowError.
  constructor(sab, { channel = 'stdin', sizeOption = 'stdinBufferSize' } = {}) {
    this.ctrl = new Int32Array(sab, 0, CTRL_WORDS);
    // A ONE-BYTE view over IDX_SIGNAL. A byte rather than the whole word
    // because that is the shape a guest polls — CPython's interrupt buffer is
    // `buf[0]` — and writing it as a byte means the value lands in the same
    // place on a big-endian host as on a little-endian one.
    this.signal = new Uint8Array(sab, IDX_SIGNAL * 4, 1);
    this.data = new Uint8Array(sab, HEADER_BYTES);
    this.cap = sab.byteLength - HEADER_BYTES;
    this.channel = channel;
    this.sizeOption = sizeOption;
  }
  get capacity() { return this.cap; }
  get pending() { return behind(Atomics.load(this.ctrl, IDX_HEAD), Atomics.load(this.ctrl, IDX_TAIL)); }
  get ended() { return (Atomics.load(this.ctrl, IDX_FLAGS) & FLAG_EOF) !== 0; }

  _wake() {
    Atomics.add(this.ctrl, IDX_SEQ, 1);
    Atomics.notify(this.ctrl, IDX_SEQ);
  }

  // Append bytes and wake the consumer. Returns the byte count written.
  write(bytes) {
    if (this.ended) throw new Error(`${this.channel} ring already ended`);
    const head = Atomics.load(this.ctrl, IDX_HEAD);
    const tail = Atomics.load(this.ctrl, IDX_TAIL);
    const free = this.cap - behind(head, tail);
    if (bytes.length > free) throw new RingOverflowError(bytes.length, free, this.channel, this.sizeOption);
    for (let i = 0; i < bytes.length; i++) this.data[index(head + i, this.cap)] = bytes[i];
    Atomics.store(this.ctrl, IDX_HEAD, (head + bytes.length) | 0);
    this._wake();
    return bytes.length;
  }

  // Signal stdin EOF: the consumer drains what is buffered, then reads EOF.
  end() {
    Atomics.or(this.ctrl, IDX_FLAGS, FLAG_EOF);
    this._wake();
  }

  // Post a terminal resize: store the new geometry, raise the pending-winch
  // flag, and wake the parked guest. The guest turns the flag into a
  // synthesized SIGWINCH and reads the dims back via ioctl(TIOCGWINSZ). Dims
  // are last-write-wins and the flag is a single bit, so a burst of resizes
  // coalesces to one WINCH at the newest size. cols/rows are clamped to a
  // sane u16-ish range (0 is treated as "unknown", left to the guest default).
  resize(cols, rows) {
    this.seedWinsize(cols, rows);
    Atomics.store(this.ctrl, IDX_WINCH, 1);
    this._wake();
  }

  // Post a cooperative interrupt: bump the count and wake. This is the ^C the
  // shell has never had — wasm cannot be signalled, so a long-running applet or
  // host builtin holds the worker and only terminate() escapes it, which takes
  // the filesystem and every warm instance with it.
  //
  // It cancels nothing by itself. Delivery is a count somebody chose to read:
  // whoever is running records the count it started at and compares at its own
  // safe points, exactly as a runtime with an interrupt hook already does. So
  // work that never looks is untouched, and an interrupt posted while nothing
  // is running lands between two counts nobody is comparing.
  interrupt() {
    this.raise(SIGINT);
  }

  // Deliver a POSIX signal, both ways at once.
  //
  // `IDX_INTR` is a COUNT, read by whoever chose to compare it — that is
  // `ctx.interrupted()`, and it is what a host builtin polls at its own safe
  // points. But a guest compiled with its own signal handling does not call
  // anything of ours: it reads a byte out of shared memory at its own check,
  // and the only way to reach it is to write the number there. CPython behind
  // Emscripten is the case this exists for, and it clears the byte itself once
  // it has raised — so re-arming needs nothing from this side.
  //
  // Both are written for every signal, because a session can have one of each
  // kind of guest in it and neither knows about the other.
  raise(signo = SIGINT) {
    Atomics.store(this.signal, 0, signo & 0xff);
    Atomics.add(this.ctrl, IDX_INTR, 1);
    this._wake();
  }

  // Set the geometry WITHOUT raising winch or waking — used once at spawn so
  // the very first `stty size` / ioctl(TIOCGWINSZ) reports the real size before
  // any resize has happened. No signal: the guest hasn't installed a trap yet.
  seedWinsize(cols, rows) {
    Atomics.store(this.ctrl, IDX_WIN_COLS, Math.max(0, Math.min(0xffff, cols | 0)));
    Atomics.store(this.ctrl, IDX_WIN_ROWS, Math.max(0, Math.min(0xffff, rows | 0)));
  }
}

/**
 * Whether this platform needs the async wait to poll, and how fast.
 *
 * Non-zero on node and zero everywhere else, because node is the only engine
 * measured that does not wake a parked agent on `Atomics.notify` — see
 * `_waitForAsync`. A browser therefore pays nothing at all for this, which
 * matters: a shell idling at its prompt is the common case, and a timer that
 * fires a hundred times a second under it would be the same busy-wait the
 * suspension was for.
 *
 * Ten milliseconds bounds the wake latency of every suspended read on node: a
 * keystroke waits at most that long, which is under what a terminal notices
 * and far cheaper than the alternative, which is not working there at all.
 *
 * Overridable per reader, so an embedder who has measured their own engine can
 * say so either way.
 */
function defaultWakeTick() {
  const node = globalThis.process && globalThis.process.versions
    && typeof globalThis.process.versions.node === 'string';
  return node ? 10 : 0;
}

// Consumer side. Lives on a worker thread where Atomics.wait is allowed.
// toInput() adapts it to the WasiShim `input` contract.
export class RingReader {
  constructor(sab, { wakeTick = defaultWakeTick() } = {}) {
    // How often an async wait re-checks on a platform that will not wake it.
    // Zero — the correct value, and the browser's — means the wait is purely
    // event-driven and an idle guest costs nothing. See `_waitForAsync`.
    this.wakeTick = Number(wakeTick) > 0 ? Number(wakeTick) : 0;
    this.ctrl = new Int32Array(sab, 0, CTRL_WORDS);
    // A ONE-BYTE view over IDX_SIGNAL. A byte rather than the whole word
    // because that is the shape a guest polls — CPython's interrupt buffer is
    // `buf[0]` — and writing it as a byte means the value lands in the same
    // place on a big-endian host as on a little-endian one.
    this.signal = new Uint8Array(sab, IDX_SIGNAL * 4, 1);
    this.data = new Uint8Array(sab, HEADER_BYTES);
    this.cap = sab.byteLength - HEADER_BYTES;
  }
  get readable() { return behind(Atomics.load(this.ctrl, IDX_HEAD), Atomics.load(this.ctrl, IDX_TAIL)) > 0; }
  get ended() { return (Atomics.load(this.ctrl, IDX_FLAGS) & FLAG_EOF) !== 0; }
  // EOF for the shim: producer ended AND everything buffered was consumed.
  get closed() { return this.ended && !this.readable; }

  // Load seq, re-check `cond`, then park on seq up to `ms`. Returns cond().
  _waitFor(cond, ms) {
    const deadline = ms == null ? null : Date.now() + ms;
    for (;;) {
      const seq = Atomics.load(this.ctrl, IDX_SEQ);
      if (cond()) return true;
      const left = deadline == null ? 30000 : deadline - Date.now();
      if (left <= 0) return cond();
      Atomics.wait(this.ctrl, IDX_SEQ, seq, Math.min(left, 30000));
      if (deadline == null && cond()) return true;
      if (deadline != null && Date.now() >= deadline) return cond();
    }
  }

  // Pending resize (peek, non-consuming). The guest's poll path consumes it via
  // takeWinch() (in the C poll wrapper); this lets a parked poll wake promptly
  // on a resize so that consumption — and the synthesized SIGWINCH — happen
  // within the wait rather than only when the timeout elapses.
  winchPending() { return Atomics.load(this.ctrl, IDX_WINCH) !== 0; }

  // True when data is available, waiting up to `ms` for some to arrive — or
  // FOREVER when `ms` is null, which is how a guest poll with no timeout parks.
  // A pending winch also ends the wait (still returning not-readable) so a
  // resize during a long `read -t` is delivered promptly — the guest's poll
  // wrapper then runs and synthesizes the SIGWINCH — instead of only at the
  // timeout. That break is the whole reason an untimed poll parks HERE rather
  // than in readBlocking(): a resize can end a poll, and nothing ends a read.
  pollReadable(ms) {
    if (this.readable) return true;
    if (this.closed) return false;
    if (ms == null || ms > 0) this._waitFor(() => this.readable || this.closed || this.winchPending(), ms);
    return this.readable;
  }

  // Non-blocking: up to `max` buffered bytes (possibly zero).
  read(max) {
    const head = Atomics.load(this.ctrl, IDX_HEAD);
    const tail = Atomics.load(this.ctrl, IDX_TAIL);
    const n = Math.min(max, behind(head, tail));
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.data[index(tail + i, this.cap)];
    Atomics.store(this.ctrl, IDX_TAIL, (tail + n) | 0);
    return out;
  }

  // Park until bytes arrive (or EOF), then return what's there.
  readBlocking(max) {
    this._waitFor(() => this.readable || this.ended, null);
    return this.read(max); // empty at EOF — closed() tells the shim
  }

  wait(ms) {
    if (ms > 0 && !this.closed) {
      const seq = Atomics.load(this.ctrl, IDX_SEQ);
      Atomics.wait(this.ctrl, IDX_SEQ, seq, ms);
    }
  }

  // Current terminal geometry as posted by the producer's resize(). Zero means
  // "unknown" (never resized) — the shim leaves the guest's default in place.
  winsize() {
    return {
      rows: Atomics.load(this.ctrl, IDX_WIN_ROWS),
      cols: Atomics.load(this.ctrl, IDX_WIN_COLS),
    };
  }

  // Interrupts posted so far — the count, not a flag, so there is nothing to
  // consume and no way for one to be missed or double-delivered. Read it once
  // before the work starts, then compare: different means "interrupted since".
  interruptCount() { return Atomics.load(this.ctrl, IDX_INTR); }

  // Consume the pending-winch flag: true exactly once per resize burst. The
  // guest polls this at its blocking point and, when true, synthesizes a
  // pending SIGWINCH so a registered `trap ... WINCH` fires.
  takeWinch() {
    return Atomics.exchange(this.ctrl, IDX_WINCH, 0) !== 0;
  }

  // The same park as `_waitFor`, without owning the thread while it waits.
  // `Atomics.waitAsync` hands back a promise on the same seq word the producer
  // already notifies, so nothing about the protocol changes — only who is
  // blocked. This is the half a suspending guest needs.
  //
  // `wakeTick` is a workaround for one platform and is measured, not assumed.
  // In a browser worker the notify wakes the thread and the promise settles:
  // a shell with no timer anywhere, whose page never posts to it after boot,
  // reaches its prompt and echoes keystrokes on the ring alone. Node does not
  // wake — the promise stays pending through a notify AND through waitAsync's
  // own timeout, so nothing self-corrects — and a single `setInterval` in the
  // same worker makes both work. That is the known V8/Node gap in
  // `PostNonNestableDelayedTask()` for the foreground task runner
  // (v8:13238), still open on node 24.18.
  //
  // So where the platform will not wake us, we wake ourselves: a plain timer
  // rather than a raced `waitAsync`, because a race the timer wins leaves the
  // waiter registered — at one abandoned waiter per tick, a parked shell would
  // accumulate thousands before the first of them expired.
  async _waitForAsync(cond, ms) {
    const deadline = ms == null ? null : Date.now() + ms;
    for (;;) {
      const seq = Atomics.load(this.ctrl, IDX_SEQ);
      if (cond()) return true;
      const left = deadline == null ? 30000 : deadline - Date.now();
      if (left <= 0) return cond();
      if (this.wakeTick > 0) {
        await new Promise((res) => setTimeout(res, Math.min(left, this.wakeTick)));
      } else {
        const r = Atomics.waitAsync(this.ctrl, IDX_SEQ, seq, Math.min(left, 30000));
        if (r.async) await r.value;
      }
      if (deadline == null && cond()) return true;
      if (deadline != null && Date.now() >= deadline) return cond();
    }
  }

  // pollReadable's twin, with the same break conditions — a pending winch
  // included, so an untimed park still ends on a resize and the guest's poll
  // wrapper gets its chance to synthesize the SIGWINCH.
  async pollReadableAsync(ms) {
    if (this.readable) return true;
    if (this.closed) return false;
    if (ms == null || ms > 0) {
      await this._waitForAsync(() => this.readable || this.closed || this.winchPending(), ms);
    }
    return this.readable;
  }

  // readBlocking's twin: park until bytes arrive (or EOF), then take them.
  async readBlockingAsync(max) {
    await this._waitForAsync(() => this.readable || this.ended, null);
    return this.read(max);
  }

  // The WasiShim `input` contract, bound to this reader.
  toInput() {
    return {
      pollReadable: (ms) => this.pollReadable(ms),
      read: (max) => this.read(max),
      readBlocking: (max) => this.readBlocking(max),
      readBlockingAsync: (max) => this.readBlockingAsync(max),
      pollReadableAsync: (ms) => this.pollReadableAsync(ms),
      wait: (ms) => this.wait(ms),
      closed: () => this.closed,
      winsize: () => this.winsize(),
      winchPending: () => this.winchPending(),
      takeWinch: () => this.takeWinch(),
      interruptCount: () => this.interruptCount(),
      signalBuffer: () => this.signalBuffer(),
    };
  }

  // The signal cell, for a guest that polls memory instead of calling us.
  //
  // Handed out rather than read here on purpose: nothing on this thread runs
  // while the guest does, so the ONLY way a signal reaches a running
  // Emscripten-hosted runtime is for it to hold this view and check it itself.
  // Point CPython's `setInterruptBuffer()` at it and ^C works with no further
  // wiring; a guest that ignores it is exactly as interruptible as before.
  signalBuffer() { return this.signal; }
}
