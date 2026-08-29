// The host port: /dev/host, the fourth pluggable seam. These run against a
// bare WebAssembly.Memory with no wasm module, calling the WASI imports the
// way the guest would — so they pin the JS side even when dist/busybox.wasm
// predates the feature. The end-to-end shell dispatch lives in scripts.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { WasiShim } from '../src/shim.mjs';
import { compileWasm, runScript } from '../src/node.mjs';
import { hostPort, resolveHost } from '../src/options.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const EPERM = 63, EIO = 29, EINVAL = 28;

let wasm;
before(async () => { wasm = await compileWasm(); });
const sh = (script, opts = {}) => runScript(script, { wasm, env: { LC_ALL: 'C' }, ...opts });

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

// ─── the normalizer ──────────────────────────────────────────────────────────

test('hostPort: a verb map becomes a port', () => {
  const p = hostPort({ 'clipboard.read': (payload, verb) => `${verb}:${payload.length}` });
  assert.equal(p.request('clipboard.read', new Uint8Array(3)), 'clipboard.read:3');
  assert.throws(() => p.request('clipboard.write', new Uint8Array(0)), /no such verb/);
});

test('hostPort: an object that already has request() passes through untouched', () => {
  const port = { request: () => 'x' };
  assert.equal(hostPort(port), port, 'a dynamic namespace must not be wrapped');
});

// Without hasOwn every Object.prototype member is a reachable verb, and
// `toString` would dispatch into Object.prototype.
test('hostPort: inherited properties are not verbs', () => {
  const p = hostPort({ real: () => '' });
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    assert.throws(() => p.request(name, new Uint8Array(0)), /no such verb/, name);
  }
});

test('resolveHost: a factory is awaited once, so setup happens before the shell', async () => {
  let boots = 0;
  const p = await resolveHost(async () => { boots++; return { hi: () => 'there' }; });
  assert.equal(boots, 1);
  assert.equal(p.request('hi', new Uint8Array(0)), 'there');
});

test('resolveHost: undefined stays undefined (capability absent by default)', async () => {
  assert.equal(await resolveHost(undefined), undefined);
});

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

// An answer nobody read must not arrive prepended to somebody else's. For a
// capability port that is a leak sideways, not merely a surprise: the answer to
// `secret.read` would surface in an unrelated `cat /dev/host`.
test('a new request discards an answer nobody read', () => {
  const t = makeShim({ request: (v) => (v === 'secret' ? 'SECRET' : 'ok') });
  writeFd(t, openHost(t), 'secret\n');           // the answer is never read
  assert.equal(verb(t, 'ping\n'), 'ok', 'only the most recent request is answered');
});

