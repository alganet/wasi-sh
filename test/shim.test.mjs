// Pins WasiShim behavior at the import-function level: hand-laid-out buffers
// in a bare WebAssembly.Memory, no wasm module involved. Written against the
// verbatim POC port BEFORE cleanups, so cleanups diff against green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasiShim, WasiExit } from '../src/shim.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// A shim bound to a bare 1-page memory, plus scratch helpers.
function makeShim(opts = {}) {
  const shim = new WasiShim(opts);
  const memory = new WebAssembly.Memory({ initial: 1 });
  shim.bindMemory(memory);
  const imports = shim.imports();
  const p1 = imports.wasi_snapshot_preview1;
  const env = imports.env;
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  return { shim, p1, env, view, bytes };
}

// Lay out one iovec [ptr,len] pair at `iovsAt`, buffer at `bufAt`.
function iovec(view, iovsAt, bufAt, len) {
  view().setUint32(iovsAt, bufAt, true);
  view().setUint32(iovsAt + 4, len, true);
}

// Write a path string into memory, return [ptr, len].
function putStr(bytes, at, s) {
  const b = enc.encode(s);
  bytes().set(b, at);
  return [at, b.length];
}

// path_open against preopen fd 3 ('/'); returns the opened fd.
// oflags: 1=CREAT 4=EXCL 8=TRUNC; fdflags: 1=APPEND
function openPath(t, path, expectErrno = 0, oflags = 0, fdflags = 0) {
  const [p, len] = putStr(t.bytes, 0x100, path);
  const errno = t.p1.path_open(3, 0, p, len, oflags, 0n, 0n, fdflags, 0x200);
  assert.equal(errno, expectErrno, `path_open(${path}) errno`);
  return expectErrno === 0 ? t.view().getUint32(0x200, true) : -1;
}

// fd_read into a 256-byte buffer; returns {errno, data}.
function readFd(t, fd, max = 256) {
  iovec(t.view, 0x300, 0x400, max);
  const errno = t.p1.fd_read(fd, 0x300, 1, 0x308);
  const n = t.view().getUint32(0x308, true);
  return { errno, n, data: t.bytes().slice(0x400, 0x400 + n) };
}

// fd_write from a byte string; returns {errno, n}.
function writeFd(t, fd, s) {
  const b = enc.encode(s);
  t.bytes().set(b, 0x500);
  iovec(t.view, 0x600, 0x500, b.length);
  const errno = t.p1.fd_write(fd, 0x600, 1, 0x608);
  return { errno, n: t.view().getUint32(0x608, true) };
}

// ─── args / env marshalling ──────────────────────────────────────────────────

test('args/environ size and content marshalling', () => {
  const t = makeShim({ args: ['busybox', 'sh'], env: { A: '1', LONG: 'x y' } });
  t.p1.args_sizes_get(0x10, 0x14);
  assert.equal(t.view().getUint32(0x10, true), 2);
  assert.equal(t.view().getUint32(0x14, true), 'busybox\0sh\0'.length);
  t.p1.args_get(0x20, 0x40);
  assert.equal(dec.decode(t.bytes().slice(0x40, 0x40 + 11)), 'busybox\0sh\0');

  t.p1.environ_sizes_get(0x10, 0x14);
  assert.equal(t.view().getUint32(0x10, true), 2);
  t.p1.environ_get(0x20, 0x80);
  const envBlob = dec.decode(t.bytes().slice(0x80, 0x80 + 13));
  assert.equal(envBlob, 'A=1\0LONG=x y\0');
});

test('proc_exit throws WasiExit with the code', () => {
  const t = makeShim();
  assert.throws(() => t.p1.proc_exit(7), (e) => e instanceof WasiExit && e.code === 7);
});

// ─── FS: buildFs normalization + path ops ────────────────────────────────────

