// Host builtins that AWAIT, and the namespace that can change while they do.
//
// Both halves of JSPI are exercised end to end through a real busybox: the
// suspending import and the promising export. What is being pinned is not that
// `await` works — it is that a suspension crosses ash's own frames intact, so
// `$?`, a $(...) capture, a pipeline stage and a redirect all still mean what
// they meant. Those are the places ash uses setjmp/longjmp, and they are the
// reason this could have failed.
//
// It runs itself under `--experimental-wasm-jspi` when the parent node had no
// JSPI, rather than skipping: a suite nobody runs by default is a suite that is
// not there, and the flag is the only thing standing between this engine and
// the feature. An engine that refuses the flag skips and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../src/run.mjs';
import { builtinRegistry } from '../src/options.mjs';

const JSPI = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
const FLAG = '--experimental-wasm-jspi';
const RELAUNCHED = process.env.WASI_SH_JSPI_CHILD === '1';

// The whole file, one level down, with the flag on. Guarded against a node
// that has never heard of it — the flag is rejected before any test runs, so
// the child's failure is indistinguishable from a real one without this check.
if (!JSPI && !RELAUNCHED) {
  const known = spawnSync(process.execPath, [FLAG, '-p', '1'], { encoding: 'utf8' }).status === 0;
  test(`suspending host builtins (relaunched with ${FLAG})`, { skip: known ? false : `this node does not accept ${FLAG}` }, () => {
    const child = spawnSync(process.execPath, [FLAG, '--test', fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...process.env, WASI_SH_JSPI_CHILD: '1' },
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
}

const only = { skip: JSPI ? false : 'no JSPI in this process' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A script over builtins that await, with suspension turned on. */
const shell = (script, builtins) => run({ script, builtins, suspendable: true, inline: true });

test('a handler may await, and its status still becomes $?', only, async () => {
  const slow = async (ctx) => {
    await sleep(5);
    ctx.stdout(`slow:${ctx.argv[1]}\n`);
    return ctx.argv[1] === 'fail' ? 3 : 0;
  };
  const ok = await shell('slow one; echo "status=$?"', { slow });
  assert.equal(ok.stdout, 'slow:one\nstatus=0\n');
  const bad = await shell('slow fail; echo "status=$?"', { slow });
  assert.equal(bad.stdout, 'slow:fail\nstatus=3\n');
});

// The four places ash's own setjmp/longjmp handling is live. A suspension that
// did not survive them would show up here and nowhere else.
test('a suspension survives the shell frames it happens inside', only, async () => {
  const slow = async (ctx) => { await sleep(5); ctx.stdout(`slow:${ctx.argv[1] || ''}\n`); return 0; };
  const fail = async () => { await sleep(5); return 7; };
  const b = { slow, fail };

  const captured = await shell('out=$(slow sub); echo "got=[$out]"', b);
  assert.equal(captured.stdout, 'got=[slow:sub]\n');

  const piped = await shell('slow pipe | tr a-z A-Z', b);
  assert.equal(piped.stdout, 'SLOW:PIPE\n');

  const redirected = await shell('slow redir > /tmp/o.txt; cat /tmp/o.txt', b);
  assert.equal(redirected.stdout, 'slow:redir\n');

  const recovered = await shell('fail || echo recovered', b);
  assert.equal(recovered.stdout, 'recovered\n');

  const inFunction = await shell('f() { slow infn; }; f; echo "status=$?"', b);
  assert.equal(inFunction.stdout, 'slow:infn\nstatus=0\n');
});

test('a rejected handler fails the command and not the shell', only, async () => {
  const boom = async () => { await sleep(1); throw new Error('nope'); };
  const result = await shell('boom; echo "status=$?"; echo alive', { boom });
  assert.equal(result.stdout, 'status=1\nalive\n');
  assert.match(result.stderr, /boom: nope/);
});

test('a synchronous handler is unchanged by suspension being available', only, async () => {
  const now = (ctx) => { ctx.stdout('now\n'); return 0; };
  const result = await shell('now; echo "status=$?"', { now });
  assert.equal(result.stdout, 'now\nstatus=0\n');
});

// The point of the whole exercise: a command that did not exist when the shell
// started, defined by a handler that went away and awaited something first.
test('a handler can define a command, and the shell can then run it', only, async () => {
  const registry = builtinRegistry();
  registry.define('load', async (ctx) => {
    await sleep(5);
    registry.define('loaded', (inner) => { inner.stdout('here\n'); return 0; });
    ctx.stdout('loaded\n');
    return 0;
  });
  const result = await run({
    script: 'loaded 2>/dev/null || echo "before=$?"\nload\nloaded\necho "after=$?"',
    builtins: registry,
    suspendable: true,
    inline: true,
  });
  assert.equal(result.stdout, 'before=127\nloaded\nhere\nafter=0\n');
});

test('a command can be removed, and stops being one', only, async () => {
  const registry = builtinRegistry({ gone: (ctx) => { ctx.stdout('still here\n'); return 0; } });
  registry.define('unload', () => { registry.remove('gone'); return 0; });
  const result = await run({
    script: 'gone\nunload\ngone 2>/dev/null\necho "after=$?"',
    builtins: registry,
    suspendable: true,
    inline: true,
  });
  assert.equal(result.stdout, 'still here\nafter=127\n');
});

