// journalFs / journalWriter — a store that can be written from INSIDE a
// running guest.
//
// The case that matters is the one persistentFs cannot pass, and it is the
// reason this file spawns a worker instead of asserting on one thread: a live
// session is a synchronous frame parked in `Atomics.wait`, so a write-back
// queued behind it never runs. Everything here is therefore driven from a
// worker that really does park (test/fs-journal.guest.mjs), with the backing
// store on this thread where a free event loop can land the bytes.
//
// The browser half — OPFS behind a real `spawn()` on /dev/hostreq — is
// measured rather than asserted, as fs-persist.test.mjs measures its own:
// there is no FileSystemDirectoryHandle here. Recorded in MOAR.md §4.3b.
//
// A DEV DEPENDENCY ONLY, like fs-persist.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import { journalFs, journalWriter, createJournal, memoryFs } from '../src/fs.mjs';
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
const GUEST = new URL('./fs-journal.guest.mjs', import.meta.url);

/**
 * Start a guest worker and collect what it posts. `next()` consumes one
 * message; `messages` is everything seen SO FAR, which is what the parked case
 * asserts on — that a later message has not arrived yet is the measurement.
 */
function startGuest(scenario, sab, snapshot, extra = {}) {
  const worker = new Worker(GUEST, { workerData: { sab, snapshot, scenario, ...extra } });
  const messages = [];
  const waiters = [];
  let taken = 0;
  const arrive = (m) => { messages.push(m); const w = waiters.shift(); if (w) { taken++; w(m); } };
  worker.on('message', arrive);
  worker.on('error', (err) => arrive({ error: `${err.message}` }));
  return {
    worker,
    messages,
    next: () => (taken < messages.length
      ? Promise.resolve(messages[taken++])
      : new Promise((resolve) => waiters.push(resolve))),
    done: () => new Promise((resolve) => worker.on('exit', resolve)),
  };
}

