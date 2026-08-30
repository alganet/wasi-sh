// The inbound half of the host port: /dev/hostreq, requests the host hands to a
// RUNNING guest. These drive the WASI imports by hand against a bare memory —
// no wasm module — so they pin the JS side even when dist/busybox.wasm predates
// the feature. The shell-level idiom and the parked-guest wake live in
// scripts.test.mjs and interactive.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasiShim } from '../src/shim.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const EPERM = 63, EAGAIN = 6;

// An `input`-shaped channel over a list of already-framed lines, with a switch
// for whether it may still grow — which is the whole of what EOF means here.
function staged(lines = [], { open = false } = {}) {
  let buf = enc.encode(lines.map((l) => `${l}\n`).join(''));
  let off = 0, ended = !open;
  const parked = [];
  return {
    push(line) { const add = enc.encode(`${line}\n`); const grown = new Uint8Array(buf.length + add.length);
      grown.set(buf); grown.set(add, buf.length); buf = grown; },
    end() { ended = true; },
    parked,
    pollReadable: (ms) => { parked.push(ms); return off < buf.length; },
    read(max) { const take = buf.subarray(off, Math.min(off + max, buf.length)); off += take.length; return take; },
    readBlocking(max) { return this.read(max); },
    closed: () => ended && off >= buf.length,
  };
}

function makeShim(requests) {
  const shim = new WasiShim({ requests });
  const memory = new WebAssembly.Memory({ initial: 2 });
  shim.bindMemory(memory);
  const imports = shim.imports();
  return {
    shim, p1: imports.wasi_snapshot_preview1,
    view: () => new DataView(memory.buffer), bytes: () => new Uint8Array(memory.buffer),
  };
}

function openReq(t, expectErrno = 0) {
  const b = enc.encode('/dev/hostreq');
  t.bytes().set(b, 0x100);
  const errno = t.p1.path_open(3, 0, 0x100, b.length, 0, 0n, 0n, 0, 0x200);
  assert.equal(errno, expectErrno, 'path_open(/dev/hostreq) errno');
  return expectErrno === 0 ? t.view().getUint32(0x200, true) : -1;
}

function readFd(t, fd, max = 256) {
  t.view().setUint32(0x300, 0x400, true);
  t.view().setUint32(0x304, max, true);
  const errno = t.p1.fd_read(fd, 0x300, 1, 0x308);
  const n = t.view().getUint32(0x308, true);
  return { errno, n, text: dec.decode(t.bytes().slice(0x400, 0x400 + n)) };
}

// ─── the grant ───────────────────────────────────────────────────────────────
// Two answers, and a script can only act on the difference if both are said
// where it can see them: EPERM means this session can NEVER be asked, EOF means
// it will not be asked again.

test('with no channel the name is there and the open is refused', () => {
  const t = makeShim(undefined);
  openReq(t, EPERM);
});

test('the grant is separate from the outbound port', () => {
  // A session may be able to ask the host without being able to be asked.
  const shim = new WasiShim({ host: { request: () => '' } });
  const memory = new WebAssembly.Memory({ initial: 2 });
  shim.bindMemory(memory);
  const t = { shim, p1: shim.imports().wasi_snapshot_preview1,
    view: () => new DataView(memory.buffer), bytes: () => new Uint8Array(memory.buffer) };
  openReq(t, EPERM);
  const b = enc.encode('/dev/host');
  t.bytes().set(b, 0x100);
  assert.equal(t.p1.path_open(3, 0, 0x100, b.length, 0, 0n, 0n, 0, 0x200), 0, '/dev/host is open for business');
});

// ─── delivery ────────────────────────────────────────────────────────────────

test('a queued request reads back as a line, then EOF', () => {
  const t = makeShim(staged(['GET /index.php', 'GET /about.php']));
  const fd = openReq(t);
  assert.equal(readFd(t, fd).text, 'GET /index.php\nGET /about.php\n');
  const end = readFd(t, fd);
  assert.equal(end.errno, 0);
  assert.equal(end.n, 0, 'EOF — which is what ends the loop');
});

// An empty read already means EOF, so "nothing YET" needs its own answer or the
// loop ends at the first gap between requests.
test('a non-blocking read with nothing queued is EAGAIN, not EOF', () => {
  const t = makeShim(staged([], { open: true }));
  const fd = openReq(t);
  t.p1.fd_fdstat_set_flags(fd, 4 /* O_NONBLOCK */);
  const r = readFd(t, fd);
  assert.equal(r.errno, EAGAIN);
  assert.equal(r.n, 0);
});

