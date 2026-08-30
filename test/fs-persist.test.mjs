// persistentFs — the seam between a synchronous session and a backend that
// outlives the tab.
//
// The double below is not a mock of an interface: it is `Async(IndexFS)` with
// an InMemory cache, which is exactly what `@zenfs/dom`'s `WebAccessFS` is,
// over a Map instead of over OPFS. So these cases drive the real hydrate-and-
// flush machinery — the queue, the cache, the recursion guard — in node, where
// there is no OPFS to drive it against.
//
// The browser half is measured rather than asserted, because nothing in node
// has a FileSystemDirectoryHandle: 2,000 files / 15 MB in Chromium hydrate in
// ~500 ms and the same conformance cases pass with the four deviations
// @zenfs/core's InMemory already has, and no others. Recorded in MOAR.md §4.3.
//
// A DEV DEPENDENCY ONLY, like fs-zenfs.test.mjs: `npm i wasi-sh` must keep
// installing exactly one thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistentFs } from '../src/fs.mjs';
import { conformanceCases } from '../src/fs-conformance.mjs';

let zenfs = null;
try {
  zenfs = await import('@zenfs/core');
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * A backend shaped like WebAccessFS: asynchronous underneath, a Map for the
 * bytes, and a lever to make one write-back fail.
 */
function makeBacking(core, seed = {}) {
  const bytes = new Map([['/', null]]);
  class MapBacking extends core.Async(core.IndexFS) {
    _sync = core.InMemory.create({ label: 'persist-cache' });
    failOn = null;
    constructor() { super(0x6d617062, 'mapbacking'); }
    async _load() {
      for (const [path, data] of bytes) {
        this.index.set(path, new core.Inode(data === null
          ? { mode: 0o755 | core.constants.S_IFDIR, size: 0 }
          : { mode: 0o644 | core.constants.S_IFREG, size: data.length, mtimeMs: Date.now() }));
      }
    }
    async stat(path) { return super.stat(path); }
    async readdir(path) { return super.readdir(path); }
    async read(path, buffer, offset, end) {
      const data = bytes.get(path);
      if (data == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', errno: 2 });
      buffer.set(data.subarray(offset, end));
    }
    async write(path, buffer, offset) {
      if (this.failOn === path) throw Object.assign(new Error('quota exceeded'), { code: 'ENOSPC', errno: 28, path });
      const old = bytes.get(path) || new Uint8Array(0);
      const next = new Uint8Array(Math.max(old.length, offset + buffer.length));
      next.set(old); next.set(buffer, offset);
      bytes.set(path, next);
    }
    async remove(path) { bytes.delete(path); }
    removeSync() { /* the cache does the synchronous half */ }
    async _mkdir(path) { bytes.set(path, null); }
  }
  for (const [path, text] of Object.entries(seed)) {
    const parts = path.split('/').slice(1, -1);
    let dir = '';
    for (const p of parts) { dir += '/' + p; if (!bytes.has(dir)) bytes.set(dir, null); }
    bytes.set(path, ENC.encode(text));
  }
  return { bytes, make: async () => { const fs = new MapBacking(); await fs._load(); return fs; } };
}

const readAll = (fs, path) => {
  const { size } = fs.statSync(path);
  const buf = new Uint8Array(size);
  if (size) fs.readSync(path, buf, 0, size);
  return DEC.decode(buf);
};

const NEW_FILE = { mode: 0o644, uid: 0, gid: 0 };
const NEW_DIR = { mode: 0o755, uid: 0, gid: 0 };

if (!zenfs) {
  test('persistentFs against an async backend', { skip: '@zenfs/core is not installed' }, () => {});
} else {
  test('refuses something that is not a store, naming what is missing', async () => {
    await assert.rejects(() => persistentFs(null), /expected a store, got null/);
    await assert.rejects(() => persistentFs({ statSync() {} }), /missing readdirSync, createFileSync/);
  });

  // The one that makes this adapter exist. WebAccess.create() loads the index
  // and not the cache, so a store handed over un-hydrated answers ENOENT for
  // every file that is really there — and the shell then writes over it.
  test('hydrates, so a file already in the store is one the session can read', async () => {
    const { make } = makeBacking(zenfs, { '/srv/index.php': '<?php echo "seeded";' });
    const raw = await make();
    assert.throws(() => raw.statSync('/srv/index.php'), { code: 'ENOENT' }, 'un-hydrated, the cache is empty');
    const store = await persistentFs(raw);
    assert.equal(readAll(store, '/srv/index.php'), '<?php echo "seeded";');
  });

  test('returns the same object, so a second guest sees the class it was handed', async () => {
    const { make } = makeBacking(zenfs);
    const raw = await make();
    const store = await persistentFs(raw);
    assert.equal(store, raw);
    assert.ok(store instanceof zenfs.FileSystem);
    assert.equal(typeof store.flush, 'function');
  });

  test('a write reaches the backing store, and flush() is when it is known to', async () => {
    const { bytes, make } = makeBacking(zenfs);
    const store = await persistentFs(await make());
    store.mkdirSync('/srv', NEW_DIR);
    store.createFileSync('/srv/index.php', NEW_FILE);
    store.writeSync('/srv/index.php', ENC.encode('<?php echo "edited";'), 0);
    await store.flush();
    assert.equal(DEC.decode(bytes.get('/srv/index.php')), '<?php echo "edited";');
  });

  test('a store outlives the session that filled it', async () => {
    const backing = makeBacking(zenfs);
    const first = await persistentFs(await backing.make());
    first.mkdirSync('/srv', NEW_DIR);
    first.createFileSync('/srv/a.php', NEW_FILE);
    first.writeSync('/srv/a.php', ENC.encode('one'), 0);
    await first.flush();

    const second = await persistentFs(await backing.make());
    assert.equal(readAll(second, '/srv/a.php'), 'one');
    assert.deepEqual(second.readdirSync('/srv'), ['a.php']);
  });

  // The failure the mixin drops on the floor: `sync()` awaits the queue with
  // `.catch(() => {})`, so a full quota is invisible — the guest's write
  // returned and the bytes are nowhere.
  test('a write-back that fails is reported, not dropped', async () => {
    const { make } = makeBacking(zenfs);
    const raw = await make();
    const seen = [];
    const store = await persistentFs(raw, { onError: (err) => seen.push(err) });
    store.mkdirSync('/srv', NEW_DIR);
    store.createFileSync('/srv/big.php', NEW_FILE);
    raw.failOn = '/srv/big.php';
    store.writeSync('/srv/big.php', ENC.encode('too much'), 0);
    await assert.rejects(() => store.flush(), /did not reach the store \(\/srv\/big\.php\): quota exceeded/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].code, 'ENOSPC');
  });

  // The shim calls syncSync() at every proc_exit and reports a throw as data
  // loss on stderr. It cannot wait for the backing store, so what it reports is
  // what has already failed — and reporting it CLEARS it, or the next real
  // failure arrives buried under a stale one.
  test('syncSync raises a failure the shim can report, once', async () => {
    const { make } = makeBacking(zenfs);
    const raw = await make();
    const store = await persistentFs(raw);
    store.mkdirSync('/srv', NEW_DIR);
    store.createFileSync('/srv/x.php', NEW_FILE);
    raw.failOn = '/srv/x.php';
    store.writeSync('/srv/x.php', ENC.encode('nope'), 0);
    await store.sync();
    assert.throws(() => store.syncSync(), /did not reach the store/);
    assert.doesNotThrow(() => store.syncSync());
  });

  test('an onError that throws does not take the queue with it', async () => {
    const { make } = makeBacking(zenfs);
    const raw = await make();
    const store = await persistentFs(raw, { onError: () => { throw new Error('reporter is broken'); } });
    store.mkdirSync('/srv', NEW_DIR);
    store.createFileSync('/srv/x.php', NEW_FILE);
    raw.failOn = '/srv/x.php';
    store.writeSync('/srv/x.php', ENC.encode('nope'), 0);
    await assert.rejects(() => store.flush(), /did not reach the store/);
    store.createFileSync('/srv/y.php', NEW_FILE);
    store.writeSync('/srv/y.php', ENC.encode('fine'), 0);
    await store.flush();
    assert.equal(readAll(store, '/srv/y.php'), 'fine');
  });

  test('preparing one store twice does not double-report', async () => {
    const { make } = makeBacking(zenfs);
    const raw = await make();
    const seen = [];
    const store = await persistentFs(raw, { onError: (err) => seen.push(err) });
    assert.equal(await persistentFs(store, { onError: (err) => seen.push(err) }), store);
    store.mkdirSync('/srv', NEW_DIR);
    store.createFileSync('/srv/x.php', NEW_FILE);
    raw.failOn = '/srv/x.php';
    store.writeSync('/srv/x.php', ENC.encode('nope'), 0);
    await store.flush().catch(() => {});
    assert.equal(seen.length, 1);
  });

  // Whatever the adapter does to the write-back must leave the mixin's own
  // cache bookkeeping alone — it detects its recursion by reading the call
  // stack, and an unnamed wrapper in the middle of that is how a marker starts
  // matching something it was never meant to.
  test('the cache still agrees with the store after an async-side write', async () => {
    const { make } = makeBacking(zenfs);
    const store = await persistentFs(await make());
    await store.mkdir('/srv', NEW_DIR);
    await store.createFile('/srv/async.php', NEW_FILE);
    await store.write('/srv/async.php', ENC.encode('from the async half'), 0);
    await store.flush();
    assert.equal(readAll(store, '/srv/async.php'), 'from the async half');
  });

  // Same claim fs-zenfs.test.mjs makes about InMemory, one layer out: the
  // deviations are the backend's, and preparing it adds none.
  const KNOWN_DEVIATIONS = new Map([
    ['touchSync truncates, both shorter and longer', 'upstream: the cache truncate is metadata-only (@zenfs/core 2.6.3)'],
    ['directories refuse file operations', 'upstream: writes bytes into the directory index (@zenfs/core 2.6.3)'],
    ['readdirSync lists entry names, and a file is not a directory', 'upstream: readdir of a file throws SyntaxError, not ENOTDIR (@zenfs/core 2.6.3)'],
    ['touchSync changes permission bits and leaves the type alone', 'upstream: touchSync replaces the whole mode, clearing S_IFREG (@zenfs/core 2.6.3)'],
  ]);
  const { make } = makeBacking(zenfs);
  const prepared = await persistentFs(await make());
  conformanceCases().forEach((testCase, index) => {
    const todo = KNOWN_DEVIATIONS.get(testCase.name);
    test(`persistentFs conformance: ${testCase.name}`, todo ? { todo } : {}, () => {
      testCase.run(prepared, `/conformance-${index}`);
    });
  });
}
