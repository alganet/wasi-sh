import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  createStdinRing, RingWriter, RingReader, RingOverflowError, HEADER_BYTES, SIGINT,
} from '../src/ring.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

function pair(dataBytes = 64) {
  const sab = createStdinRing(dataBytes);
  return { sab, w: new RingWriter(sab), r: new RingReader(sab) };
}

test('createStdinRing sizes the buffer as header + data', () => {
  assert.equal(createStdinRing(64).byteLength, HEADER_BYTES + 64);
  assert.equal(createStdinRing().byteLength, HEADER_BYTES + 65536);
});

test('roundtrip: bytes written come out in order', () => {
  const { w, r } = pair();
  w.write(enc.encode('hello'));
  assert.equal(r.readable, true);
  assert.equal(dec.decode(r.read(1024)), 'hello');
  assert.equal(r.readable, false);
});

test('multi-chunk writes concatenate; partial reads consume in order', () => {
  const { w, r } = pair();
  w.write(enc.encode('ab'));
  w.write(enc.encode('cd'));
  assert.equal(dec.decode(r.read(3)), 'abc');
  assert.equal(dec.decode(r.read(3)), 'd');
  assert.equal(r.read(3).length, 0);
});

test('wraparound: data crossing the capacity boundary survives', () => {
  const { w, r } = pair(16);
  // Fill 12, drain, then write 10 — the second write wraps past index 16.
  w.write(enc.encode('0123456789ab'));
  assert.equal(dec.decode(r.read(64)), '0123456789ab');
  w.write(enc.encode('wraparound'));
  assert.equal(dec.decode(r.read(64)), 'wraparound');
});

test('monotonic counters stay correct over many wrap cycles', () => {
  const { w, r } = pair(8);
  for (let i = 0; i < 1000; i++) {
    const msg = `m${i % 10}`;
    w.write(enc.encode(msg));
    assert.equal(dec.decode(r.read(8)), msg, `cycle ${i}`);
  }
  assert.equal(w.pending, 0);
});

test('overflow throws RingOverflowError and leaves the ring intact', () => {
  const { w, r } = pair(8);
  w.write(enc.encode('12345'));
  assert.throws(() => w.write(enc.encode('6789')), RingOverflowError);
  // Ring is unchanged: the buffered bytes are still readable.
  assert.equal(dec.decode(r.read(8)), '12345');
  // After draining there is room again.
  w.write(enc.encode('6789'));
  assert.equal(dec.decode(r.read(8)), '6789');
});

test('end(): reader drains buffered bytes, then reports closed', () => {
  const { w, r } = pair();
  w.write(enc.encode('tail'));
  w.end();
  assert.equal(r.ended, true);
  assert.equal(r.closed, false, 'not closed while data is buffered');
  assert.equal(dec.decode(r.readBlocking(16)), 'tail');
  assert.equal(r.closed, true);
  assert.equal(r.readBlocking(16).length, 0, 'readBlocking returns empty at EOF');
  assert.equal(r.pollReadable(50), false, 'pollReadable is false at EOF without waiting');
});

test('write after end throws', () => {
  const { w } = pair();
  w.end();
  assert.throws(() => w.write(enc.encode('x')), /already ended/);
});

test('toInput() implements the shim input contract', () => {
  const { w, r } = pair();
  const input = r.toInput();
  assert.equal(input.pollReadable(0), false);
  assert.equal(input.closed(), false);
  w.write(enc.encode('k'));
  assert.equal(input.pollReadable(0), true);
  assert.equal(dec.decode(input.read(4)), 'k');
  w.end();
  assert.equal(input.closed(), true);
});

// ─── Cross-thread: real Atomics.wait wake-ups ────────────────────────────────
// A worker_threads consumer parks in readBlocking; the main thread writes (or
// ends) after a delay. worker_threads shares SAB/Atomics semantics with Web
// Workers, so this is the browser-fidelity test.

// The worker announces 'armed' right before parking, so the main thread never
// races the worker's boot (module load can take longer than any fixed sleep).
const WORKER_SRC = `
  import { parentPort, workerData } from 'node:worker_threads';
  const { RingReader } = await import(workerData.ringUrl);
  const r = new RingReader(workerData.sab);
  parentPort.postMessage({ armed: true });
  const t0 = Date.now();
  const bytes = r.readBlocking(64);
  parentPort.postMessage({ bytes, waitedMs: Date.now() - t0, closed: r.closed });
`;

function spawnReader(sab) {
  const worker = new Worker(WORKER_SRC, {
    eval: true,
    workerData: { sab, ringUrl: new URL('../src/ring.mjs', import.meta.url).href },
  });
  let armedResolve;
  const armed = new Promise((res) => { armedResolve = res; });
  const done = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.armed) armedResolve();
      else { resolve(m); worker.terminate(); }
    });
    worker.once('error', reject);
  });
  return { armed, done };
}

