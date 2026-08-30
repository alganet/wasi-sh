// What moving the shim's VFS behind the `fs` contract changed, at the import
// level: an injected store, the device overlay that is no longer in the store,
// timestamps that are no longer zero, and the errno translation between the
// two numbering schemes. shim.test.mjs still pins everything that did NOT
// change, and passes unmodified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasiShim } from '../src/shim.mjs';
import { memoryFs, fsError } from '../src/fs.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeShim(opts = {}) {
  const shim = new WasiShim(opts);
  const memory = new WebAssembly.Memory({ initial: 1 });
  shim.bindMemory(memory);
  const imports = shim.imports();
  return { shim, p1: imports.wasi_snapshot_preview1, env: imports.env, view: () => new DataView(memory.buffer), bytes: () => new Uint8Array(memory.buffer) };
}

function putStr(t, at, s) { const b = enc.encode(s); t.bytes().set(b, at); return [at, b.length]; }

function openPath(t, path, expectErrno = 0, oflags = 0, fdflags = 0) {
  const [p, len] = putStr(t, 0x100, path);
  const errno = t.p1.path_open(3, 0, p, len, oflags, 0n, 0n, fdflags, 0x200);
  assert.equal(errno, expectErrno, `path_open(${path}) errno`);
  return expectErrno === 0 ? t.view().getUint32(0x200, true) : -1;
}

function readFd(t, fd, max = 256) {
  t.view().setUint32(0x300, 0x400, true);
  t.view().setUint32(0x304, max, true);
  const errno = t.p1.fd_read(fd, 0x300, 1, 0x308);
  const n = t.view().getUint32(0x308, true);
  return { errno, n, data: t.bytes().slice(0x400, 0x400 + n) };
}

function writeFd(t, fd, s) {
  const b = enc.encode(s);
  t.bytes().set(b, 0x500);
  t.view().setUint32(0x600, 0x500, true);
  t.view().setUint32(0x604, b.length, true);
  return { errno: t.p1.fd_write(fd, 0x600, 1, 0x608), n: t.view().getUint32(0x608, true) };
}

const pathOp = (t, op, path, ...rest) => { const [p, len] = putStr(t, 0x100, path); return t.p1[op](3, p, len, ...rest); };

// filestat layout: dev, ino, filetype, nlink, size, atim, mtim, ctim
function filestat(t, fd) {
  t.p1.fd_filestat_get(fd, 0xa00);
  const v = t.view();
  return {
    dev: v.getBigUint64(0xa00, true), ino: v.getBigUint64(0xa00 + 8, true),
    filetype: v.getUint8(0xa00 + 16), nlink: v.getBigUint64(0xa00 + 24, true),
    size: v.getBigUint64(0xa00 + 32, true),
    atim: v.getBigUint64(0xa00 + 40, true), mtim: v.getBigUint64(0xa00 + 48, true),
    ctim: v.getBigUint64(0xa00 + 56, true),
  };
}

// ─── an injected store ───────────────────────────────────────────────────────

test('a passed store backs the shell, and the shell backs onto it', () => {
  const store = memoryFs({ '/seed.txt': 'from the store' });
  const t = makeShim({ fs: store });
  assert.equal(dec.decode(readFd(t, openPath(t, '/seed.txt')).data), 'from the store');
  const fd = openPath(t, '/made.txt', 0, 1 /* CREAT */);
  writeFd(t, fd, 'from the guest');
  const back = new Uint8Array(store.statSync('/made.txt').size);
  store.readSync('/made.txt', back, 0, back.length);
  assert.equal(dec.decode(back), 'from the guest', 'the guest wrote into the caller`s store');
});

test('`files` are written into an injected store, and nothing else is', () => {
  const store = memoryFs();
  const before = store.readdirSync('/').slice().sort();
  makeShim({ fs: store, files: { '/deep/dir/f.txt': 'seeded' } });
  const buf = new Uint8Array(store.statSync('/deep/dir/f.txt').size);
  store.readSync('/deep/dir/f.txt', buf, 0, buf.length);
  assert.equal(dec.decode(buf), 'seeded', 'parents were created, content written');
  assert.deepEqual(store.readdirSync('/').sort(), [...before, 'deep'].sort(), 'no device nodes appeared');
  assert.throws(() => store.statSync('/dev'), { code: 'ENOENT' }, '/dev is the shim`s, not the store`s');
});