test('buildFs: relative and unnormalized paths mount at normalized absolutes', () => {
  const t = makeShim({ files: { 'rel.txt': 'r', '/a/./b/../c.txt': 'c' } });
  assert.ok(t.shim.lookup('/rel.txt'), 'relative path mounts at /rel.txt');
  assert.ok(t.shim.lookup('/a/c.txt'), '. and .. collapse');
  assert.equal(t.shim.lookup('/a').type, 'dir', 'parent dirs synthesized');
});

test('resolve: relative paths resolve against the fd directory; .. clamps at root', () => {
  const t = makeShim({ files: { '/d/f.txt': 'x' } });
  assert.equal(t.shim.resolve(3, 'd/f.txt'), '/d/f.txt');
  assert.equal(t.shim.resolve(3, '/../../etc'), '/etc', '.. above root clamps');
});

test('path_open + fd_read on a mounted file; fd_seek repositions', () => {
  const t = makeShim({ files: { '/f.txt': 'hello world' } });
  const fd = openPath(t, '/f.txt');
  assert.equal(dec.decode(readFd(t, fd).data), 'hello world');
  // seek back to 6 (whence 0 = SET), read the tail
  t.p1.fd_seek(fd, 6n, 0, 0x700);
  assert.equal(t.view().getBigUint64(0x700, true), 6n);
  assert.equal(dec.decode(readFd(t, fd).data), 'world');
});

test('path_open on a missing path: NOENT without O_CREAT; O_CREAT creates', () => {
  const t = makeShim();
  openPath(t, '/nope.txt', 44 /* NOENT */);
  openPath(t, '/tmp/scratch', 44, 0, 0); // no O_CREAT: missing is missing
  const tmp = openPath(t, '/tmp/scratch', 0, 1 /* CREAT */);
  assert.ok(tmp > 0, 'O_CREAT creates under an existing dir');
  openPath(t, '/nodir/f.txt', 44, 1, 0); // parent dir missing: NOENT even with O_CREAT
  const devnull = openPath(t, '/dev/null');
  assert.ok(devnull > 0);
});

// ─── writable FS: create / truncate / append / CoW ───────────────────────────

test('created file: write then reopen and read back', () => {
  const t = makeShim();
  const wfd = openPath(t, '/tmp/out.txt', 0, 1 /* CREAT */);
  assert.equal(writeFd(t, wfd, 'first').errno, 0);
  const rfd = openPath(t, '/tmp/out.txt');
  assert.equal(dec.decode(readFd(t, rfd).data), 'first');
});

test('O_TRUNC clears an existing file; O_EXCL on an existing file is EEXIST', () => {
  const t = makeShim({ files: { '/f.txt': 'old content' } });
  openPath(t, '/f.txt', 20 /* EEXIST */, 1 | 4 /* CREAT|EXCL */);
  const wfd = openPath(t, '/f.txt', 0, 8 /* TRUNC */);
  writeFd(t, wfd, 'new');
  const rfd = openPath(t, '/f.txt');
  assert.equal(dec.decode(readFd(t, rfd).data), 'new');
});

test('O_APPEND writes land at the end regardless of offset', () => {
  const t = makeShim({ files: { '/log.txt': 'a\n' } });
  const fd = openPath(t, '/log.txt', 0, 0, 1 /* APPEND */);
  writeFd(t, fd, 'b\n');
  const rfd = openPath(t, '/log.txt');
  assert.equal(dec.decode(readFd(t, rfd).data), 'a\nb\n');
});

test('copy-on-write: guest writes never mutate the caller-mounted buffer', () => {
  const mounted = enc.encode('pristine');
  const t = makeShim({ files: { '/m.bin': mounted } });
  const fd = openPath(t, '/m.bin', 0, 8 /* TRUNC */);
  writeFd(t, fd, 'scribbled');
  assert.equal(dec.decode(mounted), 'pristine', 'caller buffer untouched');
  const rfd = openPath(t, '/m.bin');
  assert.equal(dec.decode(readFd(t, rfd).data), 'scribbled', 'guest sees its write');
});

