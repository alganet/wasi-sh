import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  createStdinRing, RingWriter, RingReader, RingOverflowError, HEADER_BYTES,
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
