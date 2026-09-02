// A guest that suspends when it has nothing to READ, and the thread it stops
// owning while it waits.
//
// `suspendable` (see ./suspend.test.mjs) lets a host builtin await — the guest
// suspends on its way OUT. This is the other direction and the one a terminal
// needs: the guest suspends while it waits for a key. Without it a shell that
// draws its own prompt parks the worker thread in `Atomics.wait` between
// keystrokes, and everything else in that worker stops with it — a message
// from the page, a timer, a builtin somebody wanted to call. With it the shell
// owns the line AND the worker stays reachable, which is the pair that makes
// an in-guest terminal possible at all.
//
// Same relaunch trick as ./suspend.test.mjs, for the same reason: the flag is
// the only thing between this engine and the feature, so the suite turns it on
// rather than skipping itself.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStdinRing, RingWriter } from '../src/ring.mjs';
import { compileWasm } from '../src/node.mjs';

const JSPI = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
const FLAG = '--experimental-wasm-jspi';
const RELAUNCHED = process.env.WASI_SH_JSPI_CHILD === '1';

if (!JSPI && !RELAUNCHED) {
  const known = spawnSync(process.execPath, [FLAG, '-p', '1'], { encoding: 'utf8' }).status === 0;
  test(`suspending input (relaunched with ${FLAG})`, { skip: known ? false : `this node does not accept ${FLAG}` }, () => {
    const child = spawnSync(process.execPath, [FLAG, '--test', fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...process.env, WASI_SH_JSPI_CHILD: '1' },
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
}

const only = { skip: JSPI ? false : 'no JSPI in this process' };

// Every shell this file starts, torn down whether its test passed or not. A
// failing assertion skips whatever cleanup follows it, and a live Worker keeps
// node's runner from ever exiting — so one broken expectation used to hang the
// suite instead of failing it.
const live = new Set();
afterEach(async () => {
  for (const worker of live) await worker.terminate();
  live.clear();
});
/** A dist/busybox.wasm old enough to lack the winsize hooks cannot be resized. */
const winchReady = () => WebAssembly.Module.imports(wasm)
  .some((i) => i.module === 'env' && i.name === '__host_winch');
const enc = new TextEncoder();
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const screen = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

let wasm;

// A worker running one shell, with a HEARTBEAT on its own event loop. The beat
// is the instrument: it counts only while the thread is free, so it answers
// "did the guest give the thread back" with a number rather than a feeling.
const TWIN = `
  import { parentPort, workerData } from 'node:worker_threads';
  const { WasiShim, WasiExit } = await import(workerData.shimUrl);
  const { RingReader } = await import(workerData.ringUrl);
  const { module, args, sab, tty, suspendInput } = workerData;
  let beats = 0;
  const beat = setInterval(() => { beats++; }, 10);
  let out = '';
  const dec = new TextDecoder();
  const emit = (b) => { out += dec.decode(b); };
  parentPort.on('message', (m) => {
    if (m === 'poll') parentPort.postMessage({ type: 'poll', beats, out });
  });
  const shim = new WasiShim({
    args, env: { PATH: '/', LC_ALL: 'C' }, files: {},
    stdout: emit, stderr: emit,
    input: new RingReader(sab).toInput(),
    tty, suspendable: true, suspendInput,
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  parentPort.postMessage({ type: 'mode', on: shim.suspendInput });
  let code = 0;
  try {
    if (shim.suspendable) await WebAssembly.promising(instance.exports._start)();
    else instance.exports._start();
  } catch (e) { if (e instanceof WasiExit) code = e.code; else throw e; }
  clearInterval(beat);
  parentPort.postMessage({ type: 'exit', code, out });
`;

/** A shell on a real ring, plus a way to ask the worker whether it can answer. */
function shell({ suspendInput = true, tty = true, args = ['busybox', 'sh'] } = {}) {
  const sab = createStdinRing();
  const writer = new RingWriter(sab);
  // Geometry through the RING and never the environment — busybox's `stty size`
  // prefers COLUMNS/LINES when they exist and would then report that frozen
  // value forever, so a resize could never be seen. spawn() seeds it and drops
  // them for exactly this reason; this twin does the same by hand.
  writer.seedWinsize(80, 24);
  const worker = new Worker(TWIN, {
    eval: true,
    workerData: {
      module: wasm, args, sab, tty, suspendInput,
      shimUrl: new URL('../src/shim.mjs', import.meta.url).href,
      ringUrl: new URL('../src/ring.mjs', import.meta.url).href,
    },
  });
  live.add(worker);
  const state = { mode: null, out: '', exited: false };
  worker.on('message', (m) => {
    if (m.type === 'mode') state.mode = m.on;
    else if (m.type === 'exit') { state.out = m.out; state.exited = true; }
  });
  // Answered only if the worker's event loop is free to answer, which is the
  // property under test — so it times out rather than hanging the suite.
  const poll = () => new Promise((res) => {
    const t = setTimeout(() => { worker.off('message', h); res(null); }, 1500);
    const h = (m) => { if (m.type === 'poll') { clearTimeout(t); worker.off('message', h); res(m); } };
    worker.on('message', h);
    worker.postMessage('poll');
  });
  return { writer, worker, state, poll, type: (s) => writer.write(enc.encode(s)) };
}

test('a busybox to run these against', only, async () => { wasm = await compileWasm(); });

test('a suspended guest gives the thread back: the worker still answers', only, async () => {
  const s = shell();
  await settle(900);
  assert.equal(s.state.mode, true, 'the shim took the option');
  const first = await s.poll();
  assert.ok(first, 'the worker answered while the shell sat at its prompt');
  assert.match(screen(first.out), /# $/, 'and the shell really is at a prompt');
  await settle(400);
  const second = await s.poll();
  assert.ok(second.beats > first.beats, `its timers ran too (${first.beats} -> ${second.beats})`);
});

test('without it the worker is unreachable, which is the whole problem', only, async () => {
  const s = shell({ suspendInput: false });
  await settle(900);
  assert.equal(s.state.mode, false);
  assert.equal(await s.poll(), null, 'a blocking read owns the thread; nothing else runs on it');
});

test('the guest still owns the line: prompt, echo, history', only, async () => {
  const s = shell();
  await settle(900);
  s.type('echo one');
  await settle(500);
  assert.match(screen((await s.poll()).out), /# echo one$/, 'the guest echoed its own keystrokes');
  s.type('\n');
  await settle(600);
  assert.match(screen((await s.poll()).out), /^one$/m, 'and ran it');
  s.type('\x1b[A');
  await settle(500);
  const recalled = screen((await s.poll()).out);
  assert.ok((recalled.match(/echo one/g) || []).length >= 2, `Up recalled the line: ${JSON.stringify(recalled.slice(-40))}`);
});

test('Tab still completes inside the guest', only, async () => {
  const s = shell();
  await settle(900);
  s.type('ech\t');
  await settle(700);
  assert.match(screen((await s.poll()).out), /# echo $/, 'ash completed it, not us');
});

test('a resize still reaches a guest parked in a suspended poll', only, async (t) => {
  if (!winchReady()) { t.skip('dist/busybox.wasm predates the winsize/winch build'); return; }
  const s = shell();
  await settle(900);
  s.type("trap 'echo WINCHED' WINCH\n");
  await settle(500);
  s.writer.resize(100, 30);
  await settle(500);
  s.type('stty size\n');
  await settle(700);
  const out = screen((await s.poll()).out);
  assert.match(out, /30 100/, `stty size saw the new geometry: ${JSON.stringify(out.slice(-60))}`);
});

test('read -t waits its timeout ONCE, not twice', only, async () => {
  // The regression this whole path nearly shipped with: the suspending wrapper
  // waited the timeout and then handed the poll to the synchronous
  // implementation, which waited it again — `read -t 1.2` took 2.4s. The
  // non-suspending twin of this case is in ./interactive.test.mjs; it passes
  // either way, which is exactly why this one has to exist.
  const s = shell({ tty: false, args: ['busybox', 'sh', '-c', 'read -t 1.2 x; echo "to rc=$?"'] });
  const t0 = Date.now();
  for (let i = 0; i < 60 && !s.state.exited; i++) await settle(100);
  const elapsed = Date.now() - t0;
  assert.match(s.state.out, /to rc=/, 'read -t returned');
  assert.ok(elapsed >= 1100, `waited the full 1.2s (${elapsed}ms)`);
  assert.ok(elapsed < 2200, `and only once (${elapsed}ms)`);
});