test('fd_filestat_get tracks a written file size', () => {
  const t = makeShim();
  const fd = openPath(t, '/tmp/s.txt', 0, 1);
  writeFd(t, fd, '1234567');
  t.p1.fd_filestat_get(fd, 0xa00);
  assert.equal(t.view().getBigUint64(0xa00 + 32, true), 7n);
});

test('/dev/null reads EOF and discards writes', () => {
  const t = makeShim();
  const fd = openPath(t, '/dev/null');
  const r = readFd(t, fd);
  assert.equal(r.errno, 0);
  assert.equal(r.n, 0, 'EOF');
  const w = writeFd(t, fd, 'discarded');
  assert.equal(w.errno, 0);
  assert.equal(w.n, 9, 'write claims success');
});

// ─── a device that can make a read wait ──────────────────────────────────────
// Everything the overlay held until now answers instantly, so poll_oneoff could
// call any non-stdin fd readable and be right. A device whose read BLOCKS turns
// that into the trap S2 found for a resize: poll says readable, the wait happens
// in the read behind it, and nothing there can end it.

// Lay out `subs` ({ud, fd} for a read sub, {ud, ms} for a clock) and return the
// events poll_oneoff produced.
function pollOneoff(t, subs) {
  const SUB = 48, EV = 32, at = 0xb00, out = 0xd00;
  t.bytes().fill(0, at, at + subs.length * SUB);
  subs.forEach((s, i) => {
    const o = at + i * SUB;
    t.view().setBigUint64(o, BigInt(s.ud), true);
    const clock = s.fd === undefined;
    t.view().setUint8(o + 8, clock ? 0 : 1);
    if (clock) t.view().setBigUint64(o + 24, BigInt(Math.round(s.ms * 1e6)), true);
    else t.view().setUint32(o + 16, s.fd, true);
  });
  const errno = t.p1.poll_oneoff(at, out, subs.length, 0xf00);
  const n = t.view().getUint32(0xf00, true);
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({ ud: Number(t.view().getBigUint64(out + i * EV, true)), type: t.view().getUint8(out + i * EV + 10) });
  }
  return { errno, events };
}

test('a device offering poll() is asked, not assumed readable', () => {
  const asked = [];
  const t = makeShim();
  t.shim.addDevice('/dev/slow', { read: () => 6 /* EAGAIN */, poll: (ms) => { asked.push(ms); return false; } });
  const fd = openPath(t, '/dev/slow');
  const r = pollOneoff(t, [{ ud: 7, fd }, { ud: 9, ms: 50 }]);
  assert.deepEqual(asked, [50], 'the device got the timeout to wait out');
  assert.deepEqual(r.events, [{ ud: 9, type: 0 }], 'the clock fired; the fd was never called readable');
});

test('a device that says it is ready is reported readable', () => {
  const t = makeShim();
  t.shim.addDevice('/dev/quick', { read: () => enc.encode('hi'), poll: () => true });
  const fd = openPath(t, '/dev/quick');
  assert.deepEqual(pollOneoff(t, [{ ud: 3, fd }, { ud: 4, ms: 50 }]).events, [{ ud: 3, type: 1 }]);
});

// The half that must NOT change: /dev/null and /dev/host answer the moment they
// are asked, so the absence of poll() has to keep meaning "readable now".
test('a device with no poll() is readable at once, as it always was', () => {
  const t = makeShim();
  const fd = openPath(t, '/dev/null');
  assert.deepEqual(pollOneoff(t, [{ ud: 1, fd }, { ud: 2, ms: 5000 }]).events[0], { ud: 1, type: 1 });
});

// Two parkable subscriptions in one poll would each want the whole wait. Nothing
// busybox does asks for both, and stdin is the one with a signal path, so it
// owns the park and the device is asked without waiting.
test('a device beside stdin is asked without waiting', () => {
  const asked = [];
  const t = makeShim({ input: { pollReadable: () => false, read: () => new Uint8Array(0), closed: () => true } });
  t.shim.addDevice('/dev/slow', { read: () => 6, poll: (ms) => { asked.push(ms); return false; } });
  const fd = openPath(t, '/dev/slow');
  pollOneoff(t, [{ ud: 1, fd }, { ud: 2, fd: 0 }, { ud: 3, ms: 20 }]);
  assert.deepEqual(asked, [0]);
});

