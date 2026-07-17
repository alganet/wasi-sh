// SharedArrayBuffer stdin ring — the one blocking channel between a producer
// (main thread / any feeder) and the shell worker. The worker parks inside
// Atomics.wait so the guest's blocking `read` and timed `read -t` cost nothing;
// the producer stores bytes and Atomics.notify's it awake.
//
// Layout: Int32[head, tail, flags, seq, winRows, winCols, winch] header
// (28 bytes), then the data ring.
// head (written by the producer) and tail (written by the consumer) are
// MONOTONIC byte counters — only the data index is reduced modulo capacity —
// so `head - tail` is always the number of unread bytes and the ABA problem
// can't happen. flags bit 0 marks stdin EOF (set once by RingWriter.end()).
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
// Both sides of the package import this module — the writer (spawn/Session)
// and the reader (worker) — so the format has a single source of truth.

const IDX_HEAD = 0;
const IDX_TAIL = 1;
const IDX_FLAGS = 2;
const IDX_SEQ = 3;
const IDX_WIN_ROWS = 4;
const IDX_WIN_COLS = 5;
const IDX_WINCH = 6;
const CTRL_WORDS = 7;
const FLAG_EOF = 1;
export const HEADER_BYTES = CTRL_WORDS * 4;

// A SharedArrayBuffer sized for `dataBytes` of ring capacity.
export function createStdinRing(dataBytes = 65536) {
  return new SharedArrayBuffer(HEADER_BYTES + dataBytes);
}

export class RingOverflowError extends Error {
  constructor(requested, free) {
    super(
      `stdin ring overflow: tried to write ${requested} bytes but only ${free} are free. ` +
      `The guest is not consuming stdin fast enough (or at all); ` +
      `increase stdinBufferSize or throttle writes.`
    );
    this.name = 'RingOverflowError';
  }
}

// Producer side. Lives on a thread that must never block (the main thread),
// so overflow throws instead of waiting.
export class RingWriter {
  constructor(sab) {
    this.ctrl = new Int32Array(sab, 0, CTRL_WORDS);
    this.data = new Uint8Array(sab, HEADER_BYTES);
    this.cap = sab.byteLength - HEADER_BYTES;
  }
  get capacity() { return this.cap; }
  get pending() { return Atomics.load(this.ctrl, IDX_HEAD) - Atomics.load(this.ctrl, IDX_TAIL); }
  get ended() { return (Atomics.load(this.ctrl, IDX_FLAGS) & FLAG_EOF) !== 0; }

  _wake() {
    Atomics.add(this.ctrl, IDX_SEQ, 1);
    Atomics.notify(this.ctrl, IDX_SEQ);
  }

  // Append bytes and wake the consumer. Returns the byte count written.
  write(bytes) {
    if (this.ended) throw new Error('stdin ring already ended');
    const head = Atomics.load(this.ctrl, IDX_HEAD);
    const tail = Atomics.load(this.ctrl, IDX_TAIL);
    const free = this.cap - (head - tail);
    if (bytes.length > free) throw new RingOverflowError(bytes.length, free);
    for (let i = 0; i < bytes.length; i++) this.data[(head + i) % this.cap] = bytes[i];
    Atomics.store(this.ctrl, IDX_HEAD, head + bytes.length);
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

  // Set the geometry WITHOUT raising winch or waking — used once at spawn so
  // the very first `stty size` / ioctl(TIOCGWINSZ) reports the real size before
  // any resize has happened. No signal: the guest hasn't installed a trap yet.
  seedWinsize(cols, rows) {
    Atomics.store(this.ctrl, IDX_WIN_COLS, Math.max(0, Math.min(0xffff, cols | 0)));
    Atomics.store(this.ctrl, IDX_WIN_ROWS, Math.max(0, Math.min(0xffff, rows | 0)));
  }
}

// Consumer side. Lives on a worker thread where Atomics.wait is allowed.
// toInput() adapts it to the WasiShim `input` contract.
export class RingReader {
  constructor(sab) {
    this.ctrl = new Int32Array(sab, 0, CTRL_WORDS);
    this.data = new Uint8Array(sab, HEADER_BYTES);
    this.cap = sab.byteLength - HEADER_BYTES;
  }
  get readable() { return Atomics.load(this.ctrl, IDX_TAIL) < Atomics.load(this.ctrl, IDX_HEAD); }
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

  // True when data is available, waiting up to `ms` for some to arrive. A
  // pending winch also ends the wait (still returning not-readable) so a resize
  // during a long `read -t` is delivered promptly — the guest's poll wrapper
  // then runs and synthesizes the SIGWINCH — instead of only at the timeout.
  pollReadable(ms) {
    if (this.readable) return true;
    if (this.closed) return false;
    if (ms > 0) this._waitFor(() => this.readable || this.closed || this.winchPending(), ms);
    return this.readable;
  }

  // Non-blocking: up to `max` buffered bytes (possibly zero).
  read(max) {
    const head = Atomics.load(this.ctrl, IDX_HEAD);
    const tail = Atomics.load(this.ctrl, IDX_TAIL);
    const n = Math.min(max, head - tail);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.data[(tail + i) % this.cap];
    Atomics.store(this.ctrl, IDX_TAIL, tail + n);
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

  // Consume the pending-winch flag: true exactly once per resize burst. The
  // guest polls this at its blocking point and, when true, synthesizes a
  // pending SIGWINCH so a registered `trap ... WINCH` fires.
  takeWinch() {
    return Atomics.exchange(this.ctrl, IDX_WINCH, 0) !== 0;
  }

  // The WasiShim `input` contract, bound to this reader.
  toInput() {
    return {
      pollReadable: (ms) => this.pollReadable(ms),
      read: (max) => this.read(max),
      readBlocking: (max) => this.readBlocking(max),
      wait: (ms) => this.wait(ms),
      closed: () => this.closed,
      winsize: () => this.winsize(),
      takeWinch: () => this.takeWinch(),
    };
  }
}