test('a failed write leaves nothing to read, whatever ran inside it', () => {
  const t = makeShim({ request: (v) => { if (v === 'bad') throw new Error('x'); return 'LEAKED'; } });
  assert.equal(writeFd(t, openHost(t), 'good\nbad\n').errno, EIO);
  assert.equal(readFd(t, openHost(t)).n, 0, 'the write said none of it happened');
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

// The short-write protocol asks the caller to send the rest again, and a device
// has already ACTED on what it took. A scatter whose later buffer failed would
// come back and run a verb the port had already run.
test('a scattered write is one device write, so nothing is dispatched twice', () => {
  const ran = [];
  const t = makeShim({ request: (v) => { ran.push(v); if (v === 'bad') throw new Error('x'); return ''; } });
  const fd = openHost(t);
  const first = enc.encode('a\n'), second = enc.encode('c\nbad\n');
  t.bytes().set(first, 0x1000);
  t.bytes().set(second, 0x1100);
  t.view().setUint32(0x600, 0x1000, true); t.view().setUint32(0x604, first.length, true);
  t.view().setUint32(0x608, 0x1100, true); t.view().setUint32(0x60c, second.length, true);
  const errno = t.p1.fd_write(fd, 0x600, 2, 0x700);
  assert.equal(errno, EIO, 'the whole call failed, so there is nothing to retry');
  assert.equal(t.view().getUint32(0x700, true), 0, 'and no partial count inviting one');
  assert.deepEqual(ran, ['a', 'c', 'bad']);
});

test('a scattered write that succeeds reports every byte', () => {
  const t = makeShim({ request: () => '' });
  const fd = openHost(t);
  const first = enc.encode('a b'), second = enc.encode('c\n');
  t.bytes().set(first, 0x1000);
  t.bytes().set(second, 0x1100);
  t.view().setUint32(0x600, 0x1000, true); t.view().setUint32(0x604, first.length, true);
  t.view().setUint32(0x608, 0x1100, true); t.view().setUint32(0x60c, second.length, true);
  assert.equal(t.p1.fd_write(fd, 0x600, 2, 0x700), 0);
  assert.equal(t.view().getUint32(0x700, true), 5, 'a verb split across iovecs is still one request');
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

// ─── through a real shell ────────────────────────────────────────────────────
// The suite above drives the imports by hand; these run busybox ash against the
// shipped wasm, which is what pins the composition — redirections, $(…), $? and
// stdio buffering are all somebody else's code.

test('a script reaches the port and reads the answer back', async () => {
  const clipboard = { text: 'copied earlier' };
  const r = await sh(
    "printf 'clipboard.read\\n' > /dev/host\n"
    + 'paste=$(cat /dev/host)\n'
    + 'echo "got [$paste]"\n',
    { host: { 'clipboard.read': () => clipboard.text } },
  );
  assert.equal(r.stdout, 'got [copied earlier]\n');
  assert.equal(r.exitCode, 0);
});

test('a payload crosses on the request line', async () => {
  let wrote = null;
  const r = await sh(
    "echo 'clipboard.write the whole line' > /dev/host\n"
    + 'echo done\n',
    { host: { 'clipboard.write': (payload) => { wrote = dec.decode(payload); } } },
  );
  assert.equal(wrote, 'the whole line');
  assert.equal(r.stdout, 'done\n');
});

// A map is the 95% case, and an unregistered verb has to be a failure a script
// can see rather than an empty answer that looks like a verb with nothing to say.
test('an unregistered verb fails the script, not silently', async () => {
  const r = await sh(
    'echo nope > /dev/host || echo refused\n',
    { host: { yes: () => 'ok' } },
  );
  assert.match(r.stdout, /refused/);
  assert.match(r.stderr, /\/dev\/host: nope: no such verb/);
  assert.match(r.stderr, /write error/, 'and the shell reports the failed write');
});

// A buffered writer reaches the device through a two-iovec writev — the FILE's
// buffer and the caller's bytes — so this is what a short write would break: on
// a partial count stdio retries the remainder and loses the error along the way,
// leaving a failed request reported as success.
test('a failure reaches $? through a buffered writer too', async () => {
  const r = await sh(
    "printf 'nope\\n' > /dev/host; echo \"printf=$?\"\n"
    + 'echo nope > /dev/host; echo "echo=$?"\n'
    + 'echo "answer=[$(cat /dev/host)]"\n',
    { host: { yes: () => 'ok' } },
  );
  assert.equal(r.stdout, 'printf=1\necho=1\nanswer=[]\n');
  assert.match(r.stderr, /no such verb/, 'and the port said why');
});

// Capabilities are injected, never ambient: the default port is nothing.
test('with no port the script is refused at the device, and can say so', async () => {
  const r = await sh("cat /dev/host 2>/dev/null || echo 'no port here'");
  assert.equal(r.stdout, 'no port here\n');
});

test('a verb that throws costs one command, not the session', async () => {
  const r = await sh(
    "echo boom > /dev/host || echo 'write failed'\n"
    + 'echo fine > /dev/host\n'
    + 'cat /dev/host\n',
    { host: { boom: () => { throw new Error('the host said no'); }, fine: () => 'still here\n' } },
  );
  assert.match(r.stdout, /write failed/);
  assert.match(r.stdout, /still here/);
  assert.match(r.stderr, /the host said no/);
});

// A capability object cannot be structured-cloned, so a stock Worker cannot be
// handed one — and silently running without the port would be the worst answer.
test('run({ host }) into a stock worker refuses instead of dropping it', async () => {
  const { run } = await import('../src/run.mjs');
  await assert.rejects(
    () => run({ command: 'true', inline: false, host: { x: () => '' } }),
    /serve\(\{ host \}\)/,
  );
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
