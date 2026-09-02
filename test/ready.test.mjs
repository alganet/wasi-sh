// serve({ ready }): the session, once there IS one.
//
// `builtins()` cannot answer this — it is resolved BEFORE the shim exists,
// because the shim is what its result is passed to — so a worker that wants the
// filesystem the guest is about to run over has had exactly one way to reach
// it: be inside a host builtin, which means having the guest CALL you. For a
// guest that is a terminal, parked on its own stdin, that is no way at all.
//
// Driven through a worker_threads twin so what runs is src/worker.mjs itself
// rather than a recipe re-derived beside it.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';

let wasm;
before(async () => {
  // Bytes rather than a compiled Module: the twin posts the startup message the
  // way an embedder's page does, and a Module is not what crosses there.
  wasm = new Uint8Array(await readFile(new URL('../dist/busybox.wasm', import.meta.url)));
});

const TWIN = new URL('./worker-twin.mjs', import.meta.url);
const MODULE = new URL('./ready.worker.mjs', import.meta.url).href;

/** Start the twin, run one script in it, and collect what ready() saw. */
async function probe({ script = 'mark\n', files = {} } = {}) {
  const worker = new Worker(TWIN, { workerData: { module: MODULE } });
  const dec = new TextDecoder();
  let out = '';
  let result;
  let exit;
  const done = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.type === 'twin.ready') return;
      if (m.type === 'out') out += dec.decode(new Uint8Array(m.bytes));
      else if (m.type === 'probe.result') { result = m; if (exit !== undefined) resolve(); }
      else if (m.type === 'exit') { exit = m.code; if (result) resolve(); }
      else if (m.type === 'error') reject(new Error(m.msg));
    });
    worker.on('error', reject);
  });
  worker.postMessage({
    wasmBytes: wasm, files: { '/t.sh': script, ...files },
    args: ['busybox', 'sh', '/t.sh'], env: { PATH: '/', LC_ALL: 'C' },
    stdin: new Uint8Array(0),
  });
  worker.postMessage({ type: 'probe' });
  await done;
  await worker.terminate();
  return { ...result, out, exit };
}

describe('serve({ ready })', () => {
  test('is handed the session before the guest starts', async () => {
    const r = await probe();
    assert.equal(r.readyBeforeGuest, true, 'ready() ran before any guest code did');
    assert.match(r.out, /marked/, 'and the guest then ran, so the hook did not replace it');
    assert.equal(r.exit, 0);
  });

  test('hands over the same filesystem view a host builtin gets', async () => {
    const r = await probe();
    // The shape is the contract: hostFs() in shim.mjs, which is deliberately
    // NOT the store — see the comment there about what a narrow view buys.
    for (const name of ['exists', 'list', 'mkdir', 'read', 'remove', 'resolve', 'stat', 'write']) {
      assert.ok(r.fsShape.includes(name), `ctx.fs has ${name}; ready()'s should too`);
    }
  });

  test('and it is the filesystem the GUEST runs over, not a copy', async () => {
    const r = await probe({
      files: { '/seed.txt': 'from the mount' },
      // The guest reads back what the HOST wrote from ready(), which is the
      // whole claim: one filesystem, reachable from both sides.
      script: 'cat /from-host.txt\n',
    });
    assert.equal(r.seeded, 'from the mount', 'the host read what the mount seeded');
    assert.equal(r.wrote, true, 'and the write was accepted');
    assert.match(r.out, /host was here/, 'and the guest read it back');
  });

  test('reports what the engine actually granted, not what was asked for', async () => {
    const r = await probe();
    // Booleans either way: this suite runs with and without --experimental-wasm-jspi,
    // and the point of the field is that it answers for the engine in hand.
    assert.equal(typeof r.suspendable, 'boolean');
    assert.equal(typeof r.suspendInput, 'boolean');
  });
});
