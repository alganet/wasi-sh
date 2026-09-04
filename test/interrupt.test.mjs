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

const imported = (name) => WebAssembly.Module.imports(wasm)
  .some((i) => i.module === 'env' && i.name === name);
const HOSTB_READY = () => imported('__host_builtin_run');
// The applet half is a second, later hook: a wasm that predates it answers
// nothing at a safe point, so those tests would sit at their deadline rather
// than skip. Gate them on the import they actually need.
const INTR_READY = () => imported('__host_interrupt');

// The node twin of src/worker.mjs, with three host builtins. `spin` is a
// runtime that will not stop on its own — the showstopper case from MOAR §4.4,
// one while(true) in a script. `brief` is the same loop on a short budget, so a
// command that is NOT interrupted still ends the test. `deaf` ignores the
// interrupt entirely and must not be cancelled: interrupts are cooperative, and
// a transport that could stop work which never opted in would be terminate().
// `peek` reports what the SIGNAL CELL held the moment it was dispatched — the
// other half of raise(), which no ctx method exposes because the guests that
// read it read memory rather than calling anything.
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
  const reader = new RingReader(sab);
  const shim = new WasiShim({
    args, env, files,
    stdout: emit,
    stderr: emit,
    input: reader.toInput(),
    builtins: {
      lookup: (n) => n === 'spin' || n === 'brief' || n === 'deaf' || n === 'peek',
      run: (ctx) => {
        const name = ctx.argv[0];
        // Read FIRST, before anything else this command does: the question is
        // what the cell held on the way in.
        if (name === 'peek') { ctx.stdout('sig=' + reader.signalBuffer()[0] + '\\n'); return 0; }
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

function spawnTwin(script, files = {}) {
  const sab = createRing();
  const writer = new RingWriter(sab);
  const worker = new Worker(TWIN, {
    eval: true,
    workerData: {
      module: wasm,
      files: { ...files, '/t.sh': script },
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
  // The applet tests below run commands that do not stop on their own — that is
  // the whole point of them — so an undelivered interrupt is a HANG, and a test
  // that hangs reports nothing. Bound it here rather than in each test.
  const finish = async (ms = 8000) => {
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r(null), ms); });
    const m = await Promise.race([exited, late]);
    clearTimeout(timer);
    if (m === null) { worker.terminate(); assert.fail(`no interrupt was delivered within ${ms}ms — the command still holds the guest`); }
    return m;
  };
  return { writer, exited, awaitOutput, finish };
}

// The cue-then-post shape every "was it interrupted" test below shares. The
// count is read when the applet STARTS, so an interrupt only means something if
// it is posted after that — `echo` is an ash builtin and runs before the applet
// exists, and the round trip through the parent's event loop takes far longer
// than the shell needs to reach the next command. The extra pause makes that
// ordering a margin rather than an argument.
async function interruptOnce(twin) {
  await twin.awaitOutput(/^go$/m);
  await new Promise((r) => setTimeout(r, 30));
  twin.writer.interrupt();
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

test('an interrupt with nothing running does not arm the command after it', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins — run npm run build:wasm'); return; }
  // The same invariant as above, for the OTHER half of raise(). The count is a
  // baseline, so it was always honest; the signal cell is a byte a guest reads
  // out of memory, and nothing cleared it. So a ^C typed at an idle prompt sat
  // in the cell until some later command's runtime happened to look — and read
  // it as its own. Measured in wide: `^C` at the prompt, then `python foo.py`
  // came straight back with 130 and no output, and the next page the frame
  // asked for was a 500 with a KeyboardInterrupt in the log.
  //
  // `read -t 1` for the reason the count's test uses it: the interrupt lands
  // while the shell is demonstrably between commands.
  const { writer, exited, awaitOutput } = spawnTwin('echo mark; read -t 1 _; peek');
  await awaitOutput(/mark/);
  writer.interrupt();                     // ^C with nothing running
  const m = await exited;
  assert.match(m.out, /sig=0/, 'peek started on a clear cell; it did not inherit the earlier ^C');
});

test('a signal raised DURING a command still reaches the cell', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins — run npm run build:wasm'); return; }
  // The clear above must not become a deaf ear. `spin` holds the guest, the ^C
  // is written while it holds it, and `peek` — dispatched after — is a fresh
  // command that must see a clear cell again.
  const { writer, exited, awaitOutput } = spawnTwin('spin; echo "rc=$?"; peek');
  await awaitOutput(/spin running/);
  writer.interrupt();
  const m = await exited;
  assert.match(m.out, /rc=130/, 'the ^C landed on the command that was running');
  assert.match(m.out, /sig=0/, 'and was spent there, not left for the next one');
});

// ---- the applet half: the same count, read by the guest itself -------------
// A host builtin opts in by calling ctx.interrupted(). An applet cannot: it is
// busybox's code, not the embedder's. So the safe points are the shim's —
// wrapped read/write/readv/writev, plus the two applet loops that can spin
// without touching a descriptor — and the bail is die_func, the longjmp
// run_nofork_applet already installs for a dying xfunc. Each of these is a
// command that does NOT stop on its own; against the previous binary every one
// of them runs to its own end and answers something other than 130.

test('an applet writing through stdio is interrupted, and the shell survives', async (t) => {
  if (!INTR_READY()) { t.skip('dist/busybox.wasm predates the applet interrupt — run npm run build:wasm'); return; }
  // seq goes out through printf, so this is the writev path: wasi-libc's
  // __stdio_write calls writev, and wrapping write alone would leave every
  // applet that printf()s uninterruptible.
  const twin = spawnTwin('echo go; seq 1 2000000000 > /dev/null; echo "rc=$?"; echo alive');
  await interruptOnce(twin);
  const m = await twin.finish();
  assert.match(m.out, /rc=130/, 'the applet bailed at a safe point with 128+SIGINT');
  assert.match(m.out, /alive/, 'the shell ran the next command — this is not terminate()');
  assert.equal(m.code, 0, 'and exited normally');
});

test('an applet reading through libbb is interrupted', async (t) => {
  if (!INTR_READY()) { t.skip('dist/busybox.wasm predates the applet interrupt — run npm run build:wasm'); return; }
  // cat copies with safe_read/full_write rather than stdio, so this is the
  // read/write pair. Bounded work rather than an endless command on purpose: a
  // build where the wrap did not take answers rc=0 in a few seconds and says
  // so, which is a better failure than the deadline expiring.
  const big = new Uint8Array(4 * 1024 * 1024).fill(0x61);
  const twin = spawnTwin(`echo go; cat ${'/big '.repeat(2000)}> /dev/null; echo "rc=$?"; echo alive`, { '/big': big });
  await interruptOnce(twin);
  const t0 = Date.now();
  const m = await twin.finish();
  assert.match(m.out, /rc=130/, 'the copy loop stopped at its next read');
  assert.match(m.out, /alive/, 'and the shell kept its filesystem and its next command');
  assert.ok(Date.now() - t0 < 2000, 'it stopped where it was, not at the end of 8 GB');
});

test("what an interrupted applet had buffered goes where the applet was writing", async (t) => {
  if (!INTR_READY()) { t.skip('dist/busybox.wasm predates the applet interrupt — run npm run build:wasm'); return; }
  // The bail is a longjmp past the flush, and a shell's redirections are popped
  // when the command returns — so buffered output left for later is written
  // into whatever the NEXT command has on fd 1. Up to a full stdio block of
  // `seq` digits landed in `/b.txt` in place of `hi`, and on the terminal in
  // place of nothing.
  const twin = spawnTwin(
    'echo go; seq 1 2000000000 > /a.txt; echo "rc=$?"; echo hi > /b.txt; cat /b.txt; echo alive');
  await interruptOnce(twin);
  const m = await twin.finish();
  assert.match(m.out, /rc=130/);
  assert.match(m.out, /^hi$/m, '/b.txt is what the command after the ^C put there');
  assert.equal(/[0-9]{4,}/.test(m.out), false, `no digits leaked onto the terminal: ${JSON.stringify(m.out)}`);
});

// There is no test for bb_intr_done()'s other half — the window between an
// applet RETURNING and the flush that delivers what it buffered, where a ^C
// would turn a command that had already finished into a 130. It is a handful of
// instructions wide and nothing on this side can aim at it; the guard costs one
// store and the failure it prevents is a wrong answer, which is the trade that
// decides it.

test("awk's interpreter loop is a safe point of its own", async (t) => {
  if (!INTR_READY()) { t.skip('dist/busybox.wasm predates the applet interrupt — run npm run build:wasm'); return; }
  // The motivating case, and the one the wrapped descriptors cannot reach: a
  // loop that never touches one. awk prints its own cue and flushes it, because
  // stdout here is not a tty and stdio would otherwise hold the line.
  const twin = spawnTwin(`awk 'BEGIN { print "go"; fflush(); for (;;) i++ }'; echo "rc=$?"; echo alive`);
  await interruptOnce(twin);
  const m = await twin.finish();
  assert.match(m.out, /rc=130/, 'the interpreter checked between two statements');
  assert.match(m.out, /alive/, 'and the shell survived it');
});

test("sed's branch target is a safe point of its own", async (t) => {
  if (!INTR_READY()) { t.skip('dist/busybox.wasm predates the applet interrupt — run npm run build:wasm'); return; }
  // `b` with no label jumps to the end of the script and starts the cycle over
  // without reading a line or printing one — the second loop in this build that
  // no descriptor sees.
  const twin = spawnTwin(`echo go; printf 'x\\n' | sed ':a;ba'; echo "rc=$?"; echo alive`);
  await interruptOnce(twin);
  const m = await twin.finish();
  assert.match(m.out, /rc=130/, 'the cycle stopped at its branch target');
  assert.match(m.out, /alive/, 'and the shell survived it');
});

test('an interrupt with nothing running does not cancel the applet after it', async (t) => {
  if (!INTR_READY()) { t.skip('dist/busybox.wasm predates the applet interrupt — run npm run build:wasm'); return; }
  // The count-not-a-flag invariant again, one layer down: the applet takes its
  // baseline when run_nofork_applet enters, so a ^C already in the count is one
  // it was never sent. `read -t 1` puts the shell demonstrably between commands
  // while the interrupt is posted.
  const twin = spawnTwin('echo mark; read -t 1 _; seq 1 3; echo "rc=$?"');
  await twin.awaitOutput(/mark/);
  twin.writer.interrupt();
  const m = await twin.finish();
  assert.match(m.out, /1\n2\n3\n/, 'seq ran in full');
  assert.match(m.out, /rc=0/, 'and did not inherit the earlier ^C');
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
