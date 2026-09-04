// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The `net` seam: the three env.__host_sock_* hooks and what a socket
// descriptor is once one exists.
//
// Against a bare WebAssembly.Memory and no guest, the way host-port.test.mjs
// does it — so these pin the JS side even on a dist/busybox.wasm that predates
// sockets. The end-to-end proof, real `wget` over a real net, is in
// scripts.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasiShim } from '../src/shim.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A net that answers from a script and records what it was asked. */
function recordingNet(reply = () => 'hi') {
  const seen = { connects: [], sent: [], closed: [] };
  const conns = new Map();
  let next = 1;
  return {
    seen,
    resolve(name) {
      if (name === 'nowhere.test') return null;
      return `172.29.0.${seen.connects.length + 1}`;
    },
    connect(addr, port) {
      if (port === 9) throw new Error('refused');
      const h = next++;
      seen.connects.push({ addr, port });
      conns.set(h, { out: null, off: 0 });
      return h;
    },
    send(h, bytes) {
      seen.sent.push(dec.decode(bytes));
      conns.get(h).out = enc.encode(reply(dec.decode(bytes)));
      return bytes.length;
    },
    recv(h, max) {
      const c = conns.get(h);
      if (!c.out) return null;                 // nothing yet
      const slice = c.out.subarray(c.off, c.off + max);
      c.off += slice.length;
      return slice;                            // empty means EOF
    },
    poll(h) {
      const c = conns.get(h);
      return { readable: !!c.out, writable: true, hup: !!c.out && c.off >= c.out.length };
    },
    close(h) { seen.closed.push(h); conns.delete(h); },
  };
}

function makeShim(net) {
  const shim = new WasiShim({ net, stderr: () => {} });
  const memory = new WebAssembly.Memory({ initial: 4 });
  shim.bindMemory(memory);
  const imports = shim.imports();
  return {
    shim, net,
    env: imports.env,
    p1: imports.wasi_snapshot_preview1,
    view: () => new DataView(memory.buffer),
    bytes: () => new Uint8Array(memory.buffer),
  };
}

const writeFd = (t, fd, data) => {
  const b = enc.encode(data);
  t.bytes().set(b, 0x1000);
  t.view().setUint32(0x600, 0x1000, true);
  t.view().setUint32(0x604, b.length, true);
  return { errno: t.p1.fd_write(fd, 0x600, 1, 0x608), n: t.view().getUint32(0x608, true) };
};

const readFd = (t, fd, max = 256) => {
  t.view().setUint32(0x700, 0x2000, true);
  t.view().setUint32(0x704, max, true);
  const errno = t.p1.fd_read(fd, 0x700, 1, 0x708);
  const n = t.view().getUint32(0x708, true);
  return { errno, text: dec.decode(t.bytes().subarray(0x2000, 0x2000 + n)) };
};

test('a name resolves into the alias range, network byte order', () => {
  const t = makeShim(recordingNet());
  const name = enc.encode('example.test');
  t.bytes().set(name, 0x100);
  t.bytes()[0x100 + name.length] = 0;

  assert.equal(t.env.__host_sock_resolve(0x100, 0x300), 0);
  // The bytes, in the order struct in_addr holds them, are the dotted quad
  // read left to right. Nothing converts, so nothing can convert wrongly.
  assert.deepEqual([...t.bytes().subarray(0x300, 0x304)], [172, 29, 0, 1]);
});

test('a name with no address is a failure, not an invented one', () => {
  const t = makeShim(recordingNet());
  const name = enc.encode('nowhere.test');
  t.bytes().set(name, 0x100);
  t.bytes()[0x100 + name.length] = 0;
  assert.equal(t.env.__host_sock_resolve(0x100, 0x300), -1);
});

test('connect hands the net back the dotted quad it gave out', () => {
  const t = makeShim(recordingNet());
  const fd = t.env.__host_sock_open();
  assert.ok(fd > 2, 'a socket gets a real descriptor');
  // 172.29.0.1 as struct in_addr holds it: 172 in the low byte.
  const addr = (1 << 24) | (0 << 16) | (29 << 8) | 172;
  assert.equal(t.env.__host_sock_connect(fd, addr, 8080), 0);
  assert.deepEqual(t.net.seen.connects, [{ addr: '172.29.0.1', port: 8080 }]);
});

test('a net that refuses is a failed connect, not a throw into the guest', () => {
  const t = makeShim(recordingNet());
  const fd = t.env.__host_sock_open();
  assert.equal(t.env.__host_sock_connect(fd, 0x0100007f, 9), -1);
});