test('cross-thread: blocked readBlocking wakes on write', async () => {
  const { sab, w } = pair();
  const { armed, done } = spawnReader(sab);
  await armed;
  await new Promise((res) => setTimeout(res, 80)); // let the worker park
  w.write(enc.encode('wake'));
  const m = await done;
  assert.equal(dec.decode(new Uint8Array(m.bytes)), 'wake');
  assert.ok(m.waitedMs >= 40, `parked before the write (waited ${m.waitedMs}ms)`);
});

test('cross-thread: blocked readBlocking wakes on end() with EOF', async () => {
  const { sab, w } = pair();
  const { armed, done } = spawnReader(sab);
  await armed;
  await new Promise((res) => setTimeout(res, 80));
  const t0 = Date.now();
  w.end();
  const m = await done;
  assert.equal(m.bytes.length, 0, 'EOF read is empty');
  assert.equal(m.closed, true);
  assert.ok(Date.now() - t0 < 5000, 'woke promptly, not via the 30s re-check');
});

// ---- terminal geometry: winsize slots + synthesized-winch flag -------------

test('resize() stores geometry the reader reads back', () => {
  const { w, r } = pair();
  assert.deepEqual(r.winsize(), { rows: 0, cols: 0 }); // unknown before any resize
  w.resize(100, 40);
  assert.deepEqual(r.winsize(), { rows: 40, cols: 100 });
  w.resize(80, 24); // last-write-wins
  assert.deepEqual(r.winsize(), { rows: 24, cols: 80 });
});

test('resize() raises winch; takeWinch() consumes it exactly once', () => {
  const { w, r } = pair();
  assert.equal(r.takeWinch(), false); // nothing pending initially
  w.resize(120, 30);
  assert.equal(r.takeWinch(), true);  // one resize -> one winch
  assert.equal(r.takeWinch(), false); // ...consumed
  w.resize(120, 31);
  w.resize(120, 32); // a burst coalesces to a single pending flag
  assert.equal(r.takeWinch(), true);
  assert.equal(r.takeWinch(), false);
  assert.deepEqual(r.winsize(), { rows: 32, cols: 120 }); // ...at the newest size
});

test('seedWinsize() sets geometry WITHOUT raising winch (startup path)', () => {
  const { w, r } = pair();
  w.seedWinsize(90, 25);
  assert.deepEqual(r.winsize(), { rows: 25, cols: 90 });
  assert.equal(r.takeWinch(), false); // no signal at seed time
});

test('resize() bumps seq so a parked poll wakes', () => {
  const { sab, w, r } = pair();
  const ctrl = new Int32Array(sab, 0, 7);
  const seq0 = Atomics.load(ctrl, 3);            // IDX_SEQ
  w.resize(100, 40);
  assert.ok(Atomics.load(ctrl, 3) > seq0, 'seq advanced (would wake Atomics.wait)');
  // pollReadable still reports no DATA — a winch is not stdin input
  assert.equal(r.readable, false);
});

test('toInput() exposes winsize()/takeWinch() for the shim', () => {
  const { w, r } = pair();
  const input = r.toInput();
  w.resize(77, 21);
  assert.deepEqual(input.winsize(), { rows: 21, cols: 77 });
  assert.equal(input.takeWinch(), true);
  assert.equal(input.takeWinch(), false);
});

// ─── the cooperative interrupt ───────────────────────────────────────────────

test('interrupt() is a COUNT, so there is nothing to consume and nothing to miss', () => {
  const { w, r } = pair();
  assert.equal(r.interruptCount(), 0);
  w.interrupt();
  assert.equal(r.interruptCount(), 1);
  // Reading does not consume: the reader that compares against a baseline must
  // keep seeing the same answer for as long as it keeps asking.
  assert.equal(r.interruptCount(), 1);
  w.interrupt();
  w.interrupt();
  assert.equal(r.interruptCount(), 3, 'a burst is three interrupts, not one flag');
});

test('an interrupt posted while nothing is running cannot cancel the next thing', () => {
  // The whole reason this is a count rather than a flag. A ^C at the prompt
  // raises it; the command typed afterwards takes its own baseline and is
  // unaffected. A flag would have sat there waiting to kill it.
  const { w, r } = pair();
  w.interrupt();                          // ^C with nothing running
  const base = r.interruptCount();        // the next command starts here
  assert.equal(r.interruptCount() !== base, false, 'not interrupted');
  w.interrupt();                          // ^C DURING that command
  assert.equal(r.interruptCount() !== base, true, 'interrupted');
});

