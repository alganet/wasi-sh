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
import { makeBacking } from './backing.mjs';

let zenfs = null;
try {
  zenfs = await import('@zenfs/core');
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

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

  // An EMPTY file is the one thing an index-backed async store does not
  // persist by itself: `IndexFS.mkdir` calls a `_mkdir` hook and
  // `IndexFS.createFile` calls nothing, so a directory reaches the backend and
  // a file that is never written reaches the index and stops there. In a
  // browser that is `touch a`, reload, and `a` is gone. ZENFS.md finding 10.
  test('an empty file reaches the backing store, not only the index', async () => {
    const { bytes, make } = makeBacking(zenfs);
    const store = await persistentFs(await make());
    store.createFileSync('/empty.txt', NEW_FILE);
    await store.flush();
    assert.ok(bytes.has('/empty.txt'), 'the backend never heard of the file');
    assert.equal(bytes.get('/empty.txt').length, 0);
  });

  // And the same divergence the other way round: the backend is asked to
  // remove a name it never had, which is a NotFoundError from OPFS and a
  // latched failure here — one that stops every later write of the session.
  test('a file created and removed again does not fail the write-back', async () => {
    const { bytes, make } = makeBacking(zenfs);
    const store = await persistentFs(await make());
    store.createFileSync('/scratch.txt', NEW_FILE);
    store.unlinkSync('/scratch.txt');
    await store.flush();
    assert.ok(!bytes.has('/scratch.txt'));
    // The store must still work: a latched failure is raised at the next
    // flush point, so this is where "poisoned for the rest of the session"
    // would show up.
    store.createFileSync('/after.txt', NEW_FILE);
    store.writeSync('/after.txt', ENC.encode('still working'), 0);
    await store.flush();
    assert.equal(DEC.decode(bytes.get('/after.txt')), 'still working');
  });

  // `IndexFS.rename` removes the source, so it fails on a hollow file for the
  // same reason unlink does.
  test('an empty file can be renamed, which the backend removes to do', async () => {
    const { bytes, make } = makeBacking(zenfs);
    const store = await persistentFs(await make());
    store.createFileSync('/from.txt', NEW_FILE);
    store.renameSync('/from.txt', '/to.txt');
    await store.flush();
    assert.ok(bytes.has('/to.txt') && !bytes.has('/from.txt'));
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

  // Firefox, and it was every write. `@zenfs/core`'s Async mixin re-applies a
  // completed async op to its sync cache unless it recognises the call as its
  // own, and it recognises it by string-matching a V8 stack trace
  // (`at <computed> [as write]`). SpiderMonkey writes frames as `name@url`, so
  // the guard never fires there: the op is applied twice and `createFile`
  // throws EEXIST against what it just made, decorated with ' (Out of sync!)'.
  //
  // It is not a write failure — the wrapper awaits the real write BEFORE it
  // touches the cache — so passing it on latches a phantom that stops the
  // session at its next write. Simulated here rather than waiting for a
  // browser, because node is V8 and would never produce it.
  test('a cache re-apply upstream cannot guard against is not a write failure', async () => {
    const { make, bytes } = makeBacking(zenfs);
    const raw = await make();
    const seen = [];
    const store = await persistentFs(raw, { onError: (err) => seen.push(err) });
    store.mkdirSync('/srv', NEW_DIR);
    store.createFileSync('/srv/a.php', NEW_FILE);
    store.writeSync('/srv/a.php', ENC.encode('written'), 0);
    await store.flush();
    assert.equal(DEC.decode(bytes.get('/srv/a.php')), 'written', 'the real write lands first — that is the point');

    // And THEN what the mixin does on SpiderMonkey, after the bytes are down.
    const outOfSync = Object.assign(new Error('file already exists (Out of sync!)'), { code: 'EEXIST', errno: 17 });
    raw._promise = Promise.reject(outOfSync);
    store.writeSync('/srv/a.php', ENC.encode('written'), 0);   // makes the watcher pick the new queue up
    await store.flush().catch(() => {});

    assert.deepEqual(seen, [], 'nothing to report: the bytes are on the store and the cache is right');
    assert.doesNotThrow(() => store.syncSync(), 'and nothing latched to stop the next write');
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

  // The boundary, from the side that works: a REAL shell, writing into a
  // persistent store, and the bytes still there after the run that made them.
  // `run()` is the whole scope of this adapter — its guest exits, so the queue
  // gets the event loop back. A long-lived spawn() never does, and that is law
  // 1 rather than anything this file could assert its way out of.
  test('a real shell fills a persistent store, and flush() is when it is on disk', async (t) => {
    const { existsSync } = await import('node:fs');
    if (!existsSync(new URL('../dist/busybox.wasm', import.meta.url))) {
      t.skip('no dist/busybox.wasm — run npm run build:wasm');
      return;
    }
    const backing = makeBacking(zenfs);
    const { run } = await import('../src/run.mjs');
    const store = await persistentFs(await backing.make());
    const r = await run({
      inline: true,
      fs: store,
      script: 'mkdir -p /srv && printf \'<?php echo "hi";\' > /srv/index.php',
    });
    assert.equal(r.exitCode, 0, r.stderr);
    await store.flush();
    assert.equal(DEC.decode(backing.bytes.get('/srv/index.php')), '<?php echo "hi";');

    // And a second session over the same backend opens what the first left.
    const next = await persistentFs(await backing.make());
    const again = await run({ inline: true, fs: next, command: 'cat /srv/index.php' });
    assert.equal(again.stdout, '<?php echo "hi";');
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