if (!zenfs) {
  test('journalFs against an async backend', { skip: '@zenfs/core is not installed' }, () => {});
} else {
  test('refuses anything that is not the writer\'s buffer', () => {
    assert.throws(() => journalFs({}), /expected the SharedArrayBuffer from journalWriter\(\)\.sab/);
    assert.throws(() => journalFs(new ArrayBuffer(1024)), /SharedArrayBuffer/);
  });

  // THE ONE. persistentFs behind a live session fills a cache and nothing
  // else; this is the same shape and the bytes are on the backend while the
  // guest is still parked, which is the pass criterion MOAR §4.3b names.
  test('a write leaves a guest that has not exited, and lands while it is parked', async () => {
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make());
    const guest = startGuest('write-then-park', writer.sab, writer.snapshot);

    assert.equal(await guest.next(), 'written');
    await writer.idle();
    assert.equal(
      DEC.decode(backing.bytes.get('/srv/live.txt')),
      'written from inside a running guest',
      'the bytes are on the backend before the guest has woken, let alone exited',
    );
    assert.equal(guest.messages.includes('woke'), false, 'and the guest really was still parked');

    assert.equal(await guest.next(), 'woke');
    await guest.done();
    await writer.stop();
  });

  test('the session starts on what the backing store really holds', async () => {
    const backing = makeBacking(zenfs, { '/srv/index.php': '<?php echo "seeded";' });
    const writer = await journalWriter(await backing.make());
    const guest = startGuest('read-snapshot', writer.sab, writer.snapshot);
    assert.deepEqual(await guest.next(), { index: '<?php echo "seeded";', listing: ['index.php'] });
    await guest.done();
    await writer.stop();
  });

  // What persistentFs's syncSync() could not be. The writer moves the tail
  // only after its own flush resolved, so a drained journal means the bytes
  // reached the backend rather than merely a queue.
  test('syncSync blocks until the bytes are really on the backend', async () => {
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make());
    const guest = startGuest('sync', writer.sab, writer.snapshot);
    assert.equal(await guest.next(), 'synced');
    assert.equal(DEC.decode(backing.bytes.get('/a.txt')), 'sync me',
      'no idle() here on purpose: syncSync returning IS the guarantee');
    await guest.done();
    await writer.stop();
  });

  // The dev-environment shape of ZENFS.md finding 10: an empty file exists in
  // the guest's cache and in the backend's index, and nowhere a reload can
  // find it.
  test('an empty file the guest made is on the backend too', async () => {
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make());
    const guest = startGuest('empty-file', writer.sab, writer.snapshot);
    assert.equal(await guest.next(), 'made');
    assert.ok(backing.bytes.has('/empty.txt'), 'the backend never heard of the file');
    await guest.done();
    await writer.stop();
  });

  // And the failure that made it more than a missing file: the backend is
  // asked to remove a name it never had, that failure latches, and the store
  // refuses every write after it. At a prompt: `touch a; rm a`, and then
  // `mkdir b` is an I/O error.
  test('a file created and removed does not stop the store', async () => {
    const backing = makeBacking(zenfs);
    const seen = [];
    const writer = await journalWriter(await backing.make(), { onError: (err) => seen.push(err) });
    const guest = startGuest('touch-then-remove', writer.sab, writer.snapshot);
    assert.equal(await guest.next(), 'survived');
    assert.deepEqual(seen.map((err) => err.message), []);
    assert.equal(DEC.decode(backing.bytes.get('/after/ok.txt')), 'still working');
    await guest.done();
    await writer.stop();
  });

  test('a write-back that fails reaches the guest, with the reason', async () => {
    // SEEDED rather than created by the guest, and the count below is why. A
    // file the guest creates is hollow until it is written, and a flush
    // materializes it with a zero-length write of its own — so a create+write
    // the drain splits across two batches really does attempt two writes and
    // really does report two failures. Truthful, but a coincidence of batching.
    // One write is what makes `1` mean "reported once" rather than "batched
    // once", which is the regression this is here for: passing `onError`
    // through to persistentFs made a single failed write arrive at the embedder
    // twice, once as it happened and once when the flush raised it.
    const backing = makeBacking(zenfs, { '/nope.txt': 'seeded' });
    const raw = await backing.make();
    const seen = [];
    const writer = await journalWriter(raw, { onError: (err) => seen.push(err) });
    raw.failOn = '/nope.txt';
    const guest = startGuest('reports-a-failure', writer.sab, writer.snapshot);
    const raised = await guest.next();
    assert.match(raised.raised, /a write did not reach the backing store: .*quota exceeded/);
    assert.equal(raised.code, 'EIO');
    assert.equal(await guest.next(), 'quiet after');
    assert.equal(seen.length, 1, 'and the writer\'s own thread was told once, not twice');
    await guest.done();
    await writer.stop();
  });

  test('a failed materialize is reported too, though nothing wrote the file', async () => {
    // The other half of the case above, and the one a seeded file cannot
    // reach: `touch a` and nothing else. The guest asks the backend for no
    // bytes at all, so the only write that ever happens is the empty one
    // persistentFs adds to make the file real (ZENFS.md finding 10) — and if
    // THAT fails, the guest still has to hear about it, or `touch` on a full
    // disk looks like it worked.
    const backing = makeBacking(zenfs);
    const raw = await backing.make();
    const seen = [];
    const writer = await journalWriter(raw, { onError: (err) => seen.push(err) });
    raw.failOn = '/nope.txt';
    const guest = startGuest('reports-a-failed-materialize', writer.sab, writer.snapshot);
    const raised = await guest.next();
    assert.match(raised.raised, /a write did not reach the backing store: .*quota exceeded/);
    assert.equal(raised.code, 'EIO');
    assert.equal(seen.length, 1, 'one write was attempted, so one failure is reported');
    await guest.done();
    await writer.stop();
  });

  // The order inside the store: the cache decides, and only what it accepted
  // is journaled. A refusal that still appended would hand the writer an
  // operation that cannot apply, and the two would diverge from there on.
  test('an operation the cache refuses is never journaled', async () => {
    const backing = makeBacking(zenfs, { '/srv/keep.txt': 'here' });
    const writer = await journalWriter(await backing.make());
    const guest = startGuest('refuses-a-bad-op-without-journaling', writer.sab, writer.snapshot);
    assert.deepEqual(await guest.next(), { refused: 'EEXIST' });
    assert.equal(await guest.next(), 'done');
    assert.equal(DEC.decode(backing.bytes.get('/after.txt')), 'still working');
    assert.equal(DEC.decode(backing.bytes.get('/srv/keep.txt')), 'here');
    await guest.done();
    await writer.stop();
  });

  // A write larger than the journal is split by offset — which the contract
  // already makes safe, since writes are positional — rather than overflowing
  // or forcing the embedder to size the buffer for the largest file.
  test('a write bigger than the whole journal still arrives, whole', async () => {
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make(), { bufferSize: 65536 });
    const guest = startGuest('big-write', writer.sab, writer.snapshot);
    assert.deepEqual(await guest.next(), { wrote: 300000, cached: 300000 });
    const landed = backing.bytes.get('/big.bin');
    assert.equal(landed.length, 300000);
    for (let i = 0; i < landed.length; i += 4093) assert.equal(landed[i], i & 0xff, `byte ${i}`);
    await guest.done();
    await writer.stop();
  });

  // A guest whose writer has gone must fail loudly and promptly, and must fail
  // BEFORE the cache moves: blocking for ever inside a `write()` is the one
  // outcome a shell cannot report, and succeeding into a cache nothing drains
  // is the one it cannot detect — it looks exactly like a store that saved.
  test('a writer that goes away fails the guest, before the cache moves', async () => {
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make(), { bufferSize: 65536 });
    const guest = startGuest('writer-goes-away', writer.sab, writer.snapshot);
    assert.equal(await guest.next(), 'ready');
    await writer.stop();
    const refused = await guest.next();
    assert.match(refused.error, /EIO .*the journal writer has stopped/);
    assert.equal(refused.cached, false, 'and the file it refused is not in the cache either');
    await guest.done();
  });

  // The same thing one step earlier, where it is cheapest to say: a store
  // built against a dead writer is a store that will lose everything.
  test('a store refuses to be built against a writer that is not running', async () => {
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make());
    await writer.stop();
    assert.throws(() => journalFs(writer.sab, writer.snapshot),
      /the journal writer is stopped, so nothing written here would ever be persisted/);
    assert.throws(() => journalFs(createJournal()), /the journal writer is not running/);
  });

  test('a journal is at least big enough for one ordinary write', () => {
    assert.equal(createJournal(16).byteLength, createJournal(65536).byteLength);
  });

  // `snapshot`: hydrating the backing store is no longer what a guest waits
  // for. The measurement that bought this is in MOAR §4.3c — an OPFS tree the
  // caller reads itself in 591 ms against 1,899 ms to hydrate a WebAccessFS and
  // walk it — but the property under test is not the speed. It is that the
  // session starts on a tree the backing store has not been opened for, and
  // that nothing written in the meantime is lost.
  //
  // A promise nobody has resolved stands in for the slow open, because it is
  // the only stand-in that cannot accidentally be fast.
  const gated = () => { let open; return { promise: new Promise((r) => { open = r; }), open }; };

  test('a snapshot the caller supplies starts the session before the store opens', async () => {
    const backing = makeBacking(zenfs, { '/srv/index.php': '<?php echo "seeded";' });
    // Read the tree the way the default path would, so what is handed over is
    // exactly what the store would have produced — the contract the option
    // documents, held here rather than described.
    const probe = await journalWriter(await backing.make());
    const snapshot = probe.snapshot;
    await probe.stop();

    const gate = gated();
    const writer = await journalWriter(gate.promise, { snapshot });
    assert.deepEqual(writer.snapshot, snapshot, 'handed straight back, not re-read');

    // The whole claim: a guest builds its filesystem and reads the project
    // while the backing store is still a promise nobody has resolved.
    const guest = startGuest('read-snapshot', writer.sab, writer.snapshot);
    assert.deepEqual(await guest.next(), { index: '<?php echo "seeded";', listing: ['index.php'] });
    await guest.done();

    gate.open(await backing.make());
    await writer.ready;
    await writer.stop();
  });

  // The half that would make the option a data-loss bug if it were wrong.
  test('a write journaled before the store opens is applied once it does', async () => {
    const backing = makeBacking(zenfs);
    const probe = await journalWriter(await backing.make());
    const snapshot = probe.snapshot;
    await probe.stop();

    const gate = gated();
    const writer = await journalWriter(gate.promise, { snapshot });
    const guest = startGuest('write-then-park', writer.sab, writer.snapshot);
    assert.equal(await guest.next(), 'written');
    assert.equal(backing.bytes.has('/srv/live.txt'), false,
      'the drain is waiting on the store, so nothing can have been applied yet');

    gate.open(await backing.make());
    await writer.idle();
    assert.equal(
      DEC.decode(backing.bytes.get('/srv/live.txt')),
      'written from inside a running guest',
      'and the write made during the wait is not lost',
    );
    assert.equal(await guest.next(), 'woke');
    await guest.done();
    await writer.stop();
  });

  test('the backing store refuses to be read before it is open, by name', async () => {
    const backing = makeBacking(zenfs);
    const probe = await journalWriter(await backing.make());
    await probe.stop();

    const gate = gated();
    const writer = await journalWriter(gate.promise, { snapshot: probe.snapshot });
    // Silently null here is the defect this getter exists to refuse: it would
    // be read as "the store has nothing in it" by the one caller most likely
    // to look, and only for the first second of a session.
    assert.throws(() => writer.store, /the backing store is not open yet/);
    gate.open(await backing.make());
    assert.equal(await writer.ready, await writer.ready, 'ready settles to the store itself');
    assert.equal(typeof writer.store.statSync, 'function');
    await writer.stop();
  });

  // What the deferral costs, stated as a test rather than as a footnote: an
  // open that fails is no longer this call rejecting, so it has to arrive on
  // the channel every other write-back failure uses.
  test('an open that fails after the snapshot is reported, and stops the writer', async () => {
    const seen = [];
    const writer = await journalWriter(
      Promise.reject(new Error('the directory went away')),
      { snapshot: [], onError: (err) => seen.push(err) },
    );
    await writer.stop();
    assert.equal(seen.length, 1);
    assert.match(seen[0].message, /the directory went away/);
    assert.throws(() => journalFs(writer.sab, []),
      /the journal writer is stopped/,
      'and a guest that arrives late is refused rather than writing into nothing');
  });

  // The default path keeps rejecting, and must also withdraw the claim it made
  // on the buffer before it knew it could not keep it. Without this, a caller
  // that catches the rejection and hands the buffer on anyway gets a store
  // built against a writer that does not exist.
  test('a hydrate that fails on the default path leaves no buffer claiming a writer', async () => {
    const sab = createJournal();
    const stub = Object.fromEntries(
      ['statSync', 'readdirSync', 'createFileSync', 'mkdirSync', 'rmdirSync',
        'unlinkSync', 'renameSync', 'readSync', 'writeSync', 'touchSync'].map((n) => [n, () => {}]),
    );
    stub.ready = async () => { throw new Error('permission was revoked'); };
    await assert.rejects(() => journalWriter(stub, { sab }), /could not be hydrated: permission was revoked/);
    assert.throws(() => journalFs(sab, []), /the journal writer is stopped/);
  });

  // The commonest write a shell makes, and it was silently corrupt: `>` opens
  // with O_TRUNC, which is a touchSync to zero, and @zenfs/core's touch updates
  // the index inode without shortening the file. Within the session the cache
  // agrees with itself; the NEXT hydrate reads the file that is really there
  // and hands back the old bytes past the new end. So this asserts across a
  // rehydrate, which is where a reload lives.
  test('a truncated file is truncated on the backend too, after a rehydrate', async () => {
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make());
    const fs = journalFs(writer.sab, writer.snapshot);
    const NEW_FILE = { mode: 0o644, uid: 0, gid: 0 };
    fs.createFileSync('/index.php', NEW_FILE);
    fs.writeSync('/index.php', ENC.encode('the original seed, quite a lot longer'), 0);
    await writer.idle();

    fs.touchSync('/index.php', { size: 0 });          // what `> file` does
    fs.writeSync('/index.php', ENC.encode('EDITED'), 0);
    fs.touchSync('/index.php', { size: 6 });
    await writer.idle();

    assert.equal(DEC.decode(backing.bytes.get('/index.php')), 'EDITED');
    const rehydrated = await backing.make();
    await rehydrated.ready();
    assert.equal(rehydrated.statSync('/index.php').size, 6);
    await writer.stop();
  });

  // And the other direction: a file GROWN by touchSync has a zero hole, not
  // whatever the bytes past its old end used to be.
  test('a file grown by touchSync gets a zero hole on the backend', async () => {
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make());
    const fs = journalFs(writer.sab, writer.snapshot);
    fs.createFileSync('/g.bin', { mode: 0o644, uid: 0, gid: 0 });
    fs.writeSync('/g.bin', ENC.encode('abcde'), 0);
    fs.touchSync('/g.bin', { size: 2 });
    fs.touchSync('/g.bin', { size: 5 });
    await writer.idle();
    assert.deepEqual([...backing.bytes.get('/g.bin')], [...ENC.encode('ab'), 0, 0, 0]);
    await writer.stop();
  });

  // head and tail are Int32 byte counters, so a session that pushes 2 GiB
  // through the journal wraps them — and a session that lives as long as a tab
  // is the one that can. Every comparison goes through the difference for that
  // reason; this drives the counters over the edge and checks the store did not
  // notice.
  test('the journal survives its byte counters wrapping', async () => {
    const sab = createJournal(65536);
    const ctrl = new Int32Array(sab, 0, 8);
    const near = 2147483647 - 1000;
    Atomics.store(ctrl, 0, near);          // head
    Atomics.store(ctrl, 1, near);          // tail
    const writer = await journalWriter(memoryFs(), { sab });
    const fs = journalFs(sab, writer.snapshot);
    const chunk = new Uint8Array(200).fill(7);
    for (let i = 0; i < 20; i++) {
      fs.createFileSync(`/w${i}.txt`, { mode: 0o644, uid: 0, gid: 0 });
      fs.writeSync(`/w${i}.txt`, chunk, 0);
    }
    await writer.idle();
    assert.ok(Atomics.load(ctrl, 0) < 0, 'the counter really did go past 2^31');
    for (let i = 0; i < 20; i++) {
      assert.equal(writer.store.statSync(`/w${i}.txt`).size, 200, `/w${i}.txt`);
    }
    await writer.stop();
  });

  // The end of the line, and the criterion MOAR §4.3b wrote down: a REAL shell
  // parked on /dev/hostreq, a file written from inside it, and the backing
  // store holding those bytes while that shell is still parked. This is the
  // case fs-persist.test.mjs states it cannot reach — its guest has to exit
  // before anything drains — and it is the whole reason this store exists.
  const WASM = new URL('../dist/busybox.wasm', import.meta.url);
  test('a shell parked on /dev/hostreq persists a file it has not exited after', async (t) => {
    if (!existsSync(WASM)) { t.skip('no dist/busybox.wasm — run npm run build:wasm'); return; }
    const { createRing, RingWriter, frameRequest } = await import('../src/ring.mjs');
    const backing = makeBacking(zenfs);
    const writer = await journalWriter(await backing.make());
    const reqSab = createRing();
    const guest = startGuest('real-shell', writer.sab, writer.snapshot, {
      module: await WebAssembly.compile(readFileSync(WASM)),
      reqSab,
      script: [
        'mkdir -p /srv',
        'echo ready',
        'while read -r req <&3; do',
        '  printf "served %s" "$req" > "/srv/$req.txt"',
        '  echo "handled $req"',
        'done 3< /dev/hostreq',
        'echo loop-ended',
      ].join('\n') + '\n',
    });

    let seen = '';
    const until = async (needle, ms = 8000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        while (guest.messages.length) { const m = guest.messages.shift(); if (m.out) seen += m.out; else if (m.error) assert.fail(m.error); }
        if (seen.includes(needle)) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    assert.ok(await until('ready\n'), 'the loop reached its first read');

    new RingWriter(reqSab, { channel: 'host request' }).write(frameRequest('index'));
    assert.ok(await until('handled index'), 'the parked guest was woken and served it');
    await writer.idle();

    assert.equal(DEC.decode(backing.bytes.get('/srv/index.txt')), 'served index',
      'on the backing store, from a shell that is still sitting in its read');
    assert.equal(seen.includes('loop-ended'), false);
    await guest.worker.terminate();
    await writer.stop();
  });

  // The contract, against the store the session actually holds — and over a
  // MEMORY backing rather than the async double, which is the point. Every
  // case here has to be green: the guest reads its cache, so a journaled call
  // must answer exactly as the same call on `memoryFs` does, and every verb
  // the suite exercises has to be one the writer knows how to replay. A
  // backend with deviations of its own would test the backend instead, which
  // fs-persist.test.mjs already does and which would hide a real defect here
  // behind an expected failure.
  //
  // On this thread on purpose, which is only safe because the writer drains
  // between cases (node:test awaits each one) and the journal is sized past
  // anything the suite writes. A guest has neither luxury, hence the worker
  // everywhere above.
  const conformanceWriter = await journalWriter(memoryFs(), { bufferSize: 8 << 20 });
  const journaled = journalFs(conformanceWriter.sab, conformanceWriter.snapshot);
  // The one case this arrangement cannot host, and not because the store is
  // wrong: syncSync() blocks until the WRITER has applied everything, and here
  // the writer is this very thread — so it would wait for itself. Covered
  // above, from a worker, where the two are on different threads as they are
  // in the only configuration this store is for.
  const SAME_THREAD = 'syncSync blocks on the writer, which is this thread here';
  conformanceCases().forEach((testCase, index) => {
    const skip = testCase.name.startsWith('syncSync is callable') ? SAME_THREAD : false;
    test(`journalFs conformance: ${testCase.name}`, { skip }, async () => {
      testCase.run(journaled, `/conformance-${index}`);
      await conformanceWriter.idle();
      // And the backend agrees, verb for verb: a replay that silently did
      // nothing would pass every case above, since the cache answers them all.
      assert.deepEqual(
        conformanceWriter.store.readdirSync(`/conformance-${index}`).sort(),
        journaled.readdirSync(`/conformance-${index}`).sort(),
      );
    });
  });
}