test('a blocking read takes what arrives while it waits', () => {
  const q = staged([], { open: true });
  const t = makeShim(q);
  const fd = openReq(t);
  q.push('GET /late.php');       // the host posts while the guest is in the read
  assert.equal(readFd(t, fd).text, 'GET /late.php\n');
});

// One direction per device: the answer to a request is an outbound verb on
// /dev/host, not a write back here.
test('the inbound device refuses a write', () => {
  const t = makeShim(staged(['x']));
  const fd = openReq(t);
  const b = enc.encode('reply\n');
  t.bytes().set(b, 0x1000);
  t.view().setUint32(0x600, 0x1000, true);
  t.view().setUint32(0x604, b.length, true);
  assert.equal(t.p1.fd_write(fd, 0x600, 1, 0x608), EPERM);
});

// ─── the poll chokepoint ─────────────────────────────────────────────────────
// The device MUST be asked rather than assumed readable: assumed, the wait
// lands in the read behind it, and a request posted to a guest parked there
// arrives only when something else wakes it.

test('poll_oneoff asks the channel, and hands it the timeout to wait out', () => {
  const q = staged([], { open: true });
  const t = makeShim(q);
  const fd = openReq(t);
  const SUB = 48;
  t.bytes().fill(0, 0xb00, 0xb00 + 2 * SUB);
  t.view().setBigUint64(0xb00, 1n, true);
  t.view().setUint8(0xb00 + 8, 1); t.view().setUint32(0xb00 + 16, fd, true);
  t.view().setBigUint64(0xb00 + SUB, 2n, true);
  t.view().setUint8(0xb00 + SUB + 8, 0); t.view().setBigUint64(0xb00 + SUB + 24, 25n * 1000000n, true);
  t.p1.poll_oneoff(0xb00, 0xd00, 2, 0xf00);
  assert.deepEqual(q.parked, [25], 'the wait happened in the poll, where a post can end it');
  assert.equal(t.view().getUint32(0xf00, true), 1);
  assert.equal(t.view().getUint8(0xd00 + 10), 0, 'the clock fired; the fd was never called readable');
});

test('an untimed poll parks indefinitely — the dev server between requests', () => {
  const q = staged([], { open: true });
  const t = makeShim(q);
  const fd = openReq(t);
  t.bytes().fill(0, 0xb00, 0xb00 + 48);
  t.view().setBigUint64(0xb00, 1n, true);
  t.view().setUint8(0xb00 + 8, 1); t.view().setUint32(0xb00 + 16, fd, true);
  t.p1.poll_oneoff(0xb00, 0xd00, 1, 0xf00);
  assert.deepEqual(q.parked, [null], 'null is park forever, which is what the ring does');
});

test('a closed channel polls readable, so the read gets to report EOF', () => {
  const t = makeShim(staged([]));
  const fd = openReq(t);
  t.bytes().fill(0, 0xb00, 0xb00 + 48);
  t.view().setBigUint64(0xb00, 5n, true);
  t.view().setUint8(0xb00 + 8, 1); t.view().setUint32(0xb00 + 16, fd, true);
  t.p1.poll_oneoff(0xb00, 0xd00, 1, 0xf00);
  assert.equal(t.view().getUint32(0xf00, true), 1);
  assert.equal(t.view().getUint8(0xd00 + 10), 1, 'readable');
  assert.equal(readFd(t, fd).n, 0, 'and it is EOF');
});

// ─── the overlay still owns the name ─────────────────────────────────────────

test('the guest cannot remove, rename or shadow the inbound device', () => {
  const t = makeShim(staged(['x'], { open: true }));
  const b = enc.encode('/dev/hostreq');
  t.bytes().set(b, 0x100);
  assert.equal(t.p1.path_unlink_file(3, 0x100, b.length), EPERM);
  const to = enc.encode('/tmp/req');
  t.bytes().set(to, 0x180);
  assert.equal(t.p1.path_rename(3, 0x100, b.length, 3, 0x180, to.length), EPERM);
  assert.ok(openReq(t) > 0, 'still there');
});

// ─── through a real shell ────────────────────────────────────────────────────
// The suite above drives the imports by hand; these run busybox ash against the
// shipped wasm, which is what pins the thing the port exists for — the dev
// server as an ordinary shell loop. run() stages the whole queue up front,
// because nothing can arrive DURING a run(); interactive.test.mjs is where a
// request reaches a guest that is already parked.
import { before } from 'node:test';
import { compileWasm, runScript } from '../src/node.mjs';

