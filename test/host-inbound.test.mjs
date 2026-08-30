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
