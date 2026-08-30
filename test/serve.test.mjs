// serve(): the worker-side registration path, driven headlessly.
//
// A dedicated Worker's globals are just `self.addEventListener` and
// `self.postMessage`, so stubbing those drives the REAL src/worker.mjs — no
// hand-copied twin to drift. node --test gives each file its own process, so
// installing a global `self` here is contained.
//
// This is the only route by which host builtins reach a browser session, and
// until now worker.mjs had no coverage at all.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { compileWasm } from '../src/node.mjs';

let wasm;
before(async () => { wasm = await compileWasm(); });

const HOSTB_READY = () => WebAssembly.Module.imports(wasm)
  .some((i) => i.module === 'env' && i.name === '__host_builtin_run');

// A Worker global stand-in. Returns the module's message handler plus whatever
// it posted back.
function fakeSelf() {
  const posted = [];
  let onMessage;
  globalThis.self = {
    addEventListener(type, fn) { if (type === 'message') onMessage = fn; },
    postMessage(m) { posted.push(m); },
  };
  return { posted, deliver: (data) => onMessage({ data }) };
}

// Import worker.mjs fresh each time: `config`/`started` are module state, and a
// cached module would leak one test's builtins into the next.
async function loadWorker() {
  return import(`../src/worker.mjs?t=${Math.random()}`);
}

const dec = new TextDecoder();
function collect(posted) {
  const out = { stdout: '', stderr: '' };
  for (const m of posted) if (m.type === 'out') out[m.channel] += dec.decode(new Uint8Array(m.bytes));
  const exit = posted.find((m) => m.type === 'exit');
  const err = posted.find((m) => m.type === 'error');
  return { ...out, exitCode: exit ? exit.code : undefined, error: err && err.msg };
}

async function runInWorker(script, options, message = {}) {
  const self_ = fakeSelf();
  const { serve } = await loadWorker();
  serve(options);
  await self_.deliver({
    module: wasm,
    files: { '/main.sh': script },
    args: ['busybox', 'sh', '/main.sh'],
    env: { PATH: '/', HOME: '/', LC_ALL: 'C' },
    stdin: new Uint8Array(0),
    ...message,
  });
  return collect(self_.posted);
}

test('serve() registers builtins for the worker’s shell', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins — run npm run build:wasm'); return; }
  const r = await runInWorker('hi there; echo "rc=$?"', {
    builtins: { hi: (ctx) => { ctx.stdout(`hi ${ctx.argv[1]}\n`); return 0; } },
  });
  assert.equal(r.stdout, 'hi there\nrc=0\n');
  assert.equal(r.exitCode, 0);
});

// The reason the factory form exists: boot the expensive thing ONCE, before
// _start(), so every invocation afterwards can be synchronous.
test('serve(): an async builtins() factory is awaited before the shell starts', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins'); return; }
  let boots = 0;
  const r = await runInWorker('n; n; n', {
    async builtins() {
      boots++;
      await new Promise((res) => setTimeout(res, 5));
      const engine = { greet: () => 'warm' };
      return { n: (ctx) => { ctx.stdout(`${engine.greet()}\n`); return 0; } };
    },
  });
  assert.equal(r.stdout, 'warm\nwarm\nwarm\n');
  assert.equal(boots, 1, 'setup runs once, not per command');
});

test('serve(): a failing factory surfaces as an error, not a hang', async () => {
  const self_ = fakeSelf();
  const { serve } = await loadWorker();
  serve({ builtins: async () => { throw new Error('engine did not boot'); } });
  await self_.deliver({
    module: wasm, files: { '/main.sh': 'echo hi' },
    args: ['busybox', 'sh', '/main.sh'], env: {}, stdin: new Uint8Array(0),
  });
  const r = collect(self_.posted);
  assert.match(r.error, /engine did not boot/);
  assert.match(r.error, /serve\(\{ builtins \}\)/, 'names the option that failed');
});

// Calling serve() after the startup message means its builtins were ignored —
// the silent-failure mode the synchronous-call rule exists to prevent.
test('serve(): calling it too late throws and reports, instead of failing quietly', async () => {
  const self_ = fakeSelf();
  const { serve } = await loadWorker();
  await self_.deliver({
    module: wasm, files: { '/main.sh': 'echo hi' },
    args: ['busybox', 'sh', '/main.sh'], env: {}, stdin: new Uint8Array(0),
  });
  assert.throws(() => serve({ builtins: { x: () => 0 } }), /before any top-level await/);
  assert.ok(self_.posted.some((m) => m.type === 'error' && /serve\(\)/.test(m.msg)),
    'also posted so the page sees a failure rather than a shell missing its builtins');
});