// A store is an interface, so wrap by delegation rather than by prototype —
// which is also the only way that works, since the methods are real methods.
function wrapStore(base, overrides) {
  const wrapper = {};
  for (const name of ['statSync', 'readdirSync', 'createFileSync', 'mkdirSync', 'rmdirSync',
    'unlinkSync', 'renameSync', 'linkSync', 'readSync', 'writeSync', 'touchSync', 'syncSync']) {
    wrapper[name] = (...args) => base[name](...args);
  }
  return Object.assign(wrapper, overrides);
}

test('a read-only store makes a read-only shell', () => {
  // The security property in one test: a store that refuses writes cannot be
  // talked around from the shell side, because there is no other side.
  const refuse = () => { throw fsError('EROFS', '/'); };
  const readOnly = wrapStore(memoryFs({ '/f.txt': 'immutable' }), {
    createFileSync: refuse, mkdirSync: refuse, writeSync: refuse,
    unlinkSync: refuse, rmdirSync: refuse, renameSync: refuse, touchSync: refuse,
  });
  const t = makeShim({ fs: readOnly });
  assert.equal(dec.decode(readFd(t, openPath(t, '/f.txt')).data), 'immutable', 'reads work');
  openPath(t, '/new.txt', 69 /* EROFS */, 1 /* CREAT */);
  assert.equal(pathOp(t, 'path_create_directory', '/d'), 69);
  assert.equal(pathOp(t, 'path_unlink_file', '/f.txt'), 69);
  const fd = openPath(t, '/f.txt');
  assert.equal(writeFd(t, fd, 'scribble').errno, 69, 'and a write through an open fd is refused too');
});

test('a store failure becomes an errno, never an exception through the guest', () => {
  // A JS exception thrown out of a wasm import unwinds the whole guest stack
  // and the instance is dead — the hazard host builtins are wrapped for.
  // A failure with no errno to its name is EIO, NOT ENOENT: "the store broke"
  // and "the file is not there" send the shell down very different paths.
  const broken = wrapStore(memoryFs({ '/f.txt': 'x' }), {
    statSync: () => { throw new TypeError('the store is confused'); },
  });
  const t = makeShim({ fs: broken });
  assert.doesNotThrow(() => openPath(t, '/f.txt', 29 /* EIO */));
  assert.equal(pathOp(t, 'path_unlink_file', '/f.txt'), 29);
});

test('a store that refuses a lookup says so, instead of reporting it missing', () => {
  const guarded = wrapStore(memoryFs({ '/secret.txt': 'x' }), {
    statSync: (path) => { throw fsError('EACCES', path); },
  });
  const t = makeShim({ fs: guarded });
  openPath(t, '/secret.txt', 2 /* WASI EACCES */);
  assert.equal(pathOp(t, 'path_unlink_file', '/secret.txt'), 2);
});

test('Linux errno from the store is translated to WASI numbering', () => {
  // The two schemes overlap and disagree: Linux EEXIST 17 is WASI ENOTSOCK,
  // and Linux ENOENT 2 is WASI EACCES — which is how the same confusion in the
  // other direction turned a missing file into "Permission denied" downstream.
  const t = makeShim();
  assert.equal(pathOp(t, 'path_create_directory', '/d'), 0);
  assert.equal(pathOp(t, 'path_create_directory', '/d'), 20, 'EEXIST is WASI 20, not Linux 17');
  assert.equal(pathOp(t, 'path_create_directory', '/no/parent'), 44, 'ENOENT is WASI 44, not Linux 2');
  const [p, len] = putStr(t, 0x100, '/d/f');
  t.p1.path_open(3, 0, p, len, 1, 0n, 0n, 0, 0x200);
  assert.equal(pathOp(t, 'path_remove_directory', '/d'), 55, 'ENOTEMPTY is WASI 55, not Linux 39');
});

// ─── the device overlay ──────────────────────────────────────────────────────

test('/dev is the shim`s overlay: listed at the root, not in the store', () => {
  const store = memoryFs({ '/f.txt': 'x' });
  const t = makeShim({ fs: store });
  const names = () => {
    const fd = openPath(t, '/');
    t.p1.fd_readdir(fd, 0x800, 512, 0n, 0x900);
    const written = t.view().getUint32(0x900, true);
    const out = [];
    for (let p = 0x800; p < 0x800 + written;) {
      const nlen = t.view().getUint32(p + 16, true);
      out.push(dec.decode(t.bytes().slice(p + 24, p + 24 + nlen)));
      p += 24 + nlen;
    }
    return out;
  };
  assert.ok(names().includes('dev'), 'ls / shows dev');
  assert.ok(names().includes('f.txt'), 'and the store`s own entries');
  const devFd = openPath(t, '/dev');
  t.p1.fd_readdir(devFd, 0x800, 256, 0n, 0x900);
  const nlen = t.view().getUint32(0x800 + 16, true);
  assert.equal(dec.decode(t.bytes().slice(0x800 + 24, 0x800 + 24 + nlen)), 'null', 'ls /dev shows null');
});