test('a device read answers with bytes or with an errno', () => {
  const t = makeShim();
  let armed = false;
  t.shim.addDevice('/dev/late', { read: () => (armed ? enc.encode('at last') : 6 /* EAGAIN */) });
  const fd = openPath(t, '/dev/late');
  const first = readFd(t, fd);
  assert.equal(first.errno, 6, 'an errno is not an empty read — empty already means EOF');
  assert.equal(first.n, 0);
  armed = true;
  assert.equal(dec.decode(readFd(t, fd).data), 'at last');
});

// A blocking device has to know whether it may block, the same way stdin does.
test('a device read is told whether the fd is non-blocking', () => {
  const seen = [];
  const t = makeShim();
  t.shim.addDevice('/dev/flag', { read: (max, owner, nonblock) => { seen.push(nonblock); return enc.encode('x'); } });
  const fd = openPath(t, '/dev/flag');
  readFd(t, fd);
  t.p1.fd_fdstat_set_flags(fd, 4 /* O_NONBLOCK */);
  readFd(t, fd);
  assert.deepEqual(seen, [false, true]);
});

test('fd_readdir walks children with cookies and d_type', () => {
  const t = makeShim({ files: { '/dir/a.txt': 'a', '/dir/b.txt': 'b' } });
  const fd = openPath(t, '/dir');
  const errno = t.p1.fd_readdir(fd, 0x800, 256, 0n, 0x900);
  assert.equal(errno, 0);
  const written = t.view().getUint32(0x900, true);
  assert.ok(written > 0);
  // First dirent: d_next=1, namelen, name
  assert.equal(t.view().getBigUint64(0x800, true), 1n);
  const nlen = t.view().getUint32(0x800 + 16, true);
  assert.equal(dec.decode(t.bytes().slice(0x800 + 24, 0x800 + 24 + nlen)), 'a.txt');
  // Resume from cookie 1 → next entry is b.txt
  t.p1.fd_readdir(fd, 0x800, 256, 1n, 0x900);
  const nlen2 = t.view().getUint32(0x800 + 16, true);
  assert.equal(dec.decode(t.bytes().slice(0x800 + 24, 0x800 + 24 + nlen2)), 'b.txt');
});

test('fd_filestat_get reports size for regular files', () => {
  const t = makeShim({ files: { '/f.txt': '12345' } });
  const fd = openPath(t, '/f.txt');
  t.p1.fd_filestat_get(fd, 0xa00);
  assert.equal(t.view().getUint8(0xa00 + 16), 4, 'filetype REG');
  assert.equal(t.view().getBigUint64(0xa00 + 32, true), 5n, 'size');
});

// ─── writable-FS path ops (rm/mkdir/rmdir/mv syscall surface) ────────────────

// Call a path_* syscall with a string path against preopen fd 3.
function pathOp(t, op, path, ...rest) {
  const [p, len] = putStr(t.bytes, 0x100, path);
  return t.p1[op](3, p, len, ...rest);
}

test('path_create_directory / path_remove_directory lifecycle', () => {
  const t = makeShim();
  assert.equal(pathOp(t, 'path_create_directory', '/tmp/d'), 0);
  assert.equal(t.shim.lookup('/tmp/d').type, 'dir');
  assert.equal(pathOp(t, 'path_create_directory', '/tmp/d'), 20, 'EEXIST on repeat');
  assert.equal(pathOp(t, 'path_create_directory', '/no/parent'), 44, 'NOENT without parent');
  assert.equal(pathOp(t, 'path_remove_directory', '/tmp/d'), 0);
  assert.equal(t.shim.lookup('/tmp/d'), null);
});