let wasm;
before(async () => { wasm = await compileWasm(); });
const sh = (script, opts = {}) => runScript(script, { wasm, env: { LC_ALL: 'C' }, ...opts });

const LOOP = 'while read -r req <&3; do\n  echo "handling [$req]"\ndone 3< /dev/hostreq\necho loop-ended\n';

test('the dev server is a shell loop', async () => {
  const r = await sh(LOOP, { requests: ['GET /index.php', 'GET /about.php'] });
  assert.equal(r.stdout, 'handling [GET /index.php]\nhandling [GET /about.php]\nloop-ended\n');
  assert.equal(r.exitCode, 0);
});

// The end-of-stream half of the contract: `read` fails at EOF, which is the
// only reason the loop above ever ends.
test('an empty but granted channel runs the loop zero times', async () => {
  const r = await sh(LOOP, { requests: [] });
  assert.equal(r.stdout, 'loop-ended\n');
});

// And the "never" half. A session that cannot be asked must say so where the
// script can see it, rather than hand back an EOF that reads as "no requests
// today" — the loop would then exit 0 having served nothing, and look right.
test('with no channel the loop refuses to start, and can say so', async () => {
  // Redirected on the loop rather than with `exec`: a failed `exec`
  // redirection ends a non-interactive shell outright, which is a fine way to
  // fail but leaves nothing to say about it.
  const r = await sh(`{ ${LOOP} } 3< /dev/hostreq 2>/dev/null || { echo 'not granted'; exit 7; }\n`);
  assert.equal(r.stdout, 'not granted\n');
  assert.equal(r.exitCode, 7);
});

test('a request keeps every byte of its line, spaces and all', async () => {
  const r = await sh('{ read -r req <&3; printf "%s" "$req" | wc -c; } 3< /dev/hostreq\n',
    { requests: ['GET /a%20b.php?x=1&y=2 HTTP/1.1'] });
  assert.equal(r.stdout.trim(), '31');
});

// Reading one request must not swallow the next: busybox's `read` takes a byte
// at a time for exactly this reason, and a device handing back a block would
// leave the remainder in a stdio buffer the next reader inherits.
test('a request read one at a time leaves the rest of the queue alone', async () => {
  const r = await sh('{ read -r a <&3; echo "first=$a"; read -r b <&3; echo "second=$b"; } 3< /dev/hostreq\n',
    { requests: ['one', 'two', 'three'] });
  assert.equal(r.stdout, 'first=one\nsecond=two\n');
});

// The reply is an outbound verb. Both halves of the port in one loop is the
// whole shape phasm's dev server needs, minus the PHP.
test('a request is answered through the outbound half', async () => {
  const served = [];
  const r = await sh(
    'while read -r req <&3; do\n'
    + '  echo "respond 200 ${req}" > /dev/host\n'
    + 'done 3< /dev/hostreq\n'
    + 'echo served\n',
    { requests: ['/index.php', '/about.php'], host: { respond: (p) => { served.push(dec.decode(p)); } } },
  );
  assert.deepEqual(served, ['200 /index.php', '200 /about.php']);
  assert.equal(r.stdout, 'served\n');
});

// One direction per device, said where a script can see it.
test('a script cannot write a reply back into the inbound device', async () => {
  const r = await sh("echo reply > /dev/hostreq 2>/dev/null || echo 'refused'", { requests: ['x'] });
  assert.equal(r.stdout, 'refused\n');
});

// Refused at the producer, because a guest parked on a request has nowhere to
// put the error.
test('a request with a newline in it is refused before it is delivered', async () => {
  await assert.rejects(() => sh(LOOP, { requests: ['GET /a.php\nforged'] }), /newline/);
  await assert.rejects(() => sh(LOOP, { requests: [''] }), /empty/);
});

// ─── reaching a guest that is already parked ─────────────────────────────────
// The whole reason the channel is shared memory. A live session is one
// synchronous _start() frame, so a postMessage into a running shell worker is
// not slow — it is not delivered: measured at +303ms posted, +3020ms handled,
// and only because an unrelated wait expired. Here the guest is parked in the
// read of /dev/hostreq with nothing queued, which is a dev server between
// requests, and the post has to wake it.
import { Worker } from 'node:worker_threads';
import { createRing, RingWriter, frameRequest } from '../src/ring.mjs';

