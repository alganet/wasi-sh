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
