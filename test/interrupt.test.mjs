// The cooperative interrupt, end to end over real shared memory: a shell in a
// worker_threads twin runs a host builtin that loops, and the MAIN thread — the
// page, in a browser — posts the ^C that gets it back.
//
// This is the one test that can prove the mechanism, because the guest is a
// single synchronous _start() frame: while that builtin loops, the worker's
// event loop never turns, so a postMessage into it is not slow but undelivered.
// Only a write into the ring the busy thread can read reaches it at all.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRing, RingWriter } from '../src/ring.mjs';
import { compileWasm } from '../src/node.mjs';

let wasm;
before(async () => { wasm = await compileWasm(); });

const HOSTB_READY = () => WebAssembly.Module.imports(wasm)
  .some((i) => i.module === 'env' && i.name === '__host_builtin_run');

// The node twin of src/worker.mjs, with three host builtins. `spin` is a
// runtime that will not stop on its own — the showstopper case from MOAR §4.4,
// one while(true) in a script. `brief` is the same loop on a short budget, so a
// command that is NOT interrupted still ends the test. `deaf` ignores the
// interrupt entirely and must not be cancelled: interrupts are cooperative, and
// a transport that could stop work which never opted in would be terminate().
const TWIN = `
  import { parentPort, workerData } from 'node:worker_threads';
  const { WasiShim, WasiExit } = await import(workerData.shimUrl);
  const { RingReader } = await import(workerData.ringUrl);
  const { module, files, args, env, sab } = workerData;
  const dec = new TextDecoder();
  let out = '';
  const emit = (b) => { const s = dec.decode(b); out += s; parentPort.postMessage({ type: 'out', text: s }); };
  // A bounded spin: a real hang would hang the SUITE if the interrupt failed,
  // and a test that hangs reports nothing. 10s is far past delivery, which is
  // measured in milliseconds.
  const until = (ctx, deadlineMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) { if (ctx && ctx.interrupted()) return 130; }
    return 7;   // "ran to completion" — never the interrupted answer
  };
  const shim = new WasiShim({
    args, env, files,
    stdout: emit,
    stderr: emit,
    input: new RingReader(sab).toInput(),
    builtins: {
      lookup: (n) => n === 'spin' || n === 'brief' || n === 'deaf',
      run: (ctx) => {
        const name = ctx.argv[0];
        ctx.stdout(name + ' running\\n');    // the main thread's cue to post
        return until(name === 'deaf' ? null : ctx, name === 'spin' ? 10000 : 500);
      },
    },
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  let code = 0;
  try { instance.exports._start(); }
  catch (e) { if (e instanceof WasiExit) code = e.code; else throw e; }
  parentPort.postMessage({ type: 'exit', code, out });
`;

function spawnTwin(script) {
  const sab = createRing();
  const writer = new RingWriter(sab);
  const worker = new Worker(TWIN, {
    eval: true,
    workerData: {
      module: wasm,
      files: { '/t.sh': script },
      args: ['busybox', 'sh', '/t.sh'],
      env: { PATH: '/', LC_ALL: 'C' },
      sab,
      shimUrl: new URL('../src/shim.mjs', import.meta.url).href,
      ringUrl: new URL('../src/ring.mjs', import.meta.url).href,
    },
  });
  let seen = '';
  const waiters = [];
  const check = () => { for (const w of waiters.splice(0)) w.re.test(seen) ? w.resolve() : waiters.push(w); };
  const exited = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.type === 'exit') { resolve(m); worker.terminate(); }
      else if (m.type === 'out') { seen += m.text; check(); }
    });
    worker.on('error', reject);
  });
  // Resolve once the guest has printed `re` — the builtin is running NOW, which
  // is the only moment an interrupt means anything.
  const awaitOutput = (re) => new Promise((resolve) => { waiters.push({ re, resolve }); check(); });
  return { writer, exited, awaitOutput };
}

test('session.interrupt() gets a busy host builtin back, and the shell survives', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins — run npm run build:wasm'); return; }
  const t0 = Date.now();
  const { writer, exited, awaitOutput } = spawnTwin('spin; echo "rc=$?"; echo alive');
  await awaitOutput(/spin running/);
  writer.interrupt();
  const m = await exited;
  const elapsed = Date.now() - t0;
  assert.match(m.out, /rc=130/, 'the builtin saw the interrupt and reported 128+SIGINT');
  assert.match(m.out, /alive/, 'the shell ran the next command — this is not terminate()');
  assert.equal(m.code, 0, 'and exited normally');
  assert.ok(elapsed < 9000, `delivered promptly, not at the spin's own deadline (${elapsed}ms)`);
});

test('a builtin that never looks is not cancelled — interrupts are cooperative', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins — run npm run build:wasm'); return; }
  const { writer, exited, awaitOutput } = spawnTwin('deaf; echo "rc=$?"');
  await awaitOutput(/deaf running/);
  writer.interrupt();
  const m = await exited;
  assert.match(m.out, /rc=7/, 'it ran to completion; nothing stopped it from outside');
});

test('an interrupt with nothing running does not cancel the command after it', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins — run npm run build:wasm'); return; }
  // The count-not-a-flag invariant, end to end, and the reason the ring stores
  // a count at all: a ^C typed at the prompt is delivered to no one, and the
  // command typed afterwards takes a fresh baseline. A pending FLAG would be
  // read by `brief` the instant it started and answer 130 — a cancel of work
  // the user never asked to cancel.
  //
  // `read -t 1` is what removes the race: the interrupt is posted while the
  // shell is demonstrably between commands — parked on the ring with nothing
  // running — rather than possibly already inside the next one. (busybox has no
  // `sleep` applet here, and it also proves the wake does not end a timed read:
  // an interrupt is not stdin input.)
  const { writer, exited, awaitOutput } = spawnTwin('echo mark; read -t 1 _; brief; echo "rc=$?"');
  await awaitOutput(/mark/);
  writer.interrupt();                     // ^C with nothing running
  const m = await exited;
  assert.match(m.out, /rc=7/, 'brief ran to completion; it did not inherit the earlier ^C');
});

test('session.interrupt() hands the ^C to the stdin ring, not to postMessage', async () => {
  // The API a terminal integration binds, and the direction that matters: a
  // message posted to a running shell worker is not delivered, so this must go
  // through the ring writer and nowhere else.
  const { Session } = await import('../src/spawn.mjs');
  let interrupts = 0;
  const posted = [];
  const s = new Session({ addEventListener() {}, postMessage: (m) => posted.push(m) },
    { interrupt() { interrupts++; } }, false, null);
  s.interrupt();
  s.interrupt();
  assert.equal(interrupts, 2, 'each ^C is its own count — they do not coalesce');
  assert.deepEqual(posted, [], 'nothing went to the worker as a message');
});