test('devices are on their own st_dev, so their inodes cannot collide', () => {
  const t = makeShim({ files: { '/f.txt': 'x' } });
  const devnull = filestat(t, openPath(t, '/dev/null'));
  const file = filestat(t, openPath(t, '/f.txt'));
  assert.equal(devnull.filetype, 2, 'CHAR');
  assert.notEqual(devnull.dev, file.dev, 'a device inode is never a store inode');
});

// The inode used to live in a hard-coded table beside the map `ls /dev`
// enumerates. A device registered in one and not the other listed but could
// never be opened — stat is where every path op begins — and nothing warned.
test('a registered device lists, stats and opens, all from one map', () => {
  const t = makeShim();
  t.shim.addDevice('/dev/probe', { read: () => enc.encode('probe'), write: () => {} });
  const devFd = openPath(t, '/dev');
  const names = [];
  for (let cookie = 0n; ; cookie++) {
    t.p1.fd_readdir(devFd, 0x800, 256, cookie, 0x900);
    if (t.view().getUint32(0x900, true) === 0) break;
    const nlen = t.view().getUint32(0x800 + 16, true);
    names.push(dec.decode(t.bytes().slice(0x800 + 24, 0x800 + 24 + nlen)));
  }
  assert.deepEqual(names, ['null', 'host', 'hostreq', 'probe'], 'ls /dev');
  const fd = openPath(t, '/dev/probe');
  assert.equal(dec.decode(readFd(t, fd).data), 'probe', 'and it is the device that answers');
  const probe = filestat(t, fd), devnull = filestat(t, openPath(t, '/dev/null'));
  assert.equal(probe.filetype, 2, 'CHAR');
  assert.notEqual(probe.ino, devnull.ino, 'every device gets its own inode');
});

test('addDevice refuses a name outside the namespace the overlay owns', () => {
  const t = makeShim();
  const dev = { read: () => new Uint8Array(0) };
  assert.throws(() => t.shim.addDevice('/tmp/nope', dev), /directly under \/dev/);
  // readdirAt('/dev') lists basenames, so a nested name would show up as `usb`
  // and stat as ENOENT at /dev/usb — the divergence one registration removes.
  assert.throws(() => t.shim.addDevice('/dev/bus/usb', dev), /directly under \/dev/);
  assert.throws(() => t.shim.addDevice('/dev/mute', {}), /neither read nor write/);
});

// {...dev} keeps own enumerable properties only, so a class-instance device
// would arrive with no methods and the first use would throw out of a wasm
// import — which unwinds the whole guest stack over a missing function.
test('a device may be a class instance, and a half-written one still refuses', () => {
  const t = makeShim();
  class Clock { constructor(text) { this.text = text; } read() { return enc.encode(this.text); } }
  t.shim.addDevice('/dev/clock', new Clock('tick'));
  assert.equal(dec.decode(readFd(t, openPath(t, '/dev/clock')).data), 'tick', 'methods survived registration');
  t.shim.addDevice('/dev/ro', { read: () => new Uint8Array(0) });
  assert.equal(writeFd(t, openPath(t, '/dev/ro'), 'x').errno, 63 /* EPERM */, 'no write means read-only, not a crash');
});

test('the guest cannot remove or rename the device overlay', () => {
  const t = makeShim();
  assert.equal(pathOp(t, 'path_unlink_file', '/dev/null'), 63 /* EPERM */);
  assert.equal(pathOp(t, 'path_remove_directory', '/dev'), 63);
  const [from, flen] = putStr(t, 0x100, '/dev/null');
  const [to, tlen] = putStr(t, 0x180, '/tmp/null');
  assert.equal(t.p1.path_rename(3, from, flen, 3, to, tlen), 63);
  assert.ok(openPath(t, '/dev/null') > 0, 'still there');
});