test('path_unlink_file removes files, refuses dirs; rmdir refuses non-empty', () => {
  const t = makeShim({ files: { '/dir/f.txt': 'x' } });
  assert.equal(pathOp(t, 'path_unlink_file', '/dir'), 28, 'EINVAL: unlink of a dir');
  assert.equal(pathOp(t, 'path_remove_directory', '/dir'), 55, 'ENOTEMPTY');
  assert.equal(pathOp(t, 'path_unlink_file', '/dir/f.txt'), 0);
  assert.equal(pathOp(t, 'path_unlink_file', '/dir/f.txt'), 44, 'NOENT on repeat');
  assert.equal(pathOp(t, 'path_remove_directory', '/dir'), 0, 'empty now');
});

test('path_rename moves files and directories, dropping the old name', () => {
  const t = makeShim({ files: { '/a/f.txt': 'payload' } });
  // rename the file
  const [p1v, l1] = putStr(t.bytes, 0x100, '/a/f.txt');
  const [p2v, l2] = putStr(t.bytes, 0x180, '/a/g.txt');
  assert.equal(t.p1.path_rename(3, p1v, l1, 3, p2v, l2), 0);
  assert.equal(t.shim.lookup('/a/f.txt'), null);
  assert.equal(dec.decode(t.shim.lookup('/a/g.txt').data), 'payload');
  // rename the directory
  const [p3v, l3] = putStr(t.bytes, 0x100, '/a');
  const [p4v, l4] = putStr(t.bytes, 0x180, '/b');
  assert.equal(t.p1.path_rename(3, p3v, l3, 3, p4v, l4), 0);
  assert.equal(dec.decode(t.shim.lookup('/b/g.txt')?.data ?? new Uint8Array()), 'payload', 'children move with the dir');
});

test('path_filestat_set_times: exists → 0, missing → NOENT (touch branches on this)', () => {
  // NB: unlike the other path_* ops, lookupflags precede the path here.
  const t = makeShim({ files: { '/f.txt': 'x' } });
  const [p1v, l1] = putStr(t.bytes, 0x100, '/f.txt');
  assert.equal(t.p1.path_filestat_set_times(3, 0, p1v, l1, 0n, 0n, 0), 0);
  const [p2v, l2] = putStr(t.bytes, 0x100, '/missing');
  assert.equal(t.p1.path_filestat_set_times(3, 0, p2v, l2, 0n, 0n, 0), 44);
});

test('symlink surface: readlink EINVAL, symlink/link NOSYS', () => {
  const t = makeShim();
  assert.equal(t.p1.path_readlink(), 28);
  assert.equal(t.p1.path_symlink(), 52);
  assert.equal(t.p1.path_link(), 52);
});

test('filestat hands out unique stable inodes (find/cp -r loop detection)', () => {
  const t = makeShim({ files: { '/a.txt': 'a', '/b.txt': 'b' } });
  const ino = (path) => {
    const fd = openPath(t, path);
    t.p1.fd_filestat_get(fd, 0xa00);
    return t.view().getBigUint64(0xa00 + 8, true);
  };
  const a1 = ino('/a.txt'), b = ino('/b.txt'), a2 = ino('/a.txt');
  assert.notEqual(a1, b, 'distinct nodes get distinct inos');
  assert.equal(a1, a2, 'same node keeps its ino');
});

// ─── stdout/stderr callbacks ─────────────────────────────────────────────────

test('fd_write routes 1→stdout and 2→stderr callbacks', () => {
  let out = '', err = '';
  const t = makeShim({
    stdout: (b) => { out += dec.decode(b); },
    stderr: (b) => { err += dec.decode(b); },
  });
  writeFd(t, 1, 'to-out');
  writeFd(t, 2, 'to-err');
  assert.equal(out, 'to-out');
  assert.equal(err, 'to-err');
});

// ─── host pipe / dup hooks ───────────────────────────────────────────────────