test('raise() also writes the signal a guest polls in memory', () => {
  // The count above is delivery for anything that CALLS us — a host builtin at
  // its safe points. A guest with its own signal handling calls nothing: it
  // reads a byte at a check it already runs, and while it runs this thread does
  // not, so writing that byte is the only way to reach it.
  const { w, r } = pair();
  const cell = r.toInput().signalBuffer();
  assert.equal(cell.length, 1, 'one byte, which is the shape a guest polls');
  assert.equal(cell[0], 0);

  w.interrupt();
  assert.equal(cell[0], SIGINT, 'interrupt() is raise(SIGINT)');
  assert.equal(r.interruptCount(), 1, 'and the count is still raised, for whoever polls that');
});

test('the guest clears the signal cell, so it re-arms with no help from us', () => {
  // CPython zeroes the byte once it has raised KeyboardInterrupt. Nothing on
  // this side consumes it, which is why a second raise() is all re-arming takes.
  const { w, r } = pair();
  const cell = r.toInput().signalBuffer();
  w.interrupt();
  Atomics.store(cell, 0, 0);              // what the guest does
  assert.equal(cell[0], 0);
  w.raise(15);                            // SIGTERM, to show the number is not baked in
  assert.equal(cell[0], 15);
  assert.equal(r.interruptCount(), 2);
});

test('the signal cell does not overlap the ring or its other fields', () => {
  // It has its own word in the header. If it aliased head/tail/seq, a ^C would
  // corrupt the stream rather than interrupt it.
  const { sab, w, r } = pair(64);
  const before = new Int32Array(sab.slice(0, HEADER_BYTES));
  w.write(enc.encode('hello'));
  const mid = r.read(5);
  w.raise(SIGINT);
  assert.equal(dec.decode(mid), 'hello');
  assert.equal(r.readable, false, 'the ring is where it was left');
  // every control word except the signal and the counters it moves is untouched
  const after = new Int32Array(sab, 0, before.length);
  for (let i = 0; i < before.length; i++) {
    if (i === 0 || i === 1 || i === 3 || i === 7 || i === 8) continue; // head, tail, seq, intr, signal
    assert.equal(after[i], before[i], `control word ${i} moved`);
  }
});

test('interrupt() bumps seq so a parked guest wakes', () => {
  const { sab, w, r } = pair();
  const ctrl = new Int32Array(sab, 0, 8);
  const seq0 = Atomics.load(ctrl, 3);            // IDX_SEQ
  w.interrupt();
  assert.ok(Atomics.load(ctrl, 3) > seq0, 'seq advanced (would wake Atomics.wait)');
  assert.equal(r.readable, false, 'an interrupt is not stdin input');
});

test('toInput() exposes interruptCount() for the shim', () => {
  const { w, r } = pair();
  const input = r.toInput();
  assert.equal(input.interruptCount(), 0);
  w.interrupt();
  assert.equal(input.interruptCount(), 1);
});

// After 2 GiB through a ring, its Int32 counters wrap — and a dev environment's
// session is exactly the one that runs long enough to. src/fs.mjs's journal has
// carried the same counters and the same wrap since it was written, and says so
// (see jBehind/jIndex); this ring did not, and every consequence below is a
// different way for the shell's stdin to stop working for good.
const IDX_HEAD = 0, IDX_TAIL = 1;

/** Put both counters `before` bytes short of the Int32 wrap, as a long session does. */
function nearTheWrap(sab, before = 8) {
  const ctrl = new Int32Array(sab, 0, 8);
  // 2**31 exactly is where an Int32 cell turns negative, so a write of more
  // than `before` bytes is the one that crosses it.
  const at = 2 ** 31 - before;
  Atomics.store(ctrl, IDX_HEAD, at);
  Atomics.store(ctrl, IDX_TAIL, at);
  return ctrl;
}

test('a ring that has carried 2 GiB still carries bytes', () => {
  const { sab, w, r } = pair();
  nearTheWrap(sab, 4);
  // Straddles the wrap: four bytes before it, four after.
  w.write(enc.encode('abcdefgh'));
  assert.equal(w.pending, 8, 'the producer counts what it wrote');
  assert.equal(r.readable, true, 'and the consumer sees it');
  assert.equal(dec.decode(r.read(1024)), 'abcdefgh');
  assert.equal(w.pending, 0, 'and the counters agree it was consumed');
});

test('the overflow guard survives the wrap', () => {
  // The guard is `cap - (head - tail)`, and a wrapped difference reads as about
  // -4 billion: free space looks limitless, the write is accepted, and every
  // byte of it lands at a negative index — which a typed array drops on the
  // floor. A silent no-op is the worst answer available here.
  const { sab, w } = pair(64);
  nearTheWrap(sab, 4);
  w.write(enc.encode('1234'));                     // fills to the wrap exactly
  assert.equal(w.pending, 4);
  assert.throws(() => w.write(new Uint8Array(80)), RingOverflowError, 'an overfull ring still says so');
});