// The node twin of src/worker.mjs, with both rings — the same shim wiring,
// parentPort standing in for postMessage.
const TWIN = `
  import { parentPort, workerData } from 'node:worker_threads';
  const { WasiShim, WasiExit } = await import(workerData.shimUrl);
  const { RingReader } = await import(workerData.ringUrl);
  const { module, files, args, env, sab, reqSab } = workerData;
  const dec = new TextDecoder();
  const emit = (b) => parentPort.postMessage({ type: 'out', text: dec.decode(b) });
  const shim = new WasiShim({
    args, env, files, stdout: emit, stderr: emit,
    input: new RingReader(sab).toInput(),
    requests: new RingReader(reqSab).toInput(),
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  let code = 0;
  try { instance.exports._start(); }
  catch (e) { if (e instanceof WasiExit) code = e.code; else throw e; }
  parentPort.postMessage({ type: 'exit', code });
`;

function spawnTwin(script) {
  const sab = createRing(), reqSab = createRing();
  const worker = new Worker(TWIN, {
    eval: true,
    workerData: {
      module: wasm, files: { '/t.sh': script }, args: ['busybox', 'sh', '/t.sh'],
      env: { PATH: '/', LC_ALL: 'C' }, sab, reqSab,
      shimUrl: new URL('../src/shim.mjs', import.meta.url).href,
      ringUrl: new URL('../src/ring.mjs', import.meta.url).href,
    },
  });
  let seen = '';
  const exited = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.type === 'exit') { resolve(m); worker.terminate(); }
      else seen += m.text;
    });
    worker.on('error', reject);
  });
  return { requests: new RingWriter(reqSab), exited, live: () => seen };
}

// Poll for a condition the PARKED guest is supposed to produce; the assertion
// is what it printed while still running, which an exit-time snapshot cannot say.
async function until(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('a request wakes a guest parked between requests', async () => {
  const t = spawnTwin('echo ready\nwhile read -r req <&3; do\n  echo "handled $req"\ndone 3< /dev/hostreq\necho loop-ended\n');
  assert.ok(await until(() => t.live().includes('ready\n')), 'the loop reached its first read');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.live(), 'ready\n', 'and parked there — nothing to handle yet');

  const t0 = Date.now();
  t.requests.write(frameRequest('GET /index.php'));
  assert.ok(await until(() => t.live().includes('handled GET /index.php')), 'the parked guest was woken');
  assert.ok(Date.now() - t0 < 1000, `delivered in ${Date.now() - t0}ms, not at some unrelated wakeup`);

  t.requests.write(frameRequest('GET /about.php'));
  assert.ok(await until(() => t.live().includes('handled GET /about.php')), 'and again, in the same session');

  t.requests.end();
  const exit = await t.exited;
  assert.match(t.live(), /loop-ended/, 'end-of-stream is what ends the loop');
  assert.equal(exit.code, 0);
});

// The claim §5 rests on: one worker, one filesystem, no divergence — the guest
// serving requests is the guest that owns the files.
test('a request is served off the filesystem the shell owns', async () => {
  const t = spawnTwin(
    'mkdir -p /srv\necho "first version" > /srv/index.html\necho ready\n'
    + 'while read -r req <&3; do cat "/srv/$req"; done 3< /dev/hostreq\n',
  );
  await until(() => t.live().includes('ready\n'));
  t.requests.write(frameRequest('index.html'));
  assert.ok(await until(() => t.live().includes('first version')), 'served');
  t.requests.end();
  await t.exited;
});

// ─── the grant, and what a failure says ──────────────────────────────────────

test('spawn refuses a request option it would have to drop, and a size that is not one', async () => {
  const { spawn } = await import('../src/spawn.mjs');
  await assert.rejects(() => spawn({ command: 'true', requests: ['GET /'] }), /session\.post/,
    'a live session cannot take a queue that is complete before it starts');
  await assert.rejects(() => spawn({ command: 'true', requestBufferSize: true }), /positive number of bytes/,
    'a truthy non-size would build a 29-byte ring, or read as no grant at all');
});

// A wrong answer costs more than none: "increase stdinBufferSize" is the wrong
// fix for a host request that did not fit.
test('an overflowing request ring names its own channel and option', () => {
  const w = new RingWriter(createRing(32), { channel: 'host request', sizeOption: 'requestBufferSize' });
  assert.throws(() => w.write(frameRequest('a request far longer than thirty-two bytes')),
    /host request ring overflow[\s\S]*requestBufferSize/);
});

test('post() without the grant says which option is missing', async () => {
  const { Session } = await import('../src/spawn.mjs');
  const s = new Session({ addEventListener() {} }, { write() {} }, false, null);
  assert.throws(() => s.post('GET /'), /requestBufferSize/);
});
