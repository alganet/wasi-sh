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
  const emit = (b) => { const s = dec.decode(b); out += s; parentPort.postMessage({ type: 'out', text: s }); };
  const shim = new WasiShim({
    args, env, files,
    stdout: emit,
    stderr: emit,
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
  // `live()` is output SO FAR: the winch tests below assert on what the guest
  // has printed while it is still parked, which an exit-time snapshot cannot say.
  let seen = '';
  const exited = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.type === 'exit') { resolve(m); worker.terminate(); }
      else if (m.type === 'out') seen += m.text;
    });
    worker.on('error', reject);
  });
  return { writer, exited, live: () => seen };
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

test('read -t honors timeouts over one second (whole seconds must not drop)', async () => {
  // Regression for two compounding bugs: the guest once truncated the
  // timeout to (ms % 1000) — `read -t 2` timed out instantly — and the host
  // shim waited the remaining timeout twice. 1.2s catches both: seconds
  // dropped → ~0.4s (too fast), double-wait → ~2.4s (too slow).
  const t0 = Date.now();
  const { exited } = spawnTwin('read -t 1.2 x; echo "to rc=$?"');
  const m = await exited;
  const elapsed = Date.now() - t0;
  assert.match(m.out, /to rc=/, 'read -t returned');
  assert.ok(elapsed >= 1150, `waited the full 1.2s (${elapsed}ms)`);
  assert.ok(elapsed < 2200, `did not wait the timeout twice (${elapsed}ms)`);
});

test('read -t on a PIPED fd 0 reads the pipe, not the ring (poll routes by fd type)', async () => {
  // Regression for the poll_oneoff fd-routing bug: `printf x | read -t` dup2's a
  // pipe onto fd 0, but poll keyed on `fd===0` and waited on the empty stdin ring
  // instead of the pipe — so read -t timed out (rc=142, empty) with the data
  // stranded in the pipe. Only reproduces over a LIVE ring (here); under run()'s
  // fixedInput, closed() short-circuits poll and hides it. `printf x` has no
  // newline, so read legitimately returns 1 at EOF — the bug is the empty value
  // and the full-timeout wait, not the exit code.
  const t0 = Date.now();
  const { exited } = spawnTwin('printf x | { read -t 1 v; echo "v=[$v]"; }');
  const m = await exited;
  const elapsed = Date.now() - t0;
  assert.match(m.out, /v=\[x\]/, 'the piped byte was read, not lost to a ring wait');
  assert.ok(elapsed < 600, `did not wait out the 1s timeout (${elapsed}ms)`);
});