test('__host_pipe allocates a read/write fd pair; write then read roundtrips', () => {
  const t = makeShim();
  t.env.__host_pipe(0x10);
  const rfd = t.view().getUint32(0x10, true);
  const wfd = t.view().getUint32(0x14, true);
  assert.notEqual(rfd, wfd);
  writeFd(t, wfd, 'through the pipe');
  assert.equal(dec.decode(readFd(t, rfd).data), 'through the pipe');
  // Drained: next read returns 0 bytes
  assert.equal(readFd(t, rfd).n, 0);
});

test('__host_dup: lowest free fd >= minfd, sharing the backing', () => {
  const t = makeShim();
  t.env.__host_pipe(0x10);
  const rfd = t.view().getUint32(0x10, true);
  const wfd = t.view().getUint32(0x14, true);
  const d = t.env.__host_dup(rfd, 10);
  assert.ok(d >= 10, `dup fd ${d} >= minfd 10`);
  writeFd(t, wfd, 'x');
  assert.equal(dec.decode(readFd(t, d).data), 'x', 'dup shares pipe backing');
  assert.equal(t.env.__host_dup(999, 4), -1, 'dup of a bad fd fails');
});

test('pipe buffers are released once no fd references the pipe', () => {
  const t = makeShim();
  t.env.__host_pipe(0x10);
  const rfd = t.view().getUint32(0x10, true);
  const wfd = t.view().getUint32(0x14, true);
  writeFd(t, wfd, 'data');
  t.p1.fd_close(wfd);
  assert.ok(t.shim.pipes[0], 'pipe survives while the read end is open');
  assert.equal(dec.decode(readFd(t, rfd).data), 'data', 'still readable after writer close');
  t.p1.fd_close(rfd);
  assert.equal(t.shim.pipes[0], null, 'pipe dropped when the last fd closes');
});

test('pipe reads drain consumed chunks (no unbounded retention)', () => {
  const t = makeShim();
  t.env.__host_pipe(0x10);
  const rfd = t.view().getUint32(0x10, true);
  const wfd = t.view().getUint32(0x14, true);
  for (let i = 0; i < 10; i++) {
    writeFd(t, wfd, `chunk${i};`);
    readFd(t, rfd);
  }
  assert.equal(t.shim.pipes[0].chunks.length, 0, 'consumed chunks are freed');
});

test('__host_dup2 replaces the target fd', () => {
  const t = makeShim({ files: { '/f.txt': 'abc' } });
  const fd = openPath(t, '/f.txt');
  const r = t.env.__host_dup2(fd, 9);
  assert.equal(r, 9);
  assert.equal(dec.decode(readFd(t, 9).data), 'abc');
  assert.equal(t.env.__host_dup2(999, 9), -1);
});

// ─── stdin semantics: EAGAIN vs blocking vs EOF ──────────────────────────────

function queueInput(chunks, { closed = false } = {}) {
  const q = chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : c));
  return {
    calls: { readBlocking: 0, wait: 0 },
    pollReadable(_ms) { return q.length > 0; },
    read(max) {
      if (!q.length) return new Uint8Array(0);
      const head = q[0];
      const take = head.subarray(0, max);
      if (take.length === head.length) q.shift(); else q[0] = head.subarray(max);
      return take;
    },
    readBlocking(max) { this.calls.readBlocking++; return this.read(max); },
    wait(_ms) { this.calls.wait++; },
    closed: () => closed && q.length === 0,
    _q: q,
  };
}

test('stdin fd_read: data present → delivered', () => {
  const t = makeShim({ input: queueInput(['key']) });
  const r = readFd(t, 0);
  assert.equal(r.errno, 0);
  assert.equal(dec.decode(r.data), 'key');
});

test('stdin fd_read: blocking with no data falls into readBlocking', () => {
  const input = queueInput([]);
  const t = makeShim({ input });
  const r = readFd(t, 0);
  assert.equal(input.calls.readBlocking, 1, 'blocking read parked');
  assert.equal(r.errno, 6 /* EAGAIN — nothing arrived */);
});

