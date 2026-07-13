// Session lifecycle semantics, unit-tested with a fake worker (the real
// message protocol is exercised in a browser; these pin the promise/callback
// contract, especially that `exited` ALWAYS settles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/spawn.mjs';

// Minimal Worker stand-in: Session assigns onmessage/onerror; we call them.
function fakeWorker() {
  return {
    terminated: 0,
    terminate() { this.terminated++; },
    emit(m) { this.onmessage({ data: m }); },
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

test('worker.onerror settles exited (134) too', async () => {
  const w = fakeWorker();
  const s = new Session(w, null, true);
  s._ready.catch(() => {});
  const errs = [];
  s.onError((e) => errs.push(e.message));
  w.onerror({ message: 'worker blew up' });
  assert.equal(await s.exited, 134);
  assert.deepEqual(errs, ['worker blew up']);
});