test('serve() with no builtins is just the default worker', async () => {
  const r = await runInWorker('echo plain', {});
  assert.equal(r.stdout, 'plain\n');
  assert.equal(r.exitCode, 0);
});

// Pins examples/host-builtins.html: the page is only manually verifiable in a
// browser, but its handlers are ordinary functions and can be checked here.
test('the host-builtins example composes json and num in a pipeline', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins'); return; }
  const self_ = fakeSelf();          // the example calls serve() at import time
  const { builtins } = await import('../examples/host-builtins.worker.mjs');
  const { serve } = await loadWorker();
  serve({ builtins });
  await self_.deliver({
    module: wasm,
    files: {
      '/data/repo.json': JSON.stringify({ name: 'wasi-sh', stars: 1234567 }),
      '/main.sh': 'json name /data/repo.json\n'
        + 'json stars /data/repo.json | num\n'
        + 'json stars /data/repo.json | LANG=de-DE num\n'
        + 'type json\n'
        + 'json nope /data/repo.json; echo "exit=$?"\n',
    },
    args: ['busybox', 'sh', '/main.sh'],
    env: { PATH: '/', HOME: '/', LANG: 'C.UTF-8' },   // the wasi-sh default
    stdin: new Uint8Array(0),
  });
  const r = collect(self_.posted);
  assert.equal(r.stdout,
    'wasi-sh\n'
    + '1,234,567\n'
    + '1.234.567\n'
    + 'json is a host builtin\n'
    + 'exit=1\n');
  assert.match(r.stderr, /no such path: nope/);
});

// A store is a live object, so like builtins it can only be registered from
// inside the worker — structured clone would arrive with the methods stripped.
// This is the only route by which a real filesystem (OPFS, a directory the
// user granted) reaches a browser session.
test('serve({ fs }) puts the worker’s shell on the given store', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins'); return; }
  const { memoryFs } = await import('../src/fs.mjs');
  const store = memoryFs({ '/seed.txt': 'from the store\n' });
  const r = await runInWorker('cat /seed.txt; echo written > /out.txt', { fs: store });
  assert.equal(r.stdout, 'from the store\n');
  const out = new Uint8Array(store.statSync('/out.txt').size);
  store.readSync('/out.txt', out, 0, out.length);
  assert.equal(dec.decode(out), 'written\n', 'the guest wrote into the caller’s store');
});

// Same reason the builtins factory exists: opening OPFS or asking for a
// directory handle is async, and it has to finish before _start().
test('serve({ async fs() }) is awaited before the shell starts', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins'); return; }
  const { memoryFs } = await import('../src/fs.mjs');
  let opens = 0;
  const r = await runInWorker('cat /late.txt', {
    async fs() {
      opens++;
      await new Promise((res) => setTimeout(res, 5));
      return memoryFs({ '/late.txt': 'opened in time\n' });
    },
  });
  assert.equal(opens, 1, 'opened once, up front');
  assert.equal(r.stdout, 'opened in time\n');
});

// ─── the inbound host-port channel ───────────────────────────────────────────
// Both transports reach the shell through this module, and this is the browser
// path for both: run() posts a staged queue, spawn() posts a second ring.

test('a staged request queue reaches the shell as /dev/hostreq', async () => {
  const r = await runInWorker(
    'while read -r req <&3; do echo "handling [$req]"; done 3< /dev/hostreq\necho loop-ended\n',
    {},
    { requests: new TextEncoder().encode('GET /a.php\nGET /b.php\n') },
  );
  assert.equal(r.stdout, 'handling [GET /a.php]\nhandling [GET /b.php]\nloop-ended\n');
});

// Nothing posted, so the guest reads its whole queue and hits EOF at once —
// what matters here is that the RING is what it read, not a staged buffer.
test('a request ring reaches it too, and an ended one ends the loop', async () => {
  const { createRing, RingWriter, frameRequest } = await import('../src/ring.mjs');
  const reqSab = createRing(4096);
  const writer = new RingWriter(reqSab);
  writer.write(frameRequest('GET /from-the-ring'));
  writer.end();
  const r = await runInWorker(
    'while read -r req <&3; do echo "handling [$req]"; done 3< /dev/hostreq\necho loop-ended\n',
    {},
    { reqSab },
  );
  assert.equal(r.stdout, 'handling [GET /from-the-ring]\nloop-ended\n');
});

// Capabilities are injected, never ambient: neither transport, no channel.
test('with neither transport the device is refused', async () => {
  const r = await runInWorker("{ read -r req <&3; } 3< /dev/hostreq 2>/dev/null || echo 'not granted'\n", {});
  assert.equal(r.stdout, 'not granted\n');
});
