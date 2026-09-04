// Session lifecycle semantics, unit-tested with a fake worker (the real
// message protocol is exercised in a browser; these pin the promise/callback
// contract, especially that `exited` ALWAYS settles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/spawn.mjs';

// Minimal Worker stand-in. Session SUBSCRIBES with addEventListener rather than
// assigning onmessage, so a caller-supplied worker (a serve() module has its
// own handler) is not silently clobbered — the fake models that, and keeps a
// list so a second subscriber would be visible.
function fakeWorker() {
  return {
    terminated: 0,
    listeners: { message: [], error: [] },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    terminate() { this.terminated++; },
    emit(m) { for (const fn of this.listeners.message) fn({ data: m }); },
    emitError(e) { for (const fn of this.listeners.error) fn(e); },
  };
}

test('terminate() settles exited with 137 and fires onExit', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  const codes = [];
  s.onExit((c) => codes.push(c));
  s.terminate();
  assert.equal(await s.exited, 137);
  assert.deepEqual(codes, [137]);
  assert.ok(w.terminated >= 1, 'worker was killed');
});

test('worker exit message settles exited with the guest code', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  w.emit({ type: 'ready' });
  w.emit({ type: 'exit', code: 5 });
  assert.equal(await s.exited, 5);
  assert.equal(w.terminated, 1, 'owned worker disposed on exit');
});

test('exit is first-wins: terminate() after a real exit keeps the real code', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  const codes = [];
  s.onExit((c) => codes.push(c));
  w.emit({ type: 'exit', code: 3 });
  s.terminate();
  assert.equal(await s.exited, 3);
  assert.deepEqual(codes, [3], 'onExit fires exactly once');
});

test('output bytes fan out to subscribers with the channel', () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  const seen = [];
  const unsub = s.onOutput((b, ch) => seen.push([ch, new TextDecoder().decode(b)]));
  w.emit({ type: 'out', channel: 'stdout', bytes: new TextEncoder().encode('hi') });
  unsub();
  w.emit({ type: 'out', channel: 'stderr', bytes: new TextEncoder().encode('bye') });
  assert.deepEqual(seen, [['stdout', 'hi']]);
});

test('error before ready rejects spawn readiness and fires onError', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  const errs = [];
  s.onError((e) => errs.push(e.message));
  w.emit({ type: 'error', msg: 'instantiation failed' });
  await assert.rejects(() => s._ready, /instantiation failed/);
  assert.deepEqual(errs, ['instantiation failed']);
});

test('error message settles exited (134) — a guest trap must not hang awaiters', async () => {
  // Regression: the error path fired onError but never settled `exited`, so a
  // guest that trapped mid-session left `await session.exited` pending forever,
  // violating the documented "always settles" contract.
  const w = fakeWorker();
  const s = new Session(w, null, true);
  s._ready.catch(() => {});
  w.emit({ type: 'ready' });
  w.emit({ type: 'error', msg: 'guest trapped' });
  assert.equal(await s.exited, 134);
  assert.ok(w.terminated >= 1, 'owned worker disposed after an error');
});

test('a worker error event settles exited (134) too', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  s._ready.catch(() => {});
  const errs = [];
  s.onError((e) => errs.push(e.message));
  w.emitError({ message: 'worker blew up' });
  assert.equal(await s.exited, 134);
  assert.deepEqual(errs, ['worker blew up']);
});

// ─── ports ───────────────────────────────────────────────────────────────────

const openPort = (port, address = '0.0.0.0') => ({ type: 'port', event: { type: 'open', address, port } });
const closePort = (port, address = '0.0.0.0') => ({ type: 'port', event: { type: 'close', address, port } });

test('ports() is what is open now, not a log of what has been', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  w.emit(openPort(8000));
  w.emit(openPort(5173));
  assert.deepEqual(s.ports().map((p) => p.port).sort(), [5173, 8000]);
  w.emit(closePort(8000));
  assert.deepEqual(s.ports().map((p) => p.port), [5173]);
});

test('ports() hands back a copy, so a render cannot be changed underneath', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  w.emit(openPort(8000));
  const before = s.ports();
  before[0].port = 9999;
  w.emit(closePort(8000));
  assert.equal(before.length, 1, 'the array taken earlier still describes then');
  assert.deepEqual(s.ports(), []);
});

test('onPort is caught up with what is already listening', async () => {
  // Otherwise every caller needs a ports() beside its subscribe and a rule for
  // which won the race — and the two orders disagree exactly when a server
  // starts during boot.
  const w = fakeWorker();
  const s = new Session(w, null, true);
  w.emit(openPort(8000));
  const seen = [];
  s.onPort((e) => seen.push(`${e.type}:${e.port}`));
  assert.deepEqual(seen, ['open:8000']);
  w.emit(openPort(5173));
  assert.deepEqual(seen, ['open:8000', 'open:5173']);
});

test('the same port opened twice is reported once', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  const seen = [];
  s.onPort((e) => seen.push(e.type));
  w.emit(openPort(8000));
  w.emit(openPort(8000));
  assert.deepEqual(seen, ['open']);
});

test('a close for a port that never opened says nothing', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  const seen = [];
  s.onPort((e) => seen.push(e.type));
  w.emit(closePort(8000));
  assert.deepEqual(seen, []);
});

test('the same port on two addresses is two ports', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  w.emit(openPort(8000, '127.0.0.1'));
  w.emit(openPort(8000, '0.0.0.0'));
  assert.equal(s.ports().length, 2);
  w.emit(closePort(8000, '127.0.0.1'));
  assert.deepEqual(s.ports().map((p) => p.address), ['0.0.0.0']);
});

test('a session that ends closes its ports', async () => {
  // A trap and terminate() report nothing on the way out, and a watcher left
  // pointed at a port with nothing behind it is worse than one told twice.
  const w = fakeWorker();
  const s = new Session(w, null, true);
  const seen = [];
  w.emit(openPort(8000));
  s.onPort((e) => seen.push(`${e.type}:${e.port}`));
  s.terminate();
  await s.exited;
  assert.deepEqual(seen, ['open:8000', 'close:8000']);
  assert.deepEqual(s.ports(), []);
});

test('unsubscribing stops the reports', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  const seen = [];
  const off = s.onPort((e) => seen.push(e.port));
  w.emit(openPort(8000));
  off();
  w.emit(openPort(5173));
  assert.deepEqual(seen, [8000]);
});