test('the descriptor reads and writes like any other', () => {
  const t = makeShim(recordingNet((req) => `echo:${req}`));
  const fd = t.env.__host_sock_open();
  t.env.__host_sock_connect(fd, 0x0100007f, 80);

  const w = writeFd(t, fd, 'GET / HTTP/1.1\r\n\r\n');
  assert.equal(w.errno, 0);
  assert.equal(w.n, 18);
  assert.deepEqual(t.net.seen.sent, ['GET / HTTP/1.1\r\n\r\n']);

  const r = readFd(t, fd);
  assert.equal(r.errno, 0);
  assert.equal(r.text, 'echo:GET / HTTP/1.1\r\n\r\n');
  // Drained: an empty read is EOF, which is how the guest learns it is over.
  assert.equal(readFd(t, fd).text, '');
});

test('nothing to read yet is EAGAIN, not an empty read', () => {
  // An empty read means EOF, so answering one before the request is finished
  // would tell the guest the connection ended.
  const t = makeShim(recordingNet());
  const fd = t.env.__host_sock_open();
  t.env.__host_sock_connect(fd, 0x0100007f, 80);
  assert.equal(readFd(t, fd).errno, 6, 'EAGAIN');
});

test('closing the descriptor closes the connection', () => {
  const t = makeShim(recordingNet());
  const fd = t.env.__host_sock_open();
  t.env.__host_sock_connect(fd, 0x0100007f, 80);
  t.p1.fd_close(fd);
  assert.equal(t.net.seen.closed.length, 1);
});

test('poll asks the net rather than assuming', () => {
  const t = makeShim(recordingNet());
  const fd = t.env.__host_sock_open();
  t.env.__host_sock_connect(fd, 0x0100007f, 80);

  // One fd_read subscription, no timeout.
  const sub = 0x800;
  t.view().setBigUint64(sub, 7n, true);        // userdata
  t.view().setUint8(sub + 8, 1);               // fd_read
  t.view().setUint32(sub + 16, fd, true);
  t.p1.poll_oneoff(sub, 0x900, 1, 0x9F0);
  // Nothing written yet: the net says not readable, and with no timeout to
  // report the poll still has to say something rather than spin.
  assert.equal(t.view().getUint32(0x9F0, true), 1);

  writeFd(t, fd, 'x');
  t.p1.poll_oneoff(sub, 0x900, 1, 0x9F0);
  assert.equal(t.view().getBigUint64(0x900, true), 7n, 'the event echoes the userdata');
});

test('without a net, a socket cannot be made at all', () => {
  const t = makeShim(undefined);
  assert.equal(t.env.__host_sock_open(), -1);
  assert.equal(t.env.__host_sock_resolve(0x100, 0x300), -1);
});

// ─── listening ───────────────────────────────────────────────────────────────

/**
 * A net that can be listened on. `arrive()` is the embedder handing a
 * connection in — the whole point of the inbound half — and `waited` records
 * what the guest asked to be parked for.
 */
function listeningNet(reply = () => 'ok') {
  const seen = { bound: [], closed: [], waited: [] };
  const conns = new Map();
  const queues = new Map();
  let next = 1;
  const net = {
    seen,
    resolve: (n) => `172.29.0.1`,
    connect() { throw new Error('outbound is not what this net is for'); },
    listen(addr, port) {
      // A port is taken or free for the whole net, which is what makes the
      // table one table rather than several that agree.
      for (const b of seen.bound) if (b.port === port && !b.gone) throw new Error('EADDRINUSE');
      const h = next++;
      seen.bound.push({ addr, port, handle: h, gone: false });
      queues.set(h, []);
      return h;
    },
    accept(h) {
      const q = queues.get(h);
      if (!q || !q.length) return null;
      return q.shift();
    },
    send(h, bytes) { conns.get(h).out = enc.encode(reply(dec.decode(bytes))); return bytes.length; },
    recv(h, max) {
      const c = conns.get(h);
      if (!c) return null;
      if (c.inOff < c.in.length) {
        const slice = c.in.subarray(c.inOff, c.inOff + max);
        c.inOff += slice.length;
        return slice;
      }
      if (!c.out) return null;
      const slice = c.out.subarray(c.outOff, c.outOff + max);
      c.outOff += slice.length;
      return slice;
    },
    poll(h) {
      const q = queues.get(h);
      if (q) return { readable: q.length > 0, writable: false, hup: false };
      const c = conns.get(h);
      return { readable: !!c && c.inOff < c.in.length, writable: true, hup: false };
    },
    close(h) {
      seen.closed.push(h);
      const b = seen.bound.find((x) => x.handle === h);
      if (b) b.gone = true;
      queues.delete(h);
      conns.delete(h);
    },
    wait(ms) { seen.waited.push(ms); },
    /** The embedder's door: a connection lands on a listening handle. */
    arrive(listenHandle, request) {
      const h = next++;
      conns.set(h, { in: enc.encode(request), inOff: 0, out: null, outOff: 0 });
      queues.get(listenHandle).push(h);
      return h;
    },
  };
  return net;
}