test('nothing can be created under /dev, where the overlay would hide it', () => {
  // Anything written to a /dev name lands in the store at a path `ls /dev`
  // will never show — so `mv work.txt /dev/null` would look like it worked
  // and quietly lose the file.
  const store = memoryFs();
  const t = makeShim({ fs: store, files: { '/work.txt': 'precious' } });
  openPath(t, '/dev/sneaky', 63 /* EPERM */, 1 /* CREAT */);
  assert.equal(pathOp(t, 'path_create_directory', '/dev/sub'), 63);
  const [from, flen] = putStr(t, 0x100, '/work.txt');
  const [to, tlen] = putStr(t, 0x180, '/dev/null');
  assert.equal(t.p1.path_rename(3, from, flen, 3, to, tlen), 63);
  assert.ok(store.statSync('/work.txt'), 'the file is still where it was');
  assert.throws(() => store.statSync('/dev'), { code: 'ENOENT' }, 'and nothing reached the store');
});

test('a store`s own /dev is shadowed whole, not entry by entry', () => {
  const store = memoryFs({ '/dev/decoy': 'not reachable' });
  const t = makeShim({ fs: store });
  openPath(t, '/dev/decoy', 44 /* NOENT */);
  assert.ok(openPath(t, '/dev/null') > 0, 'the overlay is what /dev means');
});

test('an open fd follows its file across a rename', () => {
  const t = makeShim({ files: { '/a/f.txt': 'payload' } });
  const fd = openPath(t, '/a/f.txt');
  const dirFd = openPath(t, '/a');
  const [from, flen] = putStr(t, 0x100, '/a');
  const [to, tlen] = putStr(t, 0x180, '/b');
  assert.equal(t.p1.path_rename(3, from, flen, 3, to, tlen), 0);
  assert.equal(dec.decode(readFd(t, fd).data), 'payload', 'the fd came along, subtree and all');
  writeFd(t, fd, '!');
  const reader = openPath(t, '/b/f.txt');
  assert.equal(dec.decode(readFd(t, reader).data), 'payload!', 'and writes still reach the file');
  t.p1.fd_readdir(dirFd, 0x800, 256, 0n, 0x900);
  assert.ok(t.view().getUint32(0x900, true) > 0, 'the directory fd followed too');
});

test('an unlinked-but-open file still stats as a regular file', () => {
  const t = makeShim({ files: { '/tmp/doomed': 'bytes' } });
  const fd = openPath(t, '/tmp/doomed');
  assert.equal(pathOp(t, 'path_unlink_file', '/tmp/doomed'), 0);
  const st = filestat(t, fd);
  assert.equal(st.filetype, 4, 'REG — a character device would fail every S_ISREG check');
  assert.equal(st.size, 5n);
  assert.equal(st.nlink, 0n, 'no names left');
});

test('two fds on one unlinked file keep one set of bytes', () => {
  const t = makeShim({ files: { '/tmp/doomed': 'ab' } });
  const fd = openPath(t, '/tmp/doomed');
  const dup = t.env.__host_dup(fd, 10);
  assert.equal(pathOp(t, 'path_unlink_file', '/tmp/doomed'), 0);
  writeFd(t, fd, 'XYZ');                    // grows the snapshot past its original size
  t.p1.fd_seek(dup, 0n, 0, 0x700);
  assert.equal(dec.decode(readFd(t, dup).data), 'XYZ', 'the dup sees it, not a stale copy');
});

test('a partial write reports the bytes that landed, not an errno', () => {
  // WASI has one result: an errno means the whole call failed and wasi-libc
  // returns -1, so a retry would write the landed bytes a second time.
  let calls = 0;
  const store = wrapStore(memoryFs({ '/f.txt': '' }), {
    writeSync: (path, buffer, offset) => { if (++calls > 1) throw fsError('ENOSPC', path); },
  });
  const t = makeShim({ fs: store });
  const fd = openPath(t, '/f.txt');
  const first = enc.encode('aaaa'), second = enc.encode('bbbb');
  t.bytes().set(first, 0x500); t.bytes().set(second, 0x520);
  t.view().setUint32(0x600, 0x500, true); t.view().setUint32(0x604, first.length, true);
  t.view().setUint32(0x608, 0x520, true); t.view().setUint32(0x60c, second.length, true);
  const errno = t.p1.fd_write(fd, 0x600, 2, 0x700);
  assert.equal(errno, 0, 'short write is success');
  assert.equal(t.view().getUint32(0x700, true), 4, 'only the first iovec landed');
});

test('a failed hostFs write leaves the old contents alone', () => {
  const store = wrapStore(memoryFs({ '/f.txt': 'original' }), {
    writeSync: () => { throw fsError('EROFS', '/f.txt'); },
  });
  const t = makeShim({ fs: store });
  const hostFs = t.shim.hostFs('/');
  assert.equal(hostFs.write('/f.txt', 'replacement'), false);
  assert.equal(dec.decode(hostFs.read('/f.txt')), 'original', 'not truncated on the way out');
});

