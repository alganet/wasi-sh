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
  const bytes = typeof request === 'string' ? new TextEncoder().encode(request)
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
      winchPending: () => this.winchPending(),
      takeWinch: () => this.takeWinch(),
    };
  }
}