/** bind + listen on a fresh socket, returning its fd. 127.0.0.1 by default. */
function listenOn(t, port, addr = 0x0100007f) {
  const fd = t.env.__host_sock_open();
  assert.equal(t.env.__host_sock_bind(fd, addr, port), 0);
  assert.equal(t.env.__host_sock_listen(fd), 0);
  return fd;
}

/** sock_accept, as wasi-libc's accept(2) calls it. Returns fd or the errno. */
function acceptFd(t, fd) {
  const errno = t.p1.sock_accept(fd, 0, 0xA00);
  return errno === 0 ? t.view().getUint32(0xA00, true) : -errno;
}

test('bind carries the address and listen opens the port', () => {
  const t = makeShim(listeningNet());
  listenOn(t, 8000);
  assert.deepEqual(t.net.seen.bound.map(({ addr, port }) => ({ addr, port })),
    [{ addr: '127.0.0.1', port: 8000 }]);
});

test('listen without bind refuses rather than inventing an address', () => {
  const t = makeShim(listeningNet());
  const fd = t.env.__host_sock_open();
  assert.equal(t.env.__host_sock_listen(fd), -1);
});

test('a port already taken is refused, not silently shared', () => {
  const t = makeShim(listeningNet());
  listenOn(t, 8000);
  const second = t.env.__host_sock_open();
  assert.equal(t.env.__host_sock_bind(second, 0x0100007f, 8000), 0);
  assert.equal(t.env.__host_sock_listen(second), -1, 'the net threw and it became a failure');
});

test('closing a listening socket gives the port back', () => {
  const t = makeShim(listeningNet());
  const fd = listenOn(t, 8000);
  t.p1.fd_close(fd);
  assert.equal(t.net.seen.closed.length, 1);
  // Provable rather than asserted about internals: the port binds again.
  listenOn(t, 8000);
});

test('accept with nobody there is EAGAIN', () => {
  const t = makeShim(listeningNet());
  const fd = listenOn(t, 8000);
  assert.equal(acceptFd(t, fd), -6, 'EAGAIN');
});

test('accept on a socket that never listened is EBADF', () => {
  const t = makeShim(listeningNet());
  const fd = t.env.__host_sock_open();
  assert.equal(acceptFd(t, fd), -8, 'EBADF');
});

test('an accepted connection is an ordinary descriptor', () => {
  // The whole reason accept hands back a handle rather than some second kind
  // of thing: read and write already work on it, unchanged.
  const t = makeShim(listeningNet((req) => `echo:${req}`));
  const fd = listenOn(t, 8000);
  t.net.arrive(t.net.seen.bound[0].handle, 'GET / HTTP/1.1\r\n\r\n');

  const conn = acceptFd(t, fd);
  assert.ok(conn > fd, 'a fresh descriptor, not the listening one');

  assert.equal(readFd(t, conn).text, 'GET / HTTP/1.1\r\n\r\n');
  assert.equal(writeFd(t, conn, 'HTTP/1.1 200 OK\r\n\r\nhi').errno, 0);
  assert.equal(readFd(t, conn).text, 'echo:HTTP/1.1 200 OK\r\n\r\nhi');
});

test('a listening socket polls readable only once somebody is waiting', () => {
  const t = makeShim(listeningNet());
  const fd = listenOn(t, 8000);

  // A zero timeout is a probe: it must not park, and it must not lie.
  const sub = 0x800;
  t.view().setBigUint64(sub, 11n, true);
  t.view().setUint8(sub + 8, 1);
  t.view().setUint32(sub + 16, fd, true);
  const clock = sub + 48;
  t.view().setBigUint64(clock, 12n, true);
  t.view().setUint8(clock + 8, 0);
  t.view().setBigUint64(clock + 24, 0n, true);

  t.p1.poll_oneoff(sub, 0x900, 2, 0x9F0);
  assert.equal(t.view().getBigUint64(0x900, true), 12n, 'the clock, not the socket');
  assert.deepEqual(t.net.seen.waited, [], 'a zero timeout never parks');

  t.net.arrive(t.net.seen.bound[0].handle, 'GET / HTTP/1.1\r\n\r\n');
  t.p1.poll_oneoff(sub, 0x900, 2, 0x9F0);
  assert.equal(t.view().getBigUint64(0x900, true), 11n, 'now the socket');
});