test('stdin fd_read: O_NONBLOCK (fdstat_set_flags bit 4) skips readBlocking → EAGAIN', () => {
  const input = queueInput([]);
  const t = makeShim({ input });
  t.p1.fd_fdstat_set_flags(0, 4);
  const r = readFd(t, 0);
  assert.equal(input.calls.readBlocking, 0, 'nonblock must not park');
  assert.equal(r.errno, 6);
  assert.equal(r.n, 0);
});

test('stdin fd_read: closed input → 0 bytes with SUCCESS (true EOF)', () => {
  const input = queueInput([], { closed: true });
  const t = makeShim({ input });
  const r = readFd(t, 0);
  assert.equal(r.errno, 0, 'EOF is success, not EAGAIN');
  assert.equal(r.n, 0);
});

test('stdin fd_read: buffered data drains before EOF applies', () => {
  const input = queueInput(['last'], { closed: true });
  const t = makeShim({ input });
  assert.equal(dec.decode(readFd(t, 0).data), 'last');
  const r = readFd(t, 0);
  assert.equal(r.errno, 0);
  assert.equal(r.n, 0);
});

// ─── poll_oneoff: the POC-bug-#1 regression pins ─────────────────────────────

// Lay out a subscription at `at`: userdata, tag, and payload.
function subClock(view, at, ud, timeoutNs) {
  view().setBigUint64(at, ud, true);
  view().setUint8(at + 8, 0); // tag: clock
  view().setBigUint64(at + 24, timeoutNs, true);
}
function subFdRead(view, at, ud, fd) {
  view().setBigUint64(at, ud, true);
  view().setUint8(at + 8, 1); // tag: fd_read
  view().setUint32(at + 16, fd, true);
}

test('poll_oneoff: clock-only subscription waits, then fires the clock event', () => {
  const input = queueInput([]);
  const t = makeShim({ input });
  subClock(t.view, 0x100, 42n, 5_000_000n /* 5ms */);
  const errno = t.p1.poll_oneoff(0x100, 0x300, 1, 0x400);
  assert.equal(errno, 0);
  assert.equal(t.view().getUint32(0x400, true), 1, 'one event');
  assert.equal(t.view().getBigUint64(0x300, true), 42n, 'userdata echoed');
  assert.equal(t.view().getUint8(0x300 + 10), 0, 'eventtype clock');
  assert.equal(input.calls.wait, 1, 'input.wait consulted for the timeout');
});

test('poll_oneoff: stdin readable → fd_read event, clock does NOT fire', () => {
  const t = makeShim({ input: queueInput(['x']) });
  subClock(t.view, 0x100, 1n, 1_000_000_000n);
  subFdRead(t.view, 0x130, 2n, 0);
  t.p1.poll_oneoff(0x100, 0x300, 2, 0x400);
  assert.equal(t.view().getUint32(0x400, true), 1);
  assert.equal(t.view().getBigUint64(0x300, true), 2n, 'stdin userdata echoed');
  assert.equal(t.view().getUint8(0x300 + 10), 1, 'eventtype fd_read');
});

test('poll_oneoff: stdin idle + clock → waits then clock event (read -t times out)', () => {
  const input = queueInput([]);
  const t = makeShim({ input });
  subClock(t.view, 0x100, 7n, 10_000_000n /* 10ms */);
  subFdRead(t.view, 0x130, 8n, 0);
  t.p1.poll_oneoff(0x100, 0x300, 2, 0x400);
  assert.equal(t.view().getUint32(0x400, true), 1);
  assert.equal(t.view().getBigUint64(0x300, true), 7n, 'clock userdata echoed');
  assert.equal(t.view().getUint8(0x300 + 10), 0, 'eventtype clock');
  // pollReadable(ms) IS the timed wait — a second input.wait would double
  // every read -t timeout (the 2× bug).
  assert.equal(input.calls.wait, 0, 'timeout must not be waited twice');
});

