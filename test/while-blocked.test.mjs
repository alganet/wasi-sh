// serve({ whileBlocked }): work the WORKER does while its guest is parked.
//
// A synchronous park owns the thread, which is what makes `read` behave like a
// terminal's — and it is also why a worker with a second channel of its own (a
// page's fetches, an editor's reads) cannot be asked anything while the guest
// waits for a key. JSPI lifts that by suspending the guest; where there is no
// JSPI, this hook is the way in, and these tests are what say it works.
//
// Driven through the worker_threads twin so what runs is src/worker.mjs itself,
// with `suspendInput` off in every case here: the park under test is the
// synchronous one, on whatever engine the suite happens to have.
import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createRing, RingWriter } from '../src/ring.mjs';

let wasm;
before(async () => {
  wasm = new Uint8Array(await readFile(new URL('../dist/busybox.wasm', import.meta.url)));
});

const TWIN = new URL('./worker-twin.mjs', import.meta.url);
const HOOKED = new URL('./while-blocked.worker.mjs', import.meta.url).href;
const PLAIN = new URL('../src/worker.mjs', import.meta.url).href;
const enc = new TextEncoder();
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// Every worker this file starts, terminated whether its test passed or not: a
// failed assertion skips the cleanup after it, and a live Worker keeps node's
// runner from exiting at all.
const live = new Set();
afterEach(async () => {
  for (const w of live) await w.terminate();
  live.clear();
});

/**
 * One shell in the twin, parked on a stdin ring, plus the second channel.
 *
 * `module` chooses whether the worker has the hook: the same startup message
 * and the same script either way, so the only difference between the two is
 * the thing under test.
 */
async function start({ module = HOOKED, script = 'read -r line; echo "typed: $line"\n' } = {}) {
  const worker = new Worker(TWIN, { workerData: { module } });
  live.add(worker);
  const dec = new TextDecoder();
  const seen = { out: '', answered: [], exit: undefined, error: null };
  let ready;
  const readied = new Promise((res) => { ready = res; });
  worker.on('message', (m) => {
    if (m.type === 'out') for (const r of (m.runs || [m])) seen.out += dec.decode(new Uint8Array(r.bytes));
    else if (m.type === 'answered') seen.answered.push(m.line);
    else if (m.type === 'ready') ready();
    else if (m.type === 'exit') seen.exit = m.code;
    else if (m.type === 'error') { seen.error = m.msg; ready(); }
  });
  const sab = createRing(4096);
  const stdin = new RingWriter(sab);
  const channel = createRing(4096);
  worker.postMessage({ type: 'channel', sab: channel });
  worker.postMessage({
    wasmBytes: wasm, files: { '/t.sh': script },
    args: ['busybox', 'sh', '/t.sh'], env: { PATH: '/', LC_ALL: 'C' },
    sab,
    // The park under test is the synchronous one — the guest owning the thread
    // — so this is off no matter what the engine can do.
    suspendInput: false,
  });
  await readied;
  return { worker, seen, stdin, requests: new RingWriter(channel, { channel: 'test' }) };
}

describe('serve({ whileBlocked })', () => {
  test('answers a channel of its own while the guest waits for a key', async () => {
    const s = await start();
    await settle();
    assert.equal(s.seen.answered.length, 0, 'nothing was asked yet');

    // The producer's two halves: fill the channel, then end the park. The wake
    // is not a keystroke — the shell still has nothing to read — so the only
    // thing that can answer this is the hook.
    s.requests.write(enc.encode('GET /index.php\n'));
    s.stdin.wake();
    await settle();

    assert.deepEqual(s.seen.answered, ['GET /index.php'],
      'the request was answered from inside the park');
    assert.equal(s.seen.out, '', 'and the guest ran nothing: it is still waiting for its line');

    // And the shell was left exactly where it was found.
    s.stdin.write(enc.encode('hello\n'));
    await settle();
    assert.match(s.seen.out, /typed: hello/, 'the keystrokes that followed reached the guest');
  });

  test('without the hook the same request sits there unanswered', async () => {
    // The measurement the claim above rests on: same script, same channel, same
    // wake — a worker with no hook simply parks again.
    const s = await start({ module: PLAIN });
    await settle();
    s.requests.write(enc.encode('GET /index.php\n'));
    s.stdin.wake();
    await settle();
    assert.deepEqual(s.seen.answered, [], 'nothing answered it, and nothing could');
    s.stdin.write(enc.encode('hello\n'));
    await settle();
    assert.match(s.seen.out, /typed: hello/, 'the shell itself is unaffected either way');
  });

  test('a burst is drained in one park, in order', async () => {
    const s = await start();
    await settle();
    for (const n of [1, 2, 3, 4, 5]) s.requests.write(enc.encode(`GET /${n}.php\n`));
    s.stdin.wake();
    await settle();
    assert.deepEqual(s.seen.answered,
      ['GET /1.php', 'GET /2.php', 'GET /3.php', 'GET /4.php', 'GET /5.php'],
      'run() drained the ring rather than answering one and parking again');
  });

  test('the guest sees the work that happened while it was parked', async () => {
    // The hook runs on the guest's own thread, so what it did is simply true by
    // the time the guest moves again — no synchronisation of any kind.
    const s = await start({ script: 'read -r line; answered\n' });
    await settle();
    s.requests.write(enc.encode('GET /a.php\n'));
    s.requests.write(enc.encode('GET /b.php\n'));
    s.stdin.wake();
    await settle();
    s.stdin.write(enc.encode('go\n'));
    await settle();
    assert.match(s.seen.out, /answered=2/, 'both were answered before the guest read its line');
  });

  test('a request does not shorten a timed read', async () => {
    // `read -t 1` parks on the timeout, and a page's fetch must not become the
    // guest's clock running fast — it is answered inside the wait and the wait
    // still runs its length. (This build has no `sleep` applet; the timed read
    // is the same park.)
    const s = await start({ script: 'echo waiting; read -t 1 _; echo done\n' });
    const t0 = Date.now();
    await settle(200);
    s.requests.write(enc.encode('GET /during-read.php\n'));
    s.stdin.wake();
    await settle(200);
    assert.deepEqual(s.seen.answered, ['GET /during-read.php'], 'answered inside the timed read');
    assert.doesNotMatch(s.seen.out, /done/, 'and the read is still reading');
    await settle(900);
    assert.match(s.seen.out, /done/, 'it ended on its own timeout');
    assert.ok(Date.now() - t0 >= 1000, 'which was not cut short by the request');
  });

  test('half a hook is refused, rather than quietly doing nothing', async () => {
    const worker = new Worker(TWIN, { workerData: { module: new URL('./while-blocked-half.worker.mjs', import.meta.url).href } });
    live.add(worker);
    const failed = new Promise((res) => {
      worker.on('message', (m) => { if (m.type === 'error') res(m.msg); });
    });
    worker.postMessage({
      wasmBytes: wasm, files: { '/t.sh': 'echo hi\n' },
      args: ['busybox', 'sh', '/t.sh'], env: { PATH: '/', LC_ALL: 'C' },
      sab: createRing(1024),
    });
    assert.match(await failed, /whileBlocked.*pending\(\).*run\(\)/s);
  });
});