test('a poll with nothing to accept parks on the net instead of spinning', () => {
  // The difference between an accept loop that idles and one that owns the CPU
  // and never yields to the JS that would hand it a connection.
  const t = makeShim(listeningNet());
  const fd = listenOn(t, 8000);
  const sub = 0x800;
  t.view().setBigUint64(sub, 11n, true);
  t.view().setUint8(sub + 8, 1);
  t.view().setUint32(sub + 16, fd, true);
  const clock = sub + 48;
  t.view().setBigUint64(clock, 12n, true);
  t.view().setUint8(clock + 8, 0);
  t.view().setBigUint64(clock + 24, 50n * 1000000n, true);   // 50ms

  t.p1.poll_oneoff(sub, 0x900, 2, 0x9F0);
  assert.ok(t.net.seen.waited.length > 0, 'it parked');
  assert.ok(t.net.seen.waited.every((ms) => ms > 0 && ms <= 50), 'never longer than asked');
  assert.equal(t.view().getBigUint64(0x900, true), 12n, 'and reported the timeout');
});

test('a net with no wait keeps the behaviour it always had', () => {
  // Its ABSENCE is the signal, exactly as recvAsync's is.
  const net = listeningNet();
  delete net.wait;
  const t = makeShim(net);
  const fd = listenOn(t, 8000);
  const sub = 0x800;
  t.view().setBigUint64(sub, 11n, true);
  t.view().setUint8(sub + 8, 1);
  t.view().setUint32(sub + 16, fd, true);
  // No timeout, nothing pending: it reports readable rather than spinning, and
  // the caller finds out from accept.
  t.p1.poll_oneoff(sub, 0x900, 1, 0x9F0);
  assert.equal(t.view().getUint32(0x9F0, true), 1);
  assert.equal(t.view().getBigUint64(0x900, true), 11n);
});

test('opening a port is reported, and so is giving it back', () => {
  // The event a watcher acts on, and the only one: it is listen(2) returning,
  // not a command line and not a convention.
  const seen = [];
  const net = listeningNet();
  const shim = new WasiShim({ net, onPort: (e) => seen.push(e), stderr: () => {} });
  const memory = new WebAssembly.Memory({ initial: 4 });
  shim.bindMemory(memory);
  const t = { shim, net, env: shim.imports().env, p1: shim.imports().wasi_snapshot_preview1,
    view: () => new DataView(memory.buffer), bytes: () => new Uint8Array(memory.buffer) };

  const fd = listenOn(t, 8000);
  assert.deepEqual(seen, [{ type: 'open', address: '127.0.0.1', port: 8000 }]);

  t.p1.fd_close(fd);
  assert.deepEqual(seen[1], { type: 'close', address: '127.0.0.1', port: 8000 });
});

test('a server that dies holding its port still gives it back', () => {
  // Otherwise whoever is watching stays pointed at a port with nothing behind
  // it for the rest of the session.
  const seen = [];
  const net = listeningNet();
  const shim = new WasiShim({ net, onPort: (e) => seen.push(e), stderr: () => {} });
  const memory = new WebAssembly.Memory({ initial: 4 });
  shim.bindMemory(memory);
  const t = { shim, net, env: shim.imports().env, p1: shim.imports().wasi_snapshot_preview1,
    view: () => new DataView(memory.buffer), bytes: () => new Uint8Array(memory.buffer) };

  listenOn(t, 8000);
  assert.throws(() => t.p1.proc_exit(130), (e) => e.name === 'WasiExit' || e instanceof Error);
  assert.deepEqual(seen.map((e) => e.type), ['open', 'close']);
  assert.equal(net.seen.closed.length, 1, 'and the net was told, not just the watcher');
});

test('a listener that throws does not take the shell down with it', () => {
  // This runs inside a wasm import: an exception would unwind the guest stack.
  const errs = [];
  const net = listeningNet();
  const shim = new WasiShim({ net, onPort: () => { throw new Error('boom'); },
    stderr: (b) => errs.push(dec.decode(b)) });
  const memory = new WebAssembly.Memory({ initial: 4 });
  shim.bindMemory(memory);
  const t = { shim, net, env: shim.imports().env, p1: shim.imports().wasi_snapshot_preview1,
    view: () => new DataView(memory.buffer), bytes: () => new Uint8Array(memory.buffer) };

  assert.doesNotThrow(() => listenOn(t, 8000));
  assert.match(errs.join(''), /a port listener threw: boom/);
});