test('poll_oneoff: stdin + clock over a real ring waits ~timeout, not 2x', async () => {
  const { createStdinRing, RingReader } = await import('../src/ring.mjs');
  const t = makeShim({ input: new RingReader(createStdinRing(64)).toInput() });
  subClock(t.view, 0x100, 7n, 120_000_000n /* 120ms */);
  subFdRead(t.view, 0x130, 8n, 0);
  const t0 = Date.now();
  t.p1.poll_oneoff(0x100, 0x300, 2, 0x400);
  const elapsed = Date.now() - t0;
  assert.equal(t.view().getUint8(0x300 + 10), 0, 'eventtype clock');
  assert.ok(elapsed >= 100, `waited the timeout (${elapsed}ms)`);
  assert.ok(elapsed < 220, `did not wait twice (${elapsed}ms)`);
});

test('poll_oneoff: stdin blocking with no clock reports readable (caller then reads)', () => {
  const input = queueInput([]);
  const t = makeShim({ input });
  subFdRead(t.view, 0x100, 9n, 0);
  t.p1.poll_oneoff(0x100, 0x300, 1, 0x400);
  assert.equal(t.view().getUint32(0x400, true), 1);
  assert.equal(t.view().getUint8(0x300 + 10), 1, 'fd_read event');
});

test('poll_oneoff: closed stdin is READABLE (EOF wakes poll, not the timeout)', () => {
  const input = queueInput([], { closed: true });
  const t = makeShim({ input });
  subClock(t.view, 0x100, 7n, 1_000_000_000n);
  subFdRead(t.view, 0x130, 8n, 0);
  t.p1.poll_oneoff(0x100, 0x300, 2, 0x400);
  assert.equal(t.view().getUint32(0x400, true), 1);
  assert.equal(t.view().getBigUint64(0x300, true), 8n, 'stdin userdata echoed');
  assert.equal(t.view().getUint8(0x300 + 10), 1, 'eventtype fd_read');
});

test('poll_oneoff: non-stdin fds are always readable', () => {
  const t = makeShim({ files: { '/f.txt': 'x' } });
  const fd = openPath(t, '/f.txt');
  subFdRead(t.view, 0x100, 5n, fd);
  t.p1.poll_oneoff(0x100, 0x300, 1, 0x400);
  assert.equal(t.view().getUint32(0x400, true), 1);
  assert.equal(t.view().getBigUint64(0x300, true), 5n);
});

// ─── memory growth ───────────────────────────────────────────────────────────

test('views refresh after memory.grow', () => {
  const t = makeShim({ args: ['a'] });
  t.shim.mem.grow(1);
  // Any import touching memory must not throw on the detached old buffer.
  t.p1.args_sizes_get(0x10, 0x14);
  assert.equal(t.view().getUint32(0x10, true), 1);
});

// ---- terminal geometry host imports (winsize + synthesized winch) ----------

test('__host_winsize writes the input winsize as two u32s', () => {
  const t = makeShim({ input: { winsize: () => ({ rows: 40, cols: 100 }), takeWinch: () => false } });
  t.env.__host_winsize(0x100, 0x104);          // rowsPtr, colsPtr
  assert.equal(t.view().getUint32(0x100, true), 40);
  assert.equal(t.view().getUint32(0x104, true), 100);
});

test('__host_winsize reports 0/0 when input has no winsize (run() mode)', () => {
  const t = makeShim({ input: { pollReadable: () => false, read: () => new Uint8Array(0) } });
  t.view().setUint32(0x100, 0xdead, true);
  t.view().setUint32(0x104, 0xbeef, true);
  t.env.__host_winsize(0x100, 0x104);
  assert.equal(t.view().getUint32(0x100, true), 0);   // ioctl(TIOCGWINSZ) then returns ENOTTY
  assert.equal(t.view().getUint32(0x104, true), 0);
});

test('__host_winch returns 1 once per pending resize, then 0', () => {
  let pending = false;
  const t = makeShim({ input: { winsize: () => ({ rows: 0, cols: 0 }), takeWinch: () => { const p = pending; pending = false; return p; } } });
  assert.equal(t.env.__host_winch(), 0);
  pending = true;
  assert.equal(t.env.__host_winch(), 1);   // consumes it
  assert.equal(t.env.__host_winch(), 0);
});
