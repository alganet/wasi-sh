// `indexedDbFlushPoint` — gap 4's barrier, driven against a fake `IDBFactory`.
//
// Node has no IndexedDB, and that is fine here: what these cases are about is
// this function's own control flow, and every one of them is a rule that was
// learned by getting it wrong.
//
//   * it must never CREATE a database. A bare `indexedDB.open(name)` makes an
//     empty one, and an empty one with no object store is exactly what the next
//     `IndexedDB.create()` fails on — a probe that opened the page's database
//     to count its records is how that was found, by breaking the page.
//   * it must not report the same "there is no database" for ever. Its error is
//     latched by `persistentFs` on identity, so a fresh Error per flush is a
//     line in somebody's terminal per write for the rest of the session.
//   * it must not BLOCK a `deleteDatabase`, which is the one thing a page with
//     a damaged store has left to try.
//
// What is NOT here is the guarantee the barrier rests on — that a `readonly`
// transaction created now completes only after every earlier `readwrite` one.
// That is IndexedDB's, not this function's, and the place it is asserted is
// `wide`'s browser suite against a real engine.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { indexedDbFlushPoint, persistentFs } from '../src/fs.mjs';

/**
 * As much of an `IDBFactory` as the barrier touches, plus a queue of writes it
 * is supposed to be ordered behind.
 */