test('without listen on the net, a guest cannot open a port', () => {
  // An embedder with an outbound-only net is unchanged: the six methods it
  // always had still work, and the seventh simply is not there.
  const t = makeShim(recordingNet());
  const fd = t.env.__host_sock_open();
  assert.equal(t.env.__host_sock_bind(fd, 0x0100007f, 8000), 0);
  assert.equal(t.env.__host_sock_listen(fd), -1);
  assert.equal(acceptFd(t, fd), -8, 'EBADF: nothing ever started listening');
});

// ─── the awaited door ────────────────────────────────────────────────────────

test('a socket read suspends only where both halves say it can', () => {
  // Feature-detected from the port rather than asked for: an embedder is handed
  // a net and cannot know whether it has an awaited door. Both halves are
  // required — an engine that can suspend, and a net with something to await —
  // and the ABSENCE of either is what keeps today's synchronous read.
  const plain = recordingNet();
  const awaited = { ...recordingNet(), recvAsync: async () => null };

  assert.equal(new WasiShim({ net: awaited }).suspendNet, false,
    'a session not entered through WebAssembly.promising cannot suspend at all');
  assert.equal(new WasiShim({ net: plain, suspendable: true }).suspendNet, false,
    'and a net with nothing to await has nothing to suspend on');
  assert.equal(new WasiShim({ net: awaited, suspendable: true }).suspendNet, true);
});

// ─── end to end: the real applet, over a net that answers from memory ────────

import { run } from '../src/run.mjs';
import { existsSync } from 'node:fs';

const HAVE_WASM = existsSync(new URL('../dist/busybox.wasm', import.meta.url));
const e2e = { skip: HAVE_WASM ? false : 'dist/busybox.wasm is missing — run npm run build:wasm' };

/**
 * A net that speaks HTTP without a network.
 *
 * Enough to prove the whole path: wget resolves a name, opens a descriptor,
 * connects, writes a request through fd_write and reads the answer through
 * fd_read. What carries the bytes is not wasi-sh's business — sockfetch is what
 * this project puts here, and it is tested where it lives.
 */
function cannedNet(respond) {
  const conns = new Map();
  const names = new Map();
  let next = 1;
  let id = 0;
  return {
    seen: [],
    resolve(name) {
      if (!names.has(name)) names.set(name, `172.29.0.${++id}`);
      return names.get(name);
    },
    connect(addr, port) {
      const h = next++;
      conns.set(h, { addr, port, req: '', out: null, off: 0 });
      this.seen.push({ addr, port });
      return h;
    },
    send(h, bytes) {
      const c = conns.get(h);
      c.req += dec.decode(bytes);
      if (c.req.includes('\r\n\r\n')) c.out = enc.encode(respond(c.req, c.port));
      return bytes.length;
    },
    recv(h, max) {
      const c = conns.get(h);
      if (!c.out) return null;
      const slice = c.out.subarray(c.off, c.off + max);
      c.off += slice.length;
      return slice;
    },
    poll(h) {
      const c = conns.get(h);
      return { readable: !!c.out, writable: true, hup: !!c.out && c.off >= c.out.length };
    },
    close(h) { conns.delete(h); },
  };
}

const httpOk = (body) => [
  'HTTP/1.1 200 OK', 'Content-Type: text/plain',
  `Content-Length: ${body.length}`, 'Connection: close', '', body,
].join('\r\n');

test('wget fetches, for real', e2e, async () => {
  const net = cannedNet(() => httpOk('hello from a net'));
  const r = await run({ inline: true, net, args: ['wget', '-q', '-O', '-', 'http://example.test/thing'] });

  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout, 'hello from a net');
  // The name was resolved and the alias connected to, on the default port.
  assert.deepEqual(net.seen, [{ addr: '172.29.0.1', port: 80 }]);
});

test('wget writes a request the other end can read', e2e, async () => {
  let seenRequest = '';
  const net = cannedNet((req) => { seenRequest = req; return httpOk('x'); });
  await run({ inline: true, net, args: ['wget', '-q', '-O', '-', 'http://example.test/a/b?c=d'] });

  assert.match(seenRequest, /^GET \/a\/b\?c=d HTTP\/1\.1\r\n/);
  assert.match(seenRequest, /Host: example\.test\r\n/);
});

test('https is spoken as plaintext on 443', e2e, async () => {
  // build/wget-https.patch. Without it wget refuses the scheme outright, and a
  // script does not choose its scheme — a redirect hands it one.
  const net = cannedNet(() => httpOk('secure enough'));
  const r = await run({ inline: true, net, args: ['wget', '-q', '-O', '-', 'https://example.test/thing'] });

  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout, 'secure enough');
  assert.equal(net.seen[0].port, 443, 'the port is the only thing left saying https');
});

