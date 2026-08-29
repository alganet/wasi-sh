// The host port: /dev/host, the fourth pluggable seam. These run against a
// bare WebAssembly.Memory with no wasm module, calling the WASI imports the
// way the guest would — so they pin the JS side even when dist/busybox.wasm
// predates the feature. The end-to-end shell dispatch lives in scripts.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasiShim } from '../src/shim.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const EPERM = 63, EIO = 29, EINVAL = 28;

function makeShim(host) {
  const out = { stderr: [] };
  const shim = new WasiShim({ host, stderr: (b) => out.stderr.push(dec.decode(b)) });
  const memory = new WebAssembly.Memory({ initial: 4 });
  shim.bindMemory(memory);
  const imports = shim.imports();
  const t = {
    shim, out, p1: imports.wasi_snapshot_preview1,
    view: () => new DataView(memory.buffer), bytes: () => new Uint8Array(memory.buffer),
  };
  return t;
}

// path_open('/dev/host') against preopen fd 3, returning the fd.
function openHost(t, expectErrno = 0) {
  const b = enc.encode('/dev/host');
  t.bytes().set(b, 0x100);
  const errno = t.p1.path_open(3, 0, 0x100, b.length, 0, 0n, 0n, 0, 0x200);
  assert.equal(errno, expectErrno, 'path_open(/dev/host) errno');
  return expectErrno === 0 ? t.view().getUint32(0x200, true) : -1;
}

function writeFd(t, fd, data) {
  const b = typeof data === 'string' ? enc.encode(data) : data;
  t.bytes().set(b, 0x1000);
  t.view().setUint32(0x600, 0x1000, true);
  t.view().setUint32(0x604, b.length, true);
  return { errno: t.p1.fd_write(fd, 0x600, 1, 0x608), n: t.view().getUint32(0x608, true) };
}

function readFd(t, fd, max = 256) {
  t.view().setUint32(0x300, 0x400, true);
  t.view().setUint32(0x304, max, true);
  const errno = t.p1.fd_read(fd, 0x300, 1, 0x308);
  const n = t.view().getUint32(0x308, true);
  return { errno, n, text: dec.decode(t.bytes().slice(0x400, 0x400 + n)) };
}

// One request in, the whole response back out — what a script does across two
// commands, and therefore two opens.
function verb(t, line) {
  assert.equal(writeFd(t, openHost(t), line).errno, 0, `write(${JSON.stringify(line)})`);
  return readFd(t, openHost(t)).text;
}

// ─── the capability ──────────────────────────────────────────────────────────

// No port means every capability is absent, and the refusal lands at open so a
// script sees "Permission denied" instead of an empty answer.
test('with no port the device exists and every open is EPERM', () => {
  const t = makeShim(undefined);
  openHost(t, EPERM);
  const b = enc.encode('/dev');
  t.bytes().set(b, 0x100);
  assert.equal(t.p1.path_filestat_get(3, 0, 0x100, b.length, 0xa00), 0, '/dev is still there');
});

test('a port makes the device openable, readable and writable', () => {
  const t = makeShim({ request: () => 'pong' });
  assert.equal(verb(t, 'ping\n'), 'pong');
});

// ─── framing ─────────────────────────────────────────────────────────────────

test('a request is a verb, optionally a space and a payload', () => {
  const seen = [];
  const t = makeShim({ request: (v, p) => { seen.push([v, dec.decode(p)]); return ''; } });
  verb(t, 'clipboard.read\n');
  verb(t, 'clipboard.write hello world\n');
  assert.deepEqual(seen, [['clipboard.read', ''], ['clipboard.write', 'hello world']]);
});

test('several requests in one write dispatch in order, answers concatenated', () => {
  const t = makeShim({ request: (v) => `[${v}]` });
  assert.equal(verb(t, 'a\nb\nc\n'), '[a][b][c]');
});

// A write boundary is not a frame: stdio splits a large payload at its buffer
// size, so the newline has to be what completes a request.
test('a request split across writes completes at the newline, not the write', () => {
  const t = makeShim({ request: (v, p) => `${v}:${dec.decode(p)}` });
  const fd = openHost(t);
  assert.equal(writeFd(t, fd, 'echo hel').errno, 0);
  assert.equal(readFd(t, openHost(t)).n, 0, 'nothing dispatched yet');
  assert.equal(writeFd(t, fd, 'lo\n').errno, 0);
  assert.equal(readFd(t, openHost(t)).text, 'echo:hello');
});

test('a blank line is not a request', () => {
  let calls = 0;
  const t = makeShim({ request: () => { calls++; return 'x'; } });
  assert.equal(writeFd(t, openHost(t), '\n\n\n').errno, 0);
  assert.equal(calls, 0);
});

test('a line with no verb is a malformed request, not a silent no-op', () => {
  const t = makeShim({ request: () => 'x' });
  assert.equal(writeFd(t, openHost(t), ' payload only\n').errno, EINVAL);
});

// `yes > /dev/host` never completes a request; the buffer behind it must not
// grow until the tab dies.
test('an unterminated request line is capped', () => {
  const t = makeShim({ request: () => '' });
  const fd = openHost(t);
  const chunk = new Uint8Array(60000).fill(0x41);
  let errno = 0;
  for (let i = 0; i < 40 && !errno; i++) errno = writeFd(t, fd, chunk).errno;
  assert.equal(errno, EINVAL, 'refused before it can grow without bound');
  assert.equal(writeFd(t, fd, 'ping\n').errno, 0, 'and the device still works afterwards');
});

// ─── responses ───────────────────────────────────────────────────────────────