test('a wrapped ring reports EOF rather than throwing into the guest', () => {
  // `read()` sizes its output with `head - tail`; wrapped, that is negative, and
  // `new Uint8Array(-4e9)` is a RangeError thrown out of a wasm import — where
  // the shell has nowhere to put it.
  const { sab, w, r } = pair();
  nearTheWrap(sab, 2);
  w.write(enc.encode('xy'));
  w.end();
  assert.equal(dec.decode(r.read(1024)), 'xy');
  assert.equal(r.closed, true, 'drained and ended is EOF');
  assert.deepEqual(r.read(1024), new Uint8Array(0), 'and a read past it is empty, not an exception');
});

// ── The async park ──────────────────────────────────────────────────────────
//
// `pollReadableAsync` / `readBlockingAsync` are `pollReadable` / `readBlocking`
// with the thread given back while they wait, which is what lets a suspending
// guest park without stopping the worker under it (see shim.mjs's
// `suspendInput`). They are also usable from the main thread, where
// `Atomics.wait` is forbidden and these are not.
//
// On node they run on `wakeTick`'s timer rather than on `Atomics.waitAsync`,
// because node does not wake a parked agent on `Atomics.notify` — that is what
// `wakeTick` is for and why it defaults on here. So these cases pin the
// CONTRACT on every platform and the mechanism only on this one; the
// event-driven path is exercised in a browser, where it is the only path.

test('wakeTick defaults on under node, and is overridable', () => {
  const sab = createStdinRing(64);
  assert.ok(new RingReader(sab).wakeTick > 0, 'node needs the timer; see _waitForAsync');
  assert.equal(new RingReader(sab, { wakeTick: 0 }).wakeTick, 0);
  // A tick that is not a positive number would silently pick the branch that
  // never wakes here, so it is coerced rather than trusted.
  assert.equal(new RingReader(sab, { wakeTick: -5 }).wakeTick, 0);
  assert.equal(new RingReader(sab, { wakeTick: 'x' }).wakeTick, 0);
});

test('pollReadableAsync wakes on a write that lands while it waits', async () => {
  const { w, r } = pair();
  const t0 = Date.now();
  const waiting = r.pollReadableAsync(null);
  setTimeout(() => w.write(enc.encode('hi')), 60);
  assert.equal(await waiting, true);
  assert.ok(Date.now() - t0 >= 50, 'it really waited rather than answering at once');
  assert.equal(dec.decode(r.read(64)), 'hi');
});

test('pollReadableAsync answers at once when bytes are already there', async () => {
  const { w, r } = pair();
  w.write(enc.encode('hi'));
  const t0 = Date.now();
  assert.equal(await r.pollReadableAsync(null), true);
  assert.ok(Date.now() - t0 < 50, 'no park for a ring that is already readable');
});

test('pollReadableAsync gives up when its timeout elapses', async () => {
  const { r } = pair();
  const t0 = Date.now();
  assert.equal(await r.pollReadableAsync(120), false);
  const waited = Date.now() - t0;
  assert.ok(waited >= 100, `waited the timeout (${waited}ms)`);
  assert.ok(waited < 400, `and only once — a double wait is the read -t bug (${waited}ms)`);
});

test('pollReadableAsync ends on a pending winch, so a resize is not sat out', async () => {
  const { w, r } = pair();
  const t0 = Date.now();
  const waiting = r.pollReadableAsync(null);
  setTimeout(() => w.resize(100, 30), 60);
  // False, because a resize is not bytes — but it RETURNS, which is the whole
  // point: the guest's poll wrapper then runs and synthesizes the SIGWINCH.
  assert.equal(await waiting, false);
  assert.ok(Date.now() - t0 < 2000, 'the resize ended the park');
  assert.equal(r.winchPending(), true);
});

test('readBlockingAsync parks, then hands over what arrived', async () => {
  const { w, r } = pair();
  const waiting = r.readBlockingAsync(64);
  setTimeout(() => w.write(enc.encode('later')), 60);
  assert.equal(dec.decode(await waiting), 'later');
});

test('readBlockingAsync returns empty at EOF rather than parking forever', async () => {
  const { w, r } = pair();
  const waiting = r.readBlockingAsync(64);
  setTimeout(() => w.end(), 60);
  assert.equal((await waiting).length, 0);
  assert.equal(r.closed, true);
});

test('toInput() carries both async methods, which is what the shim gates on', () => {
  const { r } = pair();
  const input = r.toInput();
  assert.equal(typeof input.pollReadableAsync, 'function');
  assert.equal(typeof input.readBlockingAsync, 'function');
});