// `-O -` is how anybody uses wget at a prompt, and it is the one form that
// cannot work by accident here: it writes to fd 1 and closes it on the way out,
// which is free where wget is a process and takes the SHELL's stdout where it
// is an applet in the shell's own. See build/wget-stdout.patch — the symptom
// was every command after this one failing with "write error: Bad file
// descriptor", naming neither wget nor the descriptor it took.
test('wget -O - leaves the shell its stdout', e2e, async () => {
  const net = cannedNet(() => httpOk('a body'));
  const r = await run({
    inline: true,
    net,
    command: 'wget -q -O - http://example.test/thing; echo "and then $?"',
  });

  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'a bodyand then 0\n');
  assert.equal(r.exitCode, 0);
});

test("wget reports the server's error as its own", e2e, async () => {
  const net = cannedNet(() => 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  const r = await run({ inline: true, net, args: ['wget', '-O', '-', 'http://example.test/missing'] });

  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /404 Not Found/);
});

test('without a net, wget fails rather than hanging', e2e, async () => {
  const r = await run({ inline: true, args: ['wget', '-q', '-O', '-', 'http://example.test/thing'] });
  assert.notEqual(r.exitCode, 0);
});

// ─── the awaited door, end to end ────────────────────────────────────────────

/**
 * The same canned net, with an awaited door that really does yield.
 *
 * `recvAsync` waits a macrotask before answering, which is the honest shape: a
 * real one is waiting on `fetch`, and what the shim has to get right is that
 * the thread is GIVEN BACK in the meantime rather than held.
 */
function awaitedNet(respond) {
  const net = cannedNet(respond);
  net.recvAsync = async (h, max) => {
    await new Promise((r) => setTimeout(r, 0));
    return net.recv(h, max);
  };
  return net;
}

test('wget fetches through the awaited door too', e2e, async () => {
  const net = awaitedNet(() => httpOk('hello from a suspended read'));
  const r = await run({
    inline: true, net, suspendable: true,
    args: ['wget', '-q', '-O', '-', 'http://example.test/thing'],
  });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout, 'hello from a suspended read');
});

test('and the thread it used to own keeps turning while it does', e2e, async () => {
  // The whole point, and the only assertion that can show it. A guest parked on
  // a socket owns its worker outright: the event loop under it stops, so an
  // editor's file read, a preview frame's request and the page's own messages
  // all wait for the download to finish. Suspended, they do not.
  //
  // Asked of the loop itself rather than of a clock. A macrotask is queued when
  // the request goes out and the answer is taken when the guest closes the
  // socket — still inside the run — so this is "did anything else get to run
  // between the two", which has one right answer per door and does not depend
  // on how busy the machine is.
  const observed = (awaited) => {
    const net = awaited
      ? awaitedNet(() => httpOk('body'))
      : cannedNet(() => httpOk('body'));
    let ran = false;
    const send = net.send.bind(net);
    const close = net.close.bind(net);
    net.send = (h, b) => { setTimeout(() => { ran = true; }, 0); return send(h, b); };
    net.close = (h) => { net.ranBeforeClose = ran; return close(h); };
    return net;
  };

  const parked = observed(false);
  const r1 = await run({
    inline: true, net: parked, suspendable: true,
    args: ['wget', '-q', '-O', '-', 'http://example.test/thing'],
  });
  assert.equal(r1.exitCode, 0, r1.stderr);
  assert.equal(parked.ranBeforeClose, false,
    'a parked read holds the thread: nothing else can have run');

  const suspended = observed(true);
  const r2 = await run({
    inline: true, net: suspended, suspendable: true,
    args: ['wget', '-q', '-O', '-', 'http://example.test/thing'],
  });
  assert.equal(r2.exitCode, 0, r2.stderr);
  assert.equal(suspended.ranBeforeClose, true,
    'an awaited read hands the thread back, and the queue behind it drains');
});

test('a non-blocking socket is still non-blocking', e2e, async () => {
  // An fd that asked not to wait must not be made to wait by the door being
  // open. The suspending twin hands those straight to the synchronous read,
  // EAGAIN and all — otherwise O_NONBLOCK would mean its opposite whenever the
  // engine happened to have JSPI.
  const t = makeShim({ ...recordingNet(), recvAsync: async () => { throw new Error('must not be reached'); } });
  const fd = t.env.__host_sock_open();
  t.env.__host_sock_connect(fd, 0x0100007f, 80);
  assert.equal(readFd(t, fd).errno, 6, 'EAGAIN');
});

// ─── ^C during a download, on both doors ─────────────────────────────────────

import { WasiExit } from '../src/shim.mjs';
import { compileWasm } from '../src/node.mjs';
import { fixedInput, mergeEnv } from '../src/options.mjs';