function fakeIndexedDb(options = {}) {
  const state = {
    exists: options.exists ?? true,
    stores: options.stores ?? ['db'],
    opened: 0,
    closed: 0,
    transactions: 0,
    /** Resolvers for transactions still in flight, oldest first. */
    inFlight: [],
    connections: [],
  };
  const factory = {
    async databases() { return state.exists ? [{ name: 'db', version: 1 }] : []; },
    open(name) {
      const request = { result: null, error: null, transaction: null };
      queueMicrotask(() => {
        if (!state.exists) {
          // What a real engine does for a name it has never seen: an upgrade,
          // which is the branch that must refuse rather than proceed.
          state.upgraded = true;
          request.transaction = { abort() { state.aborted = true; } };
          request.onupgradeneeded?.();
          request.error = new Error('AbortError');
          request.onerror?.();
          return;
        }
        state.opened += 1;
        const db = {
          name,
          objectStoreNames: { contains: (which) => state.stores.includes(which) },
          close() { state.closed += 1; db.onclose?.(); },
          transaction() {
            state.transactions += 1;
            const tx = {
              error: null,
              objectStore: () => ({ openKeyCursor: () => {} }),
            };
            // Left in flight until the test says the writes ahead of it are
            // done, which is the ordering this stands in for.
            state.inFlight.push(() => tx.oncomplete?.());
            return tx;
          },
        };
        state.connections.push(db);
        request.result = db;
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory, state };
}

describe('indexedDbFlushPoint', () => {
  test('waits for the transaction it opened, rather than returning at once', async () => {
    const { factory, state } = fakeIndexedDb();
    const commit = indexedDbFlushPoint({ database: 'db', factory });

    let settled = false;
    const waiting = commit().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled, false, 'the whole point is that this does not resolve early');
    assert.equal(state.transactions, 1);

    state.inFlight.shift()();
    await waiting;
    assert.equal(settled, true);
  });

  test('keeps one connection across flushes, rather than opening per call', async () => {
    // The barrier runs per DRAINED BATCH — thousands of times over a seed — and
    // an open/close round trip each time is the cost it is trying to be under.
    const { factory, state } = fakeIndexedDb();
    const commit = indexedDbFlushPoint({ database: 'db', factory });
    for (let i = 0; i < 3; i++) {
      const waiting = commit();
      await new Promise((r) => setTimeout(r, 5));
      state.inFlight.shift()();
      await waiting;
    }
    assert.equal(state.opened, 1);
    assert.equal(state.transactions, 3);
  });

  test('two flushes at once open ONE connection, not two', async () => {
    // The barrier is awaited per drained batch and an embedder is free to call
    // `flush()` beside the drain, so two callers can be inside `connect()` at
    // the same moment. Memoizing the resolved CONNECTION rather than the
    // promise lets both past the guard: two connections, one of them held by
    // nothing — and a connection held by nothing blocks the `deleteDatabase`
    // that a page with a damaged store has left as its only way out.
    const { factory, state } = fakeIndexedDb();
    const commit = indexedDbFlushPoint({ database: 'db', factory });

    const both = Promise.all([commit(), commit()]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(state.opened, 1, `opened ${state.opened} connections for two concurrent flushes`);
    while (state.inFlight.length) state.inFlight.shift()();
    await both;
    assert.equal(state.connections.length, 1);
  });

  test('refuses a database that is not there, and does NOT leave one behind', async () => {
    // `indexedDB.open(name)` with no version CREATES an empty database, and an
    // empty one with no object store is what the store opened over it then
    // fails on. So the upgrade branch aborts rather than proceeding.
    const { factory, state } = fakeIndexedDb({ exists: false });
    const commit = indexedDbFlushPoint({ database: 'db', factory });
    await assert.rejects(commit, /no longer there/);
    assert.equal(state.aborted, true, 'the version-change transaction is abandoned');
    assert.equal(state.opened, 0, 'and no usable connection was ever handed out');
  });

  test('refuses a database with no object store of that name', async () => {
    const { factory } = fakeIndexedDb({ stores: ['something-else'] });
    const commit = indexedDbFlushPoint({ database: 'db', factory });
    await assert.rejects(commit, /there is no 'db' in 'db' to commit/);
  });

  test('raises the SAME error object every time the database is gone', async () => {
    // Identity, because `persistentFs` dedupes reports by it. A fresh Error per
    // flush is one line in the terminal per write for the rest of the session,
    // over a failure the writes underneath are already reporting themselves.
    const { factory } = fakeIndexedDb({ exists: false });
    const commit = indexedDbFlushPoint({ database: 'db', factory });
    const first = await commit().catch((e) => e);
    const second = await commit().catch((e) => e);
    assert.equal(first, second);
  });

  test('closes on versionchange, so a deleteDatabase is never blocked by it', async () => {
    // A page with a damaged store has exactly one thing left to try, and a
    // connection this barrier is holding would block it.
    const { factory, state } = fakeIndexedDb();
    const commit = indexedDbFlushPoint({ database: 'db', factory });
    const waiting = commit();
    await new Promise((r) => setTimeout(r, 5));
    state.inFlight.shift()();
    await waiting;

    const db = state.connections[0];
    assert.equal(typeof db.onversionchange, 'function', 'somebody else deleting must be able to say so');
    db.onversionchange();
    assert.equal(state.closed, 1);
  });

  test('says what it needs, where it is asked for', () => {
    assert.throws(() => indexedDbFlushPoint({}), /needs \{ database \}/);
    assert.throws(() => indexedDbFlushPoint({ database: '' }), /needs \{ database \}/);
    assert.throws(() => indexedDbFlushPoint({ database: 'db', factory: null }), /there is no IndexedDB here/);
  });

  test('the object store defaults to the database name, as @zenfs/dom does', async () => {
    const { factory, state } = fakeIndexedDb({ stores: ['db'] });
    const waiting = indexedDbFlushPoint({ database: 'db', factory })();
    await new Promise((r) => setTimeout(r, 5));
    state.inFlight.shift()();
    await waiting;
    assert.equal(state.transactions, 1);
  });
});

describe('persistentFs with an indexedDbFlushPoint', () => {
  /** The gap-4 shape: writes that land later, and a `sync()` that is empty. */
  function deferred() {
    const landed = [];
    let queue = Promise.resolve();
    const meta = { mode: 0o100644, uid: 0, gid: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
    return {
      landed,
      drain: () => queue,
      statSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      readdirSync: () => [],
      readSync() {},
      createFileSync() {},
      mkdirSync() {},
      rmdirSync() {},
      unlinkSync() {},
      renameSync() {},
      touchSync() {},
      writeSync(path) { queue = queue.then(() => new Promise((r) => setTimeout(r, 1))).then(() => landed.push(path)); },
      async sync() {},
      syncSync() {},
      meta,
    };
  }

  test('the two together are what makes flush() mean anything', async () => {
    // The whole finding, end to end and in one case: without a commit the
    // flush is over before the writes are, and with one it is not.
    const bare = deferred();
    const loose = await persistentFs(bare);
    loose.writeSync('/a', new Uint8Array(1), 0);
    await loose.flush();
    assert.deepEqual(bare.landed, [], 'sync() alone promises nothing');

    const guarded = deferred();
    const tight = await persistentFs(guarded, { commit: () => guarded.drain() });
    tight.writeSync('/a', new Uint8Array(1), 0);
    tight.writeSync('/b', new Uint8Array(1), 0);
    await tight.flush();
    assert.deepEqual(guarded.landed, ['/a', '/b']);
  });
});
