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

// A Worker global stand-in: deliver a message, read back whatever was posted.
// A LIST of handlers, not one: a serve() module may listen for messages of its
// own (a SharedArrayBuffer for serve({ fs }) is the case that needs it), so
// "who gets this message" is exactly what the last three cases below are about.
function fakeSelf() {
  const posted = [];
  const handlers = [];
  globalThis.self = {
    addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
    postMessage(m) { posted.push(m); },
  };
  return {
    posted,
    deliver: (data) => Promise.all(handlers.map((fn) => fn({ data }))),
  };
}

// Import worker.mjs fresh each time: `config`/`started` are module state, and a
// cached module would leak one test's builtins into the next.
async function loadWorker() {
  return import(`../src/worker.mjs?t=${Math.random()}`);
}

// The example worker modules import the CANONICAL src/worker.mjs and call
// serve() on it at import time, so that instance registers a listener on
// whichever `self` is live when they load. Give them a throwaway one: a
// delivery reaching two shim instances starts two shells, and the second
// example would then find the first's copy already started.
async function loadExample(specifier) {
  fakeSelf();
  return import(specifier);
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
  const { builtins } = await loadExample('../examples/host-builtins.worker.mjs');
  const self_ = fakeSelf();
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

// Pins examples/host-port.html, the browser demo of BOTH directions of the
// port. The page itself is only verifiable by hand, but its verbs are ordinary
// functions and its dev-server loop is ordinary text — and the loop is read out
// of the page rather than copied here, so the two cannot drift.
test('the host-port example answers requests off its own filesystem', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins'); return; }
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../examples/host-port.html', import.meta.url), 'utf8');
  const script = /<script type="text\/plain" id="server-sh">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(script, 'the page still carries its server script where it says it does');

  const { host } = await loadExample('../examples/host-port.worker.mjs');
  const self_ = fakeSelf();
  const { serve } = await loadWorker();
  serve({ host });
  await self_.deliver({
    module: wasm,
    files: { '/main.sh': script[1].trim() },
    args: ['busybox', 'sh', '/main.sh'],
    env: { PATH: '/', HOME: '/', LC_ALL: 'C' },
    stdin: new Uint8Array(0),
    requests: new TextEncoder().encode(
      'GET /\nGET /time\nPUT /write from the page\nGET /notes\nGET /nope\n'),
  });

  const r = collect(self_.posted);
  const replies = self_.posted.filter((m) => m.type === 'response');
  assert.equal(replies.length, 5, 'every request was answered, through the outbound half');
  assert.deepEqual(replies.map((m) => m.status), [200, 200, 200, 200, 404]);
  assert.match(replies[1].body, /^the page says \S/, 'a verb the SCRIPT called, answered by the page');
  // The point of topology A: the guest serving requests owns the files, so a
  // write by one request is simply there for the next one.
  assert.equal(replies[3].body, '/srv/notes.txt says: from the page');
  assert.match(replies[4].body, /no route for \/nope/);
  assert.match(r.stdout, /server: listening\n/);
  assert.match(r.stdout, /server: no more requests, stopping\n/, 'EOF is what ends the loop');
  assert.equal(r.stderr, '');
  assert.equal(r.exitCode, 0);
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

// ─── whose message is it ─────────────────────────────────────────────────────
// A worker module has one `message` event and two things want it: this shim's
// startup message, and whatever the module itself is waiting for. Until the
// shim learned to tell them apart, the second could not exist — every message
// was read as the startup message, which is what these three pin.

test('a message carrying no wasm is left for the module’s own listener', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins'); return; }
  const self_ = fakeSelf();
  const { serve } = await loadWorker();
  serve({});
  const seen = [];
  self.addEventListener('message', (e) => { if (e.data.kind === 'mine') seen.push(e.data); });

  await self_.deliver({ kind: 'mine', payload: 42 });
  assert.deepEqual(seen, [{ kind: 'mine', payload: 42 }], 'the module’s listener got it');
  assert.deepEqual(self_.posted, [], 'and the shim said nothing about a message that was not its own');

  await self_.deliver({
    module: wasm,
    files: { '/main.sh': 'echo still-starts' },
    args: ['busybox', 'sh', '/main.sh'],
    env: { PATH: '/', HOME: '/', LC_ALL: 'C' },
    stdin: new Uint8Array(0),
  });
  const r = collect(self_.posted);
  assert.equal(r.stdout, 'still-starts\n', 'the real startup message still starts the shell');
  assert.equal(r.exitCode, 0);
});

// The shape a shared filesystem arrives in, and the reason the case above
// exists. A store is a live object, so it cannot be structured-cloned into a
// worker any more than a builtin can — what crosses is the SharedArrayBuffer
// behind it, as an ordinary message, and serve({ fs }) waits on it.
test('serve({ fs }) can wait on a buffer the page posts', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins'); return; }
  const { memoryFs } = await import('../src/fs.mjs');
  const self_ = fakeSelf();
  const { serve } = await loadWorker();

  let handOver;
  const handed = new Promise((res) => { handOver = res; });
  self.addEventListener('message', (e) => { if (e.data.type === 'store') handOver(e.data.sab); });
  serve({
    async fs() {
      const sab = await handed;
      return memoryFs({ '/shared.txt': new Uint8Array(sab).slice() });
    },
  });

  const sab = new SharedArrayBuffer(6);
  new Uint8Array(sab).set(new TextEncoder().encode('shared'));
  await self_.deliver({ type: 'store', sab });
  await self_.deliver({
    module: wasm,
    files: {},
    args: ['busybox', 'sh', '-c', 'cat /shared.txt'],
    env: { PATH: '/', HOME: '/', LC_ALL: 'C' },
    stdin: new Uint8Array(0),
  });
  const r = collect(self_.posted);
  assert.equal(r.stdout, 'shared');
  // The half that decides whether this shape is usable at all: an error posted
  // for the handoff rejects spawn()'s ready before the shell is even reached,
  // so the session the page is waiting on never arrives.
  assert.equal(r.error, undefined, 'the handoff was not reported as a failure');
});

test('a second startup message is refused, not started', async (t) => {
  if (!HOSTB_READY()) { t.skip('dist/busybox.wasm predates host builtins'); return; }
  const self_ = fakeSelf();
  const { serve } = await loadWorker();
  serve({});
  const startup = {
    module: wasm,
    files: { '/main.sh': 'echo once' },
    args: ['busybox', 'sh', '/main.sh'],
    env: { PATH: '/', HOME: '/', LC_ALL: 'C' },
    stdin: new Uint8Array(0),
  };
  await self_.deliver(startup);
  await self_.deliver(startup);
  const r = collect(self_.posted);
  assert.equal(r.stdout, 'once\n', 'one guest, one run');
  assert.equal(self_.posted.filter((m) => m.type === 'exit').length, 1);
  assert.match(r.error, /already has one/);
});