/**
 * A net whose body arrives in many chunks, and which raises a ^C partway.
 *
 * The interrupt comes from the net only because something has to stand in for
 * the page pressing the key at the right moment; what it writes is the same
 * monotonic count `ring.mjs` writes, read through the same `interruptCount`.
 */
function chunkedNet({ chunks, interruptAfter, awaited }) {
  const body = 'x'.repeat(64);
  const head = [
    'HTTP/1.1 200 OK', 'Content-Type: text/plain',
    `Content-Length: ${body.length * chunks}`, 'Connection: close', '', '',
  ].join('\r\n');
  const state = { interrupts: 0, delivered: 0 };
  const conns = new Map();
  let next = 1;

  const takeOne = (h) => {
    const c = conns.get(h);
    if (!c.started) return null;                       // still writing its request
    if (c.sentHead === false) { c.sentHead = true; return enc.encode(head); }
    if (c.left === 0) return new Uint8Array(0);        // EOF
    c.left--;
    state.delivered++;
    if (state.delivered === interruptAfter) state.interrupts++;
    return enc.encode(body);
  };

  const net = {
    state,
    resolve: () => '172.29.0.1',
    connect() { const h = next++; conns.set(h, { started: false, sentHead: false, left: chunks }); return h; },
    send(h, bytes) {
      const c = conns.get(h);
      c.req = (c.req || '') + dec.decode(bytes);
      if (c.req.includes('\r\n\r\n')) c.started = true;
      return bytes.length;
    },
    recv: takeOne,
    poll(h) { const c = conns.get(h); return { readable: c.started, writable: true, hup: c.started && c.left === 0 }; },
    close(h) { conns.delete(h); },
  };
  if (awaited) net.recvAsync = async (h, max) => { await new Promise((r) => setTimeout(r, 0)); return takeOne(h, max); };
  return net;
}