// ─── timestamps ──────────────────────────────────────────────────────────────

test('filestat reports real times, and a write moves mtime', async () => {
  // Zero mtimes are invisible until something caches by them: an opcode cache
  // with validate_timestamps never reloads a file whose mtime never moves, so
  // an edit in the shell is simply not there when the page reloads.
  const t = makeShim();
  const fd = openPath(t, '/tmp/f.txt', 0, 1 /* CREAT */);
  const born = filestat(t, fd);
  assert.ok(born.mtim > 0n, 'not the epoch');
  assert.ok(born.mtim > 1_600_000_000_000_000_000n, 'nanoseconds, not milliseconds');
  await new Promise((r) => setTimeout(r, 2));
  writeFd(t, fd, 'changed');
  assert.ok(filestat(t, fd).mtim > born.mtim, 'a write moves mtime');
});

test('path_filestat_set_times sets what its flags ask for (touch)', () => {
  const t = makeShim({ files: { '/f.txt': 'x' } });
  const fd = openPath(t, '/f.txt');
  const [p, len] = putStr(t, 0x100, '/f.txt');
  // fstflags 1|4 = set atim and mtim from the arguments, in nanoseconds.
  assert.equal(t.p1.path_filestat_set_times(3, 0, p, len, 7_000_000n, 9_000_000n, 1 | 4), 0);
  const st = filestat(t, fd);
  assert.equal(st.atim, 7_000_000n);
  assert.equal(st.mtim, 9_000_000n);
  // 2|8 = "now" for both, which is what plain `touch` sends.
  assert.equal(t.p1.path_filestat_set_times(3, 0, p, len, 0n, 0n, 2 | 8), 0);
  assert.ok(filestat(t, fd).mtim > 9_000_000n, 'touch moved it to now');
  const [missing, mlen] = putStr(t, 0x100, '/absent');
  assert.equal(t.p1.path_filestat_set_times(3, 0, missing, mlen, 0n, 0n, 8), 44);
});

// ─── open file descriptions ──────────────────────────────────────────────────

test('a file unlinked while open stays readable through the open fd', () => {
  // The store is path-addressed and forgets a file the moment its name goes,
  // so the bytes travel with the fd. POSIX programs expect this; the old
  // node-reference FS gave it away for free.
  const t = makeShim({ files: { '/tmp/doomed': 'still here' } });
  const fd = openPath(t, '/tmp/doomed');
  assert.equal(pathOp(t, 'path_unlink_file', '/tmp/doomed'), 0);
  assert.equal(openPath(t, '/tmp/doomed', 44), -1, 'the name is gone');
  assert.equal(dec.decode(readFd(t, fd).data), 'still here', 'the open fd still reads');
});

test('a duped fd shares one offset with its source (one open description)', () => {
  const t = makeShim({ files: { '/f.txt': 'abcdefgh' } });
  const fd = openPath(t, '/f.txt');
  const dup = t.env.__host_dup(fd, 10);
  assert.equal(dec.decode(readFd(t, fd, 4).data), 'abcd');
  assert.equal(dec.decode(readFd(t, dup, 4).data), 'efgh', 'the dup continues where the source stopped');
});

test('a plain write does not stat, and O_APPEND is the only reason to', () => {
  // Only "the end as it is NOW" needs the size. Writing used to ask the store
  // for it regardless — per iovec, so a two-iovec writev cost two — which on a
  // persistent store is a real round trip per write, and one more call whose
  // failure fails a write that would have landed.
  const base = memoryFs({ '/f.txt': 'a\n' });
  let stats = 0, hiccup = false;
  const counted = wrapStore(base, {
    statSync: (path) => { stats++; if (hiccup) throw fsError('EIO', path); return base.statSync(path); },
  });
  const t = makeShim({ fs: counted });
  const plain = openPath(t, '/f.txt');
  const appender = openPath(t, '/f.txt', 0, 0, 1 /* APPEND */);
  stats = 0;
  writeFd(t, plain, 'XX');
  assert.equal(stats, 0, 'a plain write asks the store nothing but the write');
  writeFd(t, appender, 'b\n');
  assert.equal(stats, 1, 'an appending write still reads the size, once');
  // And a stat that merely hiccups no longer fails a write that would have
  // landed — there is no longer a second call for it to fail in.
  hiccup = true;
  assert.deepEqual(writeFd(t, plain, 'YY'), { errno: 0, n: 2 });
});