test('tuish sub-second timer probe detects "sub" over the ring (not a 1s escape timeout)', async () => {
  // The exact probe from tuish tui.sh:_tuish_init_timing. When poll misrouted the
  // piped fd 0 it timed out → the probe reported "second" → tuish ran with a 1s
  // escape-key timeout in the browser. It must report sub-second.
  const probe = `if { echo 1 | read -r -t'0.01' -n 1 2>/dev/null ;} || `
    + `{ echo 1 | read -r -t'0.01' -k1 -u0 2>/dev/null ;}; `
    + `then echo TIMING=sub; else echo TIMING=second; fi`;
  const { exited } = spawnTwin(probe);
  const m = await exited;
  assert.match(m.out, /TIMING=sub/, 'read -t honors sub-second timeouts on a piped probe');
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

// Only meaningful on a binary built with the winsize/winch C support (compiled
// at `npm run build:wasm`); probe the module's imports so these stay green on an
// older dist/busybox.wasm instead of hanging.
const WINCH_READY = () => WebAssembly.Module.imports(wasm)
  .some((i) => i.module === 'env' && i.name === '__host_winch');

test('session.resize() synthesizes SIGWINCH and stty size reports live dims', async (t) => {
  if (!WINCH_READY()) { t.skip('dist/busybox.wasm predates the winsize/winch build — run npm run build:wasm'); return; }
  // The guest traps WINCH, prints the freshly-queried size, and exits. It idles
  // in `read -t` (a poll wait — the winch chokepoint) until the resize lands.
  const script =
    'trap \'echo "WINCH $(stty size)"; exit 0\' WINCH; '
    + 'i=0; while [ $i -lt 40 ]; do read -t 0.1 _ 2>/dev/null; i=$((i+1)); done; '
    + 'echo NOWINCH';
  const { writer, exited } = spawnTwin(script);
  await new Promise((res) => setTimeout(res, 250)); // let it reach the read loop
  writer.resize(100, 40);                            // cols=100, rows=40
  const m = await exited;
  assert.match(m.out, /WINCH 40 100/, 'trap fired and `stty size` returned the live rows cols');
});

test('a resize reaches a shell parked in a BLOCKING read', async (t) => {
  if (!WINCH_READY()) { t.skip('needs the winsize/winch build — run npm run build:wasm'); return; }
  // The idle shell, and the case the timed tests above cannot see: `read` with
  // no -t waits forever. It was delivered only when unrelated input arrived,
  // because the guest sat in fd_read while winch_dispatch lives at poll — so
  // the host now parks an untimed poll (where a resize can end the wait) and
  // reports EINTR, instead of claiming readable and letting the read block.
  const { writer, exited, live } = spawnTwin(
    "trap 'echo GOT_WINCH' WINCH; read -r x; echo \"after=[$x]\""
  );
  await new Promise((res) => setTimeout(res, 300));   // reach the blocking read
  const t0 = Date.now();
  writer.resize(100, 40);
  // Wait for the trap rather than sleeping a fixed span, so `wake` is the real
  // delivery latency and not whatever the sleep was.
  while (!/GOT_WINCH/.test(live()) && Date.now() - t0 < 2000) {
    await new Promise((res) => setTimeout(res, 10));
  }
  const wake = Date.now() - t0;
  const duringPark = live();
  writer.write(enc.encode('done\n'));                 // let the guest finish
  await exited;
  assert.match(duringPark, /GOT_WINCH/, 'the trap fired while parked, with NO input written');
  assert.ok(wake < 250, `delivered promptly (${wake}ms)`);
});

test('a resize does not disturb a read in a shell with no WINCH trap', async (t) => {
  if (!WINCH_READY()) { t.skip('needs the winsize/winch build — run npm run build:wasm'); return; }
  // The other half of the same change. An untimed poll woken by a resize
  // returns EINTR, and `read` reports failure on EINTR — correct when a trap
  // asked to be told, wrong for every shell that never mentioned WINCH. The
  // guest's __wrap_poll re-parks when the dispatch reached no handler, so a
  // plain `read` must be untouched by any number of resizes.
  const { writer, exited, live } = spawnTwin('read -r x; echo "line=[$x]"');
  await new Promise((res) => setTimeout(res, 250));
  writer.resize(100, 40);
  writer.resize(70, 20);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(live(), '', 'the read is still parked — no early return, no output');
  writer.write(enc.encode('hello\n'));
  const m = await exited;
  assert.match(m.out, /line=\[hello\]/, 'the read got its line, whole, after two resizes');
});

test('repeated resizes each fire (bb_got_signal is cleared, no read -t spin)', async (t) => {
  if (!WINCH_READY()) { t.skip('needs the winsize/winch build — run npm run build:wasm'); return; }
  // The first synthesized WINCH set libbb's bb_got_signal; if it isn't cleared,
  // every later `read -t` short-circuits to EINTR and the loop busy-spins — so
  // only the first resize would ever be seen. This asserts all three land, live.
  const { writer, exited } = spawnTwin(
    'n=0; trap \'n=$((n+1)); echo "R$n=$(stty size)"; [ $n -ge 3 ] && exit 0\' WINCH; '
    + 'i=0; while [ $i -lt 100 ]; do read -t 0.1 _ 2>/dev/null; i=$((i+1)); done; echo TIMEOUT'
  );
  await new Promise((res) => setTimeout(res, 200));
  writer.resize(100, 40); await new Promise((res) => setTimeout(res, 200));
  writer.resize(70, 20);  await new Promise((res) => setTimeout(res, 200));
  writer.resize(120, 50); const m = await exited;
  assert.match(m.out, /R1=40 100/, 'first resize');
  assert.match(m.out, /R2=20 70/,  'second resize (would be lost to the spin without the fix)');
  assert.match(m.out, /R3=50 120/, 'third resize');
});