/** runInline(), opened up enough to give the session an interrupt source. */
async function runInterruptible(net) {
  const module = await compileWasm();
  let stdout = '';
  const shim = new WasiShim({
    // Through the SHELL, not as the entry applet. The interrupt machinery is
    // installed by run_nofork_applet (build/applet-interrupt.patch) and
    // deliberately not at the shell itself — outside an applet there is no
    // die_func to longjmp to. A `busybox wget ...` invocation never enters that
    // path at all, so it is uninterruptible by construction and would prove
    // nothing about the doors.
    args: ['busybox', 'ash', '-c', 'wget -q -O - http://example.test/thing'],
    env: mergeEnv({}),
    stdout: (b) => { stdout += dec.decode(b); },
    stderr: () => {},
    // A fixed stdin that also carries a ^C count, which is the one thing
    // run()'s cannot: with no `interruptCount` the applet's safe points read a
    // constant and nothing is ever cancellable.
    input: { ...fixedInput(''), interruptCount: () => net.state.interrupts },
    net,
    suspendable: true,
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  let exitCode = 0;
  try { await WebAssembly.promising(instance.exports._start)(); }
  catch (e) { if (e instanceof WasiExit) exitCode = e.code; else throw e; }
  return { exitCode, stdout, delivered: net.state.delivered };
}

for (const [door, awaited] of [['parked', false], ['awaited', true]]) {
  test(`a ^C mid-download stops it, on the ${door} door`, e2e, async () => {
    // Both doors, and the answer has to be the same. The interrupt is
    // cooperative and entirely guest-side — busybox checks a monotonic count at
    // its own I/O safe points, which sit BEFORE each read — so what decides
    // whether a download can be stopped is that reads RETURN, chunk by chunk,
    // not which thread was waiting for them. Suspending the guest does not make
    // this better and parking it did not make it worse.
    const r = await runInterruptible(chunkedNet({ chunks: 40, interruptAfter: 3, awaited }));
    assert.equal(r.exitCode, 130, `expected 128+SIGINT, got ${r.exitCode}`);
    assert.ok(r.delivered < 40, `it stopped early: ${r.delivered} of 40 chunks`);
  });
}

test('and an uninterrupted download of the same shape finishes', e2e, async () => {
  // The control. Without it, a wget that failed for any other reason would
  // read as a successful interrupt.
  const r = await runInterruptible(chunkedNet({ chunks: 40, interruptAfter: 0, awaited: true }));
  assert.equal(r.exitCode, 0);
  assert.equal(r.delivered, 40);
  assert.equal(r.stdout.length, 40 * 64);
});

// ─── a real server, for real ─────────────────────────────────────────────────

test('busybox httpd answers a request, unmodified', e2e, async () => {
  // The whole point of the capability, with no PHP and no Emscripten in it:
  // an application this shell HOSTS is a server. Inetd mode needs no socket at
  // all — a request on stdin, a response on stdout — so this pins the half
  // that works today without a wire, and it is a real binary answering.
  const r = await run({
    inline: true,
    files: { '/www/index.html': '<h1>served</h1>\n' },
    command: 'httpd -i -h /www',
    stdin: 'GET /index.html HTTP/1.0\r\n\r\n',
  });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(r.stdout, /Content-Length: 16\r\n/);
  assert.match(r.stdout, /\r\n\r\n<h1>served<\/h1>\n$/);
});

test('httpd binds through the net, address and port intact', e2e, async () => {
  // socket(2) -> bind(2) -> listen(2), from an unmodified binary, all the way
  // to the embedder's port. A refusal is what proves the round trip carried
  // real values: busybox prints the errno the C stub chose, from the throw the
  // net made, about the address the guest asked for.
  const asked = [];
  const r = await run({
    inline: true,
    net: {
      resolve: () => null,
      connect() { throw new Error('outbound is not what this is'); },
      listen(address, port) { asked.push({ address, port }); throw new Error('taken'); },
      accept: () => null,
      send: () => 0,
      recv: () => null,
      poll: () => ({ readable: false, writable: true, hup: false }),
      close: () => {},
    },
    files: { '/www/index.html': 'hi\n' },
    command: 'httpd -p 8000 -h /www -f',
  });
  assert.deepEqual(asked, [{ address: '0.0.0.0', port: 8000 }]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /listen: Address in use/);
});

test('a port opened by a real binary is reported, and given back', e2e, async () => {
  // listen(2) returning IS the event — not a command line, not a convention.
  //
  // httpd binds and listens in openServer() and only then daemonizes, and this
  // shell is fork-free, so it dies holding the port. That makes one command
  // prove both halves: the open, and the close that a server which never
  // cleaned up still owes whoever is watching.
  const ports = [];
  const r = await run({
    inline: true,
    onPort: (e) => ports.push(e),
    net: {
      resolve: () => null,
      connect() { throw new Error('outbound is not what this is'); },
      listen: () => 'L',
      accept: () => null,
      send: () => 0,
      recv: () => null,
      poll: () => ({ readable: false, writable: true, hup: false }),
      close: () => {},
    },
    files: { '/www/index.html': 'hi\n' },
    command: 'httpd -p 8000 -h /www',       // no -f: it daemonizes, and cannot
  });
  // Its own words. The status is 0 because httpd sets xfunc_error_retval = 0
  // just above the daemonize, so stderr is the only thing that says what
  // happened — which is the point worth pinning.
  assert.match(r.stderr, /fork: Function not implemented/);
  assert.deepEqual(ports.map((e) => `${e.type} ${e.address}:${e.port}`),
    ['open 0.0.0.0:8000', 'close 0.0.0.0:8000']);
});

// ─── sock_shutdown ───────────────────────────────────────────────────────────

test('a half-close succeeds, because the close is what the net acts on', () => {
  // There is no direction to shut down independently here: a connection is one
  // exchange over a handle the net owns. Succeeding is right rather than
  // lenient — a server that shuts its write side and then closes has said the
  // same thing twice, and refusing would turn the first into a failure report
  // about something that was never going to matter.
  const t = makeShim(listeningNet());
  const listen = listenOn(t, 8000);
  t.net.arrive(t.net.seen.bound[0].handle, 'GET / HTTP/1.0\r\n\r\n');
  const fd = acceptFd(t, listen);
  assert.equal(t.p1.sock_shutdown(fd, 1), 0, 'SHUT_WR');
  assert.equal(t.p1.sock_shutdown(fd, 2), 0, 'SHUT_RDWR');
});

test('and the socket still works afterwards, since nothing was shut', () => {
  const t = makeShim(listeningNet(() => 'answered'));
  const listen = listenOn(t, 8000);
  t.net.arrive(t.net.seen.bound[0].handle, 'ask');
  const fd = acceptFd(t, listen);
  assert.equal(readFd(t, fd).text, 'ask', 'the request the embedder handed in');
  assert.equal(t.p1.sock_shutdown(fd, 1), 0);
  assert.equal(writeFd(t, fd, 'ask').errno, 0);
  assert.equal(readFd(t, fd).text, 'answered');
});

test('shutting down something that is not a socket is ENOTSOCK', () => {
  const t = makeShim(listeningNet());
  assert.equal(t.p1.sock_shutdown(1, 1), 57, 'ENOTSOCK on stdout');
});

test('and on a descriptor that is not open at all, EBADF', () => {
  const t = makeShim(listeningNet());
  assert.equal(t.p1.sock_shutdown(99, 1), 8, 'EBADF');
});