test('a write to a file the store lost is ENOENT, not a silent success', () => {
  // With the stat gone, the store's own ENOENT IS the existence check. Nothing
  // in the shell can remove a file behind an open fd — that path snapshots the
  // bytes instead — but a shared or host-backed store has another writer, and
  // the answer must still be the errno rather than a write into nowhere.
  const base = memoryFs({ '/f.txt': 'orig' });
  const t = makeShim({ fs: base });
  const fd = openPath(t, '/f.txt');
  base.unlinkSync('/f.txt');                 // underneath the shim, as a second writer would
  assert.deepEqual(writeFd(t, fd, 'NEW!'), { errno: 44 /* ENOENT */, n: 0 });
});

test('O_APPEND writes land at the end even when another fd grew the file', () => {
  // "The end" means the end as it is NOW, so the size has to be read at write
  // time. A cached one would put these two bytes at offset 2 and overwrite.
  const t = makeShim({ files: { '/log.txt': 'a\n' } });
  const appender = openPath(t, '/log.txt', 0, 0, 1 /* APPEND */);
  const other = openPath(t, '/log.txt');
  writeFd(t, other, 'XXXX');                // grows it from 2 to 4 behind the appender
  writeFd(t, appender, 'b\n');
  const reader = openPath(t, '/log.txt');
  assert.equal(dec.decode(readFd(t, reader).data), 'XXXXb\n');
});

// ─── failures must not half-commit ───────────────────────────────────────────

test('an unlink the store refuses leaves open fds attached to the real file', () => {
  // Snapshotting is what makes unlink-while-open work, but taking the snapshot
  // before the removal is committed would leave live fds writing into a
  // phantom and reporting success.
  const base = memoryFs({ '/f.txt': 'orig' });
  const store = wrapStore(base, { unlinkSync: (path) => { throw fsError('EROFS', path); } });
  const t = makeShim({ fs: store });
  const fd = openPath(t, '/f.txt');
  assert.equal(pathOp(t, 'path_unlink_file', '/f.txt'), 69 /* EROFS */);
  writeFd(t, fd, 'NEW!');
  const out = new Uint8Array(base.statSync('/f.txt').size);
  base.readSync('/f.txt', out, 0, out.length);
  assert.equal(dec.decode(out), 'NEW!', 'the write reached the file, not a phantom');
});

test('an fd open on a rename destination keeps reading its own file', () => {
  // `exec 3</tmp/b; mv /tmp/a /tmp/b` unlinks b. fd 3 must not silently
  // start reading a.
  const t = makeShim({ files: { '/tmp/a': 'AAA', '/tmp/b': 'BBB' } });
  const fd = openPath(t, '/tmp/b');
  const [from, flen] = putStr(t, 0x100, '/tmp/a');
  const [to, tlen] = putStr(t, 0x180, '/tmp/b');
  assert.equal(t.p1.path_rename(3, from, flen, 3, to, tlen), 0);
  assert.equal(dec.decode(readFd(t, fd).data), 'BBB', 'still the file it opened');
  assert.equal(dec.decode(readFd(t, openPath(t, '/tmp/b')).data), 'AAA', 'the name is the new file');
});

test('an fd whose name was reused still describes the file it reads', () => {
  const t = makeShim({ files: { '/tmp/f': 'snapshot' } });
  const fd = openPath(t, '/tmp/f');
  assert.equal(pathOp(t, 'path_unlink_file', '/tmp/f'), 0);
  const fresh = openPath(t, '/tmp/f', 0, 1 /* CREAT */);
  writeFd(t, fresh, 'new');
  assert.equal(filestat(t, fd).size, 8n, 'size of what this fd reads, not of the new file');
  assert.equal(dec.decode(readFd(t, fd).data), 'snapshot');
});

test('seeking before the start is EINVAL, not a well of zeroes', () => {
  // An unchecked negative offset makes every later read ask the store for a
  // range it zero-fills, and the guest gets fabricated NULs as real content.
  const t = makeShim({ files: { '/f.txt': 'abc' } });
  const fd = openPath(t, '/f.txt');
  assert.equal(t.p1.fd_seek(fd, -10n, 0, 0x700), 28 /* EINVAL */);
  assert.equal(dec.decode(readFd(t, fd).data), 'abc', 'the offset did not move');
  assert.equal(t.p1.fd_seek(fd, -1n, 1, 0x700), 0, 'a valid relative seek still works');
  assert.equal(dec.decode(readFd(t, fd).data), 'c');
});