test('a drained response reads EOF, so `cat` stops instead of hanging', () => {
  const t = makeShim({ request: () => 'answer' });
  const fd = openHost(t);
  assert.equal(writeFd(t, fd, 'ask\n').errno, 0);
  const rfd = openHost(t);
  assert.equal(readFd(t, rfd).text, 'answer');
  const eof = readFd(t, rfd);
  assert.equal(eof.errno, 0);
  assert.equal(eof.n, 0, 'EOF');
});

test('a long response survives being read in pieces', () => {
  const body = 'x'.repeat(700);
  const t = makeShim({ request: () => body });
  const fd = openHost(t);
  writeFd(t, fd, 'big\n');
  const rfd = openHost(t);
  let got = '';
  for (;;) { const r = readFd(t, rfd, 256); if (!r.n) break; got += r.text; }
  assert.equal(got, body);
});

test('bytes, strings and nothing are all valid answers', () => {
  const answers = [enc.encode('bin'), 'str', null, undefined, new Uint8Array([0x00, 0xff]).buffer];
  const t = makeShim({ request: () => answers.shift() });
  assert.equal(verb(t, 'a\n'), 'bin');
  assert.equal(verb(t, 'b\n'), 'str');
  assert.equal(verb(t, 'c\n'), '', 'null is an empty response, not a failure');
  assert.equal(verb(t, 'd\n'), '');
  assert.equal(verb(t, 'e\n').length, 2, 'an ArrayBuffer is bytes too');
});

test('the port cannot be handed a view into guest memory to retain', () => {
  const held = [];
  const t = makeShim({ request: (v, p) => { held.push(p); return ''; } });
  writeFd(t, openHost(t), 'keep this payload\n');
  t.bytes().fill(0x5a, 0x1000, 0x1100);   // the guest reuses its buffer
  assert.equal(dec.decode(held[0]), 'this payload', 'the payload was copied out');
});

test('a response is copied, so a port may answer from a scratch buffer', () => {
  const scratch = enc.encode('first!');
  const t = makeShim({ request: () => scratch });
  const fd = openHost(t);
  writeFd(t, fd, 'a\n');
  scratch.set(enc.encode('second'));
  assert.equal(readFd(t, openHost(t)).text, 'first!');
});

// ─── containment ─────────────────────────────────────────────────────────────

// A JS exception thrown out of a wasm import unwinds the ENTIRE guest stack:
// the instance is dead and no guest setjmp can catch it. A broken verb must
// cost one write.
test('a throwing verb is contained: EIO, a diagnostic, a live shell', () => {
  const t = makeShim({ request: (v) => { if (v === 'bad') throw new Error('boom'); return 'ok'; } });
  assert.equal(writeFd(t, openHost(t), 'bad\n').errno, EIO);
  assert.match(t.out.stderr.join(''), /\/dev\/host: bad: boom/);
  assert.equal(verb(t, 'good\n'), 'ok', 'the port still works');
});

// The guest is a synchronous wasm frame below the call; a thenable would be
// dropped and the real work would land against whatever fd 1 has become.
test('an async verb fails loudly instead of silently succeeding', () => {
  const t = makeShim({ request: async () => 'later' });
  assert.equal(writeFd(t, openHost(t), 'slow\n').errno, EIO);
  assert.match(t.out.stderr.join(''), /must be synchronous/);
});

test('a rejected promise from an async verb is not an unhandled rejection', async () => {
  const t = makeShim({ request: () => Promise.reject(new Error('later')) });
  writeFd(t, openHost(t), 'slow\n');
  await new Promise((r) => setTimeout(r, 10));   // would crash the test process if unowned
});

test('an answer that is not bytes is reported, not coerced', () => {
  const t = makeShim({ request: () => 42 });
  assert.equal(writeFd(t, openHost(t), 'n\n').errno, EIO);
  assert.match(t.out.stderr.join(''), /not bytes/);
});

// WASI has one result per write, so a failing request fails the whole write(2).
// Dispatching the rest anyway would run verbs the guest was just told never
// happened.
test('a failing request ends the write; later lines in it never run', () => {
  const ran = [];
  const t = makeShim({ request: (v) => { ran.push(v); if (v === 'bad') throw new Error('x'); return ''; } });
  assert.equal(writeFd(t, openHost(t), 'first\nbad\nthird\n').errno, EIO);
  assert.deepEqual(ran, ['first', 'bad'], 'third never dispatched');
  assert.equal(verb(t, 'after\n'), '', 'and it does not linger as a pending line');
  assert.deepEqual(ran, ['first', 'bad', 'after']);
});

// fd 2 can be redirected onto this very device; a diagnostic written through
// writeFd(2) would re-enter the port mid-dispatch. The sink cannot be
// redirected, which is why it is the one used.
test('a diagnostic cannot re-enter the port through a redirected fd 2', () => {
  const seen = [];
  const t = makeShim({ request: (v) => { seen.push(v); throw new Error('boom'); } });
  const hostFd = openHost(t);
  assert.equal(t.shim.imports().env.__host_dup2(hostFd, 2), 2, 'fd 2 is now /dev/host');
  assert.equal(writeFd(t, hostFd, 'bad\n').errno, EIO);
  assert.deepEqual(seen, ['bad'], 'the error message did not become a second request');
});

// ─── the overlay still owns the name ─────────────────────────────────────────

test('the guest cannot remove, rename or shadow the port', () => {
  const t = makeShim({ request: () => '' });
  const b = enc.encode('/dev/host');
  t.bytes().set(b, 0x100);
  assert.equal(t.p1.path_unlink_file(3, 0x100, b.length), EPERM);
  const to = enc.encode('/tmp/host');
  t.bytes().set(to, 0x180);
  assert.equal(t.p1.path_rename(3, 0x100, b.length, 3, 0x180, to.length), EPERM);
  assert.ok(openHost(t) > 0, 'still there');
});
