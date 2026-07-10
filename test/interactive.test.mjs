// Interactive Session semantics, headless: a node worker_threads twin of
// src/worker.mjs runs the shell parked on the real SAB ring while the main
// thread drives it through RingWriter — the same Atomics.wait machinery the
// browser uses, no DOM, no terminal. (This file is also one of the three
// in-tree consumers proving the byte-duplex contract needs no terminal.)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createStdinRing, RingWriter } from '../src/ring.mjs';
import { compileWasm } from '../src/node.mjs';

let wasm;
before(async () => { wasm = await compileWasm(); });

// The node twin of src/worker.mjs: same shim + RingReader wiring, with
// parentPort standing in for postMessage.
const TWIN = `
  import { parentPort, workerData } from 'node:worker_threads';
  const { WasiShim, WasiExit } = await import(workerData.shimUrl);
  const { RingReader } = await import(workerData.ringUrl);
  const { module, files, args, env, sab } = workerData;
  const dec = new TextDecoder();
  let out = '';
  const shim = new WasiShim({
    args, env, files,
    stdout: (b) => { out += dec.decode(b); parentPort.postMessage({ type: 'out' }); },
    stderr: (b) => { out += dec.decode(b); },
    input: new RingReader(sab).toInput(),
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  let code = 0;
  try { instance.exports._start(); }
  catch (e) { if (e instanceof WasiExit) code = e.code; else throw e; }
  parentPort.postMessage({ type: 'exit', code, out });
`;

function spawnTwin(script, { env = {} } = {}) {
  const sab = createStdinRing();
  const writer = new RingWriter(sab);
  const worker = new Worker(TWIN, {
    eval: true,
    workerData: {
      module: wasm,
      files: { '/t.sh': script },
      args: ['busybox', 'sh', '/t.sh'],
      env: { PATH: '/', LC_ALL: 'C', ...env },
      sab,
      shimUrl: new URL('../src/shim.mjs', import.meta.url).href,
      ringUrl: new URL('../src/ring.mjs', import.meta.url).href,
    },
  });
  const exited = new Promise((resolve, reject) => {
    worker.on('message', (m) => { if (m.type === 'exit') { resolve(m); worker.terminate(); } });
    worker.on('error', reject);
  });
  return { writer, exited };
}

const enc = new TextEncoder();

test('read -t honors its timeout (the ppoll/poll_oneoff chain end-to-end)', async () => {
  const t0 = Date.now();
  const { exited } = spawnTwin('read -t 0.2 x; echo "to rc=$?"');
  const m = await exited;
  const elapsed = Date.now() - t0;
  assert.match(m.out, /to rc=1/, 'read -t with no input fails past the timeout');
  assert.ok(elapsed >= 150, `waited the timeout (${elapsed}ms)`);
  assert.ok(elapsed < 1500, `did not hang (${elapsed}ms)`);
});

test('blocking read parks and wakes promptly on write', async () => {
  const { writer, exited } = spawnTwin('read -r x; echo "got=[$x]"');
  // Let the guest reach the blocking read, then feed a line.
  await new Promise((res) => setTimeout(res, 150));
  const t0 = Date.now();
  writer.write(enc.encode('hello\n'));
  const m = await exited;
  const wake = Date.now() - t0;
  assert.match(m.out, /got=\[hello\]/);
  assert.ok(wake < 1000, `woke promptly after the write (${wake}ms)`);
});

test('input arriving byte-by-byte accumulates into one line', async () => {
  const { writer, exited } = spawnTwin('read -r x; echo "word=[$x]"');
  await new Promise((res) => setTimeout(res, 100));
  for (const ch of ['a', 'b', 'c', '\n']) {
    writer.write(enc.encode(ch));
    await new Promise((res) => setTimeout(res, 10));
  }
  const m = await exited;
  assert.match(m.out, /word=\[abc\]/);
});

test('end() delivers EOF: while read terminates', async () => {
  const { writer, exited } = spawnTwin('n=0; while read -r _; do n=$((n+1)); done; echo "n=$n"');
  await new Promise((res) => setTimeout(res, 100));
  writer.write(enc.encode('one\ntwo\n'));
  await new Promise((res) => setTimeout(res, 50));
  const t0 = Date.now();
  writer.end();
  const m = await exited;
  assert.match(m.out, /n=2/);
  assert.ok(Date.now() - t0 < 5000, 'EOF woke the parked read, not the 30s recheck');
});

test('interactive loop: guest echoes multiple inputs then quits on command', async () => {
  const { writer, exited } = spawnTwin(
    'while read -r cmd; do case "$cmd" in q) echo bye; exit 5;; *) echo "echo:$cmd";; esac; done'
  );
  await new Promise((res) => setTimeout(res, 100));
  writer.write(enc.encode('first\n'));
  await new Promise((res) => setTimeout(res, 30));
  writer.write(enc.encode('second\n'));
  await new Promise((res) => setTimeout(res, 30));
  writer.write(enc.encode('q\n'));
  const m = await exited;
  assert.match(m.out, /echo:first/);
  assert.match(m.out, /echo:second/);
  assert.match(m.out, /bye/);
  assert.equal(m.code, 5, 'exit code propagates');
});