test('an unseekable fd says ESPIPE instead of moving an offset nobody reads', () => {
  // fd_seek used to move the pos cell of ANY fd and report success. A pipe
  // keeps its offset on the pipe object and the stdin ring has none, so the
  // move was invisible — but the SUCCESS is a lie a caller acts on: lseek() is
  // how a program asks "can I seek this?", and stdio calls it when it drops a
  // buffered read (see the applet drain in build/ash-forkfree.patch).
  const t = makeShim({ files: { '/f.txt': 'abc' } });
  t.env.__host_pipe(0x800);
  const rd = t.view().getUint32(0x800, true), wr = t.view().getUint32(0x804, true);
  assert.equal(t.p1.fd_seek(rd, 0n, 1, 0x700), 70 /* ESPIPE */);
  assert.equal(t.p1.fd_seek(wr, 0n, 1, 0x700), 70 /* ESPIPE */);
  for (const fd of [0, 1, 2]) assert.equal(t.p1.fd_seek(fd, 0n, 1, 0x700), 70, `fd ${fd}`);
  // A file redirected onto fd 0 is a file, not the ring: `head -1 < f` has to
  // keep seeking, which is what dup2 copying the record already gives it.
  const fd = openPath(t, '/f.txt');
  assert.equal(t.env.__host_dup2(fd, 0), 0);
  assert.equal(t.p1.fd_seek(0, 1n, 0, 0x700), 0, 'a file on fd 0 still seeks');
  assert.equal(dec.decode(readFd(t, 0).data), 'bc');
});

test('a file mounted under /dev is refused instead of hidden', () => {
  assert.throws(() => makeShim({ files: { '/dev/tty': 'x' } }), /under \/dev/);
  assert.throws(() => makeShim({ fs: memoryFs(), files: { '/dev/tty': 'x' } }), /under \/dev/);
});

test('the store is flushed when the guest exits', () => {
  let flushes = 0;
  const store = wrapStore(memoryFs(), { syncSync: () => { flushes++; } });
  const t = makeShim({ fs: store });
  assert.throws(() => t.p1.proc_exit(0), (e) => e.code === 0);
  assert.equal(flushes, 1, 'a persistent store has no other point to learn the run ended');
});

test('a failing flush is reported rather than swallowed', () => {
  let err = '';
  const store = wrapStore(memoryFs(), { syncSync: () => { throw new Error('disk gone'); } });
  const t = makeShim({ fs: store, stderr: (b) => { err += dec.decode(b); } });
  assert.throws(() => t.p1.proc_exit(3), (e) => e.code === 3, 'the exit still happens');
  assert.match(err, /flushing the filesystem failed: disk gone/);
});

test('a store that fails mid-read reports it instead of ending the file', () => {
  // The read path stats to learn the size, and a failed stat is not an empty
  // file. Reading it as EOF makes `cat`/`$(...)` stop at whatever they had and
  // exit 0 — a truncation the shell has no way to notice. The open must
  // succeed first, so the failure has to arrive with the fd already in hand.
  const base = memoryFs({ '/f.txt': 'abcdef' });
  let opened = false;
  const flaky = wrapStore(base, {
    statSync: (path) => { if (opened) throw fsError('EIO', path); return base.statSync(path); },
  });
  const t = makeShim({ fs: flaky });
  const fd = openPath(t, '/f.txt');
  opened = true;
  assert.equal(readFd(t, fd).errno, 29 /* EIO */, 'the read fails loudly');
});

test('a store failure under a rename target is not reported as ENOENT', () => {
  // `mv a b` stats b's parent to check it is a directory. A store that fails
  // that lookup used to answer "no such file or directory", which describes a
  // store that is merely unreachable as one that is definitely empty.
  const base = memoryFs({ '/a.txt': 'x' });
  const guarded = wrapStore(base, {
    statSync: (path) => { if (path === '/locked') throw fsError('EACCES', path); return base.statSync(path); },
  });
  const t = makeShim({ fs: guarded });
  const [pf, lf] = putStr(t, 0x100, '/a.txt');
  const [pt, lt] = putStr(t, 0x180, '/locked/b.txt');
  assert.equal(t.p1.path_rename(3, pf, lf, 3, pt, lt), 2 /* WASI EACCES */);
});

test('renaming into a non-directory is ENOTDIR, not ENOENT', () => {
  const t = makeShim({ files: { '/a.txt': 'x', '/file': 'y' } });
  const [pf, lf] = putStr(t, 0x100, '/a.txt');
  const [pt, lt] = putStr(t, 0x180, '/file/b.txt');
  assert.equal(t.p1.path_rename(3, pf, lf, 3, pt, lt), 54 /* ENOTDIR */);
});

test('utimes on a store that fails the lookup keeps the store`s reason', () => {
  const guarded = wrapStore(memoryFs({ '/f.txt': 'x' }), {
    statSync: (path) => { throw fsError('EACCES', path); },
  });
  const t = makeShim({ fs: guarded });
  const [p_, l_] = putStr(t, 0x100, '/f.txt');
  assert.equal(t.p1.path_filestat_set_times(3, 0, p_, l_, 0n, 0n, 4), 2 /* EACCES */);
});

test('a host builtin sees null from fs.list(), not an exception', () => {
  // Every other ctx.fs method answers a broken store with null/false; list()
  // reached readdirSync unguarded, so a failure there unwound the guest.
  const base = memoryFs({ '/d/f': 'x' });
  const broken = wrapStore(base, { readdirSync: () => { throw fsError('EIO', '/d'); } });
  const t = makeShim({ fs: broken });
  const fs = t.shim.hostFs('/');
  assert.equal(fs.list('/d'), null);
  assert.equal(fs.list('/nope'), null, 'and a missing path is still null');
});

// ─── what a creation tells the store ─────────────────────────────────────────
//
// The contract's shape is ZenFS's, and ZenFS makes uid, gid and mode REQUIRED
// at creation — so `{}` is not "take your defaults", it is a mode of zero.
// `memoryFs` supplies one when the caller names none, which is why passing
// `{}` was invisible for as long as the built-in store was the only store.
//
// It stops being invisible the moment the contract does its job: a second
// guest sharing the store finds a tree with no permission bits on anything.
// busybox does not care — it is alone in there and the shim enforces nothing —
// but PHP mounted over the same store stats the shell's own script, gets
// EACCES, and reports it as a 404 for a file that is right there.
//
// So these assert what the shim SAYS, against a store that records exactly
// what it is handed. Against memoryFs they pass either way.

/** A store that keeps the mode it was given, zero included, and logs the ask. */
function literalStore(files) {
  const base = memoryFs(files);
  const created = [];
  const keep = (path, options) => {
    created.push([path, options]);
    base.touchSync(path, { mode: (options && options.mode) || 0 });
  };
  const store = wrapStore(base, {
    createFileSync(path, options) { const n = base.createFileSync(path, options); keep(path, options); return n; },
    mkdirSync(path, options) { const n = base.mkdirSync(path, options); keep(path, options); return n; },
  });
  store.created = created;
  return store;
}

const permsOf = (store, path) => store.statSync(path).mode & 0o7777;

test('a file the guest creates is created readable', () => {
  const store = literalStore({});
  const t = makeShim({ fs: store });
  openPath(t, '/new.txt', 0, 1 /* O_CREAT */);
  assert.equal(permsOf(store, '/new.txt'), 0o644);
});

test('a directory the guest creates is created traversable', () => {
  const store = literalStore({});
  const t = makeShim({ fs: store });
  assert.equal(pathOp(t, 'path_create_directory', '/d'), 0);
  assert.equal(permsOf(store, '/d'), 0o755);
});

test('a builtin writing a new path through ctx.fs creates it readable', () => {
  const store = literalStore({});
  const t = makeShim({ fs: store });
  assert.equal(t.shim.hostFs('/').write('/from-builtin.txt', 'x'), true);
  assert.equal(permsOf(store, '/from-builtin.txt'), 0o644);
});

test('seeded files and the directories under them are created too', () => {
  const store = literalStore({});
  makeShim({ fs: store, files: { '/srv/app/index.php': '<?php' } });
  assert.equal(permsOf(store, '/srv'), 0o755);
  assert.equal(permsOf(store, '/srv/app'), 0o755);
  assert.equal(permsOf(store, '/srv/app/index.php'), 0o644);
});

test('every creation names uid and gid, which ZenFS also requires', () => {
  const store = literalStore({});
  const t = makeShim({ fs: store, files: { '/d/seeded': 'x' } });
  openPath(t, '/new.txt', 0, 1);
  assert.equal(pathOp(t, 'path_create_directory', '/made'), 0);
  assert.ok(store.created.length >= 4, `only ${store.created.length} creations`);
  for (const [path, options] of store.created) {
    assert.equal(typeof options, 'object', `${path}: no options at all`);
    assert.equal(options.uid, 0, `${path}: uid`);
    assert.equal(options.gid, 0, `${path}: gid`);
  }
});
