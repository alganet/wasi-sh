// Host builtins: the normalizer, and the containment contract of the two
// env.__host_builtin_* hooks. These run against a bare WebAssembly.Memory, no
// wasm module — so they pin the JS side even when dist/busybox.wasm predates
// the feature. The end-to-end dispatch lives in scripts.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasiShim, WasiExit } from '../src/shim.mjs';
import { hostBuiltins, resolveBuiltins } from '../src/options.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// A shim with real memory but no guest: we call the imports directly, writing
// the C strings the guest would have passed.
function makeShim(builtins, files = { '/work/data.txt': 'hello' }, input) {
  const out = { stdout: [], stderr: [] };
  const shim = new WasiShim({
    builtins, files, input,
    stdout: (b) => out.stdout.push(dec.decode(b)),
    stderr: (b) => out.stderr.push(dec.decode(b)),
  });
  const memory = new WebAssembly.Memory({ initial: 2 });
  shim.bindMemory(memory);
  const env = shim.imports().env;
  const u8 = () => new Uint8Array(memory.buffer);
  // Lay out NUL-terminated strings, then a NULL-terminated char** for each
  // vector — exactly the shape host_builtin_run() passes.
  let brk = 1024;
  const cstr = (s) => { const b = enc.encode(s + '\0'); u8().set(b, brk); const p = brk; brk += b.length; return p; };
  const cstrv = (list) => {
    const ptrs = list.map(cstr);
    brk = (brk + 3) & ~3;
    const base = brk;
    const dv = new DataView(memory.buffer);
    for (const p of ptrs) { dv.setUint32(brk, p, true); brk += 4; }
    dv.setUint32(brk, 0, true); brk += 4;
    return base;
  };
  const call = (argv, envv = [], cwd = '/') =>
    env.__host_builtin_run(cstr(cwd), argv.length, cstrv(argv), envv.length ? cstrv(envv) : 0);
  return { shim, env, out, call, cstr, memory };
}

// ─── the normalizer ──────────────────────────────────────────────────────────

test('hostBuiltins: a map becomes a lookup/run provider', () => {
  const p = hostBuiltins({ hi: () => 0 });
  assert.equal(p.lookup('hi'), true);
  assert.equal(p.lookup('nope'), false);
});

test('hostBuiltins: an object with BOTH methods passes through untouched', () => {
  const provider = { lookup: () => true, run: () => 7 };
  assert.equal(hostBuiltins(provider), provider, 'dynamic namespaces must not be wrapped');
});

test('hostBuiltins: a map with a command named `run` is not mistaken for a provider', () => {
  const p = hostBuiltins({ run: () => 3 });
  assert.notEqual(typeof p.lookup, 'undefined');
  assert.equal(p.lookup('run'), true, 'it is a command called run, not a provider');
});

// Regression guard: `typeof map[name] === 'function'` without hasOwn claims
// every Object.prototype member, so `type toString` would answer yes and then
// dispatch into Object.prototype.toString.
test('hostBuiltins: inherited properties are not builtins', () => {
  const p = hostBuiltins({ hi: () => 0 });
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    assert.equal(p.lookup(name), false, `${name} must not resolve as a builtin`);
  }
});

test('hostBuiltins: an unregistered name inside a map run() is 127, not a throw', () => {
  const p = hostBuiltins({ hi: () => 0 });
  const seen = [];
  assert.equal(p.run({ argv: ['bye'], stderr: (s) => seen.push(s) }), 127);
  assert.match(seen.join(''), /bye: not found/);
});

test('resolveBuiltins: awaits a factory, so async setup happens once up front', async () => {
  let boots = 0;
  const p = await resolveBuiltins(async () => { boots++; return { hi: () => 0 }; });
  assert.equal(boots, 1);
  assert.equal(p.lookup('hi'), true);
});

test('resolveBuiltins: undefined stays undefined (capability absent by default)', async () => {
  assert.equal(await resolveBuiltins(undefined), undefined);
});

// ─── the hooks: absent capability ────────────────────────────────────────────

test('no builtins registered: lookup says no and run reports host failure', () => {
  const { env, call } = makeShim(undefined);
  assert.equal(env.__host_builtin_lookup(0, 0), 0);
  assert.equal(call(['anything']), -1, '-1 tells ash to fall back to its own error path');
});

// ─── the hooks: argv / env / cwd marshaling ──────────────────────────────────

test('argv, env and cwd cross the boundary as JS values', () => {
  let seen;
  const { call } = makeShim({ lookup: () => true, run: (ctx) => { seen = ctx; return 0; } });
  assert.equal(call(['tool', '-x', 'arg'], ['FOO=bar', 'EMPTY='], '/work/sub'), 0);
  assert.deepEqual(seen.argv, ['tool', '-x', 'arg']);
  assert.equal(seen.cwd, '/work/sub');
  assert.equal(seen.env.FOO, 'bar');
  assert.equal(seen.env.EMPTY, '', 'an empty value is still a variable');
});

test('lookup receives the name and answers without running anything', () => {
  const names = [];
  let ran = 0;
  const { env, cstr } = makeShim({ lookup: (n) => { names.push(n); return n === 'yes'; }, run: () => { ran++; return 0; } });
  assert.equal(env.__host_builtin_lookup(cstr('yes'), 3), 1);
  assert.equal(env.__host_builtin_lookup(cstr('no'), 2), 0);
  assert.deepEqual(names, ['yes', 'no']);
  assert.equal(ran, 0, '`type`/`command -v` must never execute the builtin');
});

// ─── the hooks: containment ──────────────────────────────────────────────────

// A JS exception thrown out of a wasm import unwinds the ENTIRE guest stack —
// the instance is dead and no guest setjmp can catch it. A handler bug must
// cost one command, not the session.
test('a throwing handler is contained: message to stderr, non-zero status', () => {
  const { call, out } = makeShim({ lookup: () => true, run: () => { throw new Error('boom'); } });
  assert.equal(call(['tool']), 1);
  assert.match(out.stderr.join(''), /tool: boom/);
});

test('a throwing lookup() does not kill the instance either', () => {
  const { env, cstr } = makeShim({ lookup: () => { throw new Error('nope'); }, run: () => 0 });
  assert.equal(env.__host_builtin_lookup(cstr('x'), 1), 0, 'a broken lookup means "not a builtin"');
});

// worker.mjs treats a WasiExit as a clean shutdown, so letting one escape would
// make a nested module's exit(1) silently become the outer shell's exit code.
test('a WasiExit from a nested module becomes this command’s status, not the shell’s', () => {
  const { call } = makeShim({ lookup: () => true, run: () => { throw new WasiExit(3); } });
  assert.equal(call(['tool']), 3);
});

// A thenable coerces to i32 0 at the wasm boundary: silent success, with the
// real output landing later against whatever fd 1 has become by then.
test('an async handler fails loudly instead of silently succeeding', () => {
  const { call, out } = makeShim({ lookup: () => true, run: async () => 0 });
  const rc = call(['tool']);
  assert.notEqual(rc, 0, 'must never look like success');
  assert.match(out.stderr.join(''), /must be synchronous/);
});

test('a rejected promise from an async handler does not become an unhandled rejection', async () => {
  const { call } = makeShim({ lookup: () => true, run: () => Promise.reject(new Error('later')) });
  call(['tool']);
  await new Promise((r) => setTimeout(r, 10));   // would crash the test process if unowned
});

// ─── the hooks: status normalization ─────────────────────────────────────────

test('exit status is truncated to 8 bits, like wait(2)', () => {
  const cases = [[0, 0], [1, 1], [42, 42], [255, 255], [256, 0], [300, 44], [-1, 255]];
  for (const [ret, want] of cases) {
    const { call } = makeShim({ lookup: () => true, run: () => ret });
    assert.equal(call(['tool']), want, `${ret} -> ${want}`);
  }
});

test('a handler that forgets to return is success', () => {
  const { call } = makeShim({ lookup: () => true, run: () => {} });
  assert.equal(call(['tool']), 0, 'documented: no return means 0');
});

// ─── the hooks: bounded reads from guest memory ──────────────────────────────

// A char* has no length beside it, so the walk needs a stop condition — and a
// byte budget is the wrong one. The budget was 4096, which is generous for a
// flag and nothing at all for a command line carrying an encoded payload: a
// longer argument arrived TRUNCATED and still well-formed, so the handler saw
// a shorter value rather than an error. A dev-server loop passing a request as
// one JSON argument hits it at the first modest POST body.
test('a long argument crosses whole, not truncated to a budget', () => {
  let seen;
  const big = 'x'.repeat(50000);
  const { call } = makeShim({ lookup: () => true, run: (ctx) => { seen = ctx; return 0; } });

  assert.equal(call(['tool', big], [`BIG=${big}`]), 0);
  assert.equal(seen.argv[1].length, big.length, 'an argument must not be silently shortened');
  assert.equal(seen.argv[1], big);
  assert.equal(seen.env.BIG, big, 'an environment value is the same char* walk');
});

// The other half of the stop condition: with no NUL anywhere, the scan must
// end at the end of linear memory rather than run past it.
test('an unterminated string stops at the end of memory', () => {
  let seen;
  const { memory, shim } = makeShim({ lookup: () => true, run: (ctx) => { seen = ctx; return 0; } });
  const u8 = new Uint8Array(memory.buffer);
  const start = u8.length - 16;
  u8.fill(0x41, start);                       // 'A' to the last byte, no NUL

  const dv = new DataView(memory.buffer);
  const vec = start - 8;
  dv.setUint32(vec, start, true);
  dv.setUint32(vec + 4, 0, true);
  assert.equal(shim.imports().env.__host_builtin_run(0, 1, vec, 0), 0);
  assert.equal(seen.argv[0], 'A'.repeat(16));
});

test('cstr at a null pointer is the empty string', () => {
  const { shim } = makeShim({ lookup: () => true, run: () => 0 });
  assert.equal(shim.cstr(0), '');
  assert.deepEqual(shim.cstrv(0), []);
});

// ─── ctx.fs ──────────────────────────────────────────────────────────────────

test('ctx.fs resolves relative paths against cwd', () => {
  let fs;
  const { call } = makeShim({ lookup: () => true, run: (ctx) => { fs = ctx.fs; return 0; } });
  assert.equal(call(['tool'], [], '/work'), 0);
  assert.equal(dec.decode(fs.read('data.txt')), 'hello', 'relative to cwd');
  assert.equal(dec.decode(fs.read('/work/data.txt')), 'hello', 'absolute still works');
  assert.equal(fs.resolve('../etc/x'), '/etc/x');
  assert.equal(fs.read('missing'), null);
});

test('ctx.fs.read copies, so a builtin cannot scribble a mounted buffer', () => {
  const mounted = enc.encode('original');
  const shim = new WasiShim({ files: { '/f': mounted } });
  shim.bindMemory(new WebAssembly.Memory({ initial: 1 }));
  const fs = shim.hostFs('/');
  fs.read('f').fill(0x5a);
  assert.equal(dec.decode(mounted), 'original', 'CoW protects the caller');
});

test('ctx.fs write/mkdir/list/stat/remove reuse the shim’s own bookkeeping', () => {
  const shim = new WasiShim({});
  shim.bindMemory(new WebAssembly.Memory({ initial: 1 }));
  const fs = shim.hostFs('/');
  assert.equal(fs.write('/nodir/f', 'x'), false, 'creation needs an existing parent');
  assert.equal(fs.mkdir('/d'), true);
  assert.equal(fs.mkdir('/d'), false, 'already exists');
  assert.equal(fs.write('/d/f', 'body'), true);
  assert.equal(dec.decode(fs.read('/d/f')), 'body');
  assert.deepEqual(fs.stat('/d/f'), { type: 'file', size: 4 });
  assert.deepEqual(fs.stat('/d'), { type: 'dir', size: 0 });
  assert.deepEqual(fs.list('/d'), ['f']);
  assert.equal(fs.list('/d/f'), null, 'not a directory');
  assert.equal(fs.remove('/d'), false, 'rmdir refuses a non-empty directory');
  assert.equal(fs.remove('/d/f'), true);
  assert.equal(fs.remove('/d'), true);
  assert.equal(fs.exists('/d'), false);
});

// ─── ctx.interrupted(): the cooperative interrupt, at the shim seam ──────────

// The interrupt half of the `input` contract, with nothing else on it — the
// shim must ask for interruptCount and for nothing more.
function fakeInterrupts() {
  let count = 0;
  return {
    input: {
      pollReadable: () => false,
      read: () => new Uint8Array(0),
      interruptCount: () => count,
    },
    post: () => { count++; },
  };
}

test('ctx.interrupted() reports a ^C posted while the builtin is running', () => {
  const intr = fakeInterrupts();
  const seen = [];
  const { call } = makeShim({
    lookup: () => true,
    run: (ctx) => {
      seen.push(ctx.interrupted());   // nothing posted yet
      intr.post();                    // the host's session.interrupt()
      seen.push(ctx.interrupted());   // ...noticed at the next safe point
      return 130;                     // 128 + SIGINT, what a shell reads
    },
  }, undefined, intr.input);
  assert.equal(call(['loop']), 130);
  assert.deepEqual(seen, [false, true]);
});

test('ctx.interrupted() is scoped to the invocation, not to the session', () => {
  // A ^C typed between commands must not cancel the command typed after it.
  // The baseline is read at dispatch, so an interrupt already in the count is
  // one this command did not receive — the reason the word is a count and not
  // a flag (see ring.mjs).
  const intr = fakeInterrupts();
  intr.post();                        // ^C at the prompt, nothing running
  const seen = [];
  const { call } = makeShim({
    lookup: () => true,
    run: (ctx) => { seen.push(ctx.interrupted()); return 0; },
  }, undefined, intr.input);
  assert.equal(call(['work']), 0);
  assert.deepEqual(seen, [false], 'did not inherit the earlier interrupt');
  // ...and the next command is equally clean, having taken a fresh baseline.
  assert.equal(call(['work']), 0);
  assert.deepEqual(seen, [false, false]);
});

test('ctx.interrupted() is false when the session has no interrupt channel', () => {
  // run(), or any fixed stdin: interruptCount is absent, and an optional method
  // is absent by DEGRADING to no info — never by throwing at a builtin that
  // reasonably polls it.
  const seen = [];
  const { call } = makeShim({ lookup: () => true, run: (ctx) => { seen.push(ctx.interrupted()); return 0; } });
  assert.equal(call(['work']), 0);
  assert.deepEqual(seen, [false]);
});

// ─── the hooks: enumeration, for tab completion ──────────────────────────────
// lookup() answers one name at a time — all find_command() needs, and all a
// lazy namespace can promise. Listing is therefore a SEPARATE optional method,
// and its presence is the signal: see build/ash-compgen.patch.

// Read the i'th name the way host_builtin_name() does: into a guest buffer,
// with the returned length deciding where it ends.
function readName(env, memory, i, len = 255) {
  const buf = 4096;
  const n = env.__host_builtin_name(i, buf, len);
  if (n <= 0) return null;
  return dec.decode(new Uint8Array(memory.buffer, buf, n));
}
const allNames = (env, memory, len) => {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const name = readName(env, memory, i, len);
    if (name == null) break;
    out.push(name);
  }
  return out;
};

test('hostBuiltins: a map derives names() from its own keys', () => {
  const p = hostBuiltins({ alpha: () => 0, beta: () => 0 });
  assert.deepEqual(p.names().sort(), ['alpha', 'beta']);
});

test('hostBuiltins: names() and lookup() cannot disagree', () => {
  // A key holding a non-function is not a builtin, and offering it as a
  // completion would complete to a command that reports "not found".
  const p = hostBuiltins({ real: () => 0, notAFunction: 42 });
  assert.deepEqual(p.names(), ['real']);
  assert.equal(p.lookup('notAFunction'), false);
});

test('the name hook walks the registry and then stops', () => {
  const { env, memory } = makeShim(hostBuiltins({ one: () => 0, two: () => 0 }));
  assert.deepEqual(allNames(env, memory).sort(), ['one', 'two']);
  assert.equal(env.__host_builtin_name(2, 4096, 255), 0, 'past the end is 0, which ends the guest loop');
});

test('a provider without names() contributes no completions, and that is not an error', () => {
  // The extension point for a dynamic namespace: it can answer lookup('php')
  // without being able to enumerate itself. Completion simply never mentions
  // it; dispatch is untouched.
  const provider = { lookup: (n) => n === 'lazy', run: () => 0 };
  const { env, memory } = makeShim(provider);
  assert.equal(env.__host_builtin_lookup(0, 0), 0, 'nothing registered under the empty name');
  assert.equal(provider.lookup('lazy'), true, 'but the provider still resolves its own');
  assert.deepEqual(allNames(env, memory), [], 'and the list is simply empty');
});

test('no builtins at all: the name hook is the same empty answer', () => {
  const { env, memory } = makeShim(undefined);
  assert.deepEqual(allNames(env, memory), []);
});

test('a throwing names() costs the session nothing', () => {
  const { env, memory } = makeShim({
    lookup: () => false, run: () => 0,
    names() { throw new Error('the index is broken'); },
  });
  assert.deepEqual(allNames(env, memory), []);
});

test('a name too long for the guest buffer is skipped, not truncated', () => {
  // Half a command name is a candidate that completes to something which does
  // not exist. The skip happens here because one length cannot say both "skip
  // this one" and "the list ended" — see host_builtin_name() in wasistubs.c.
  const long = 'x'.repeat(40);
  const { env, memory } = makeShim(hostBuiltins({ short: () => 0, [long]: () => 0 }));
  assert.deepEqual(allNames(env, memory, 16), ['short'], 'and the walk continues past it');
});

test('names() is read once, so a list that changes mid-walk cannot skip entries', () => {
  // The guest asks for one index at a time. Re-reading per index would let a
  // shrinking list drop a name the walk had not reached yet.
  let calls = 0;
  const pool = ['aaa', 'bbb', 'ccc'];
  const { env, memory } = makeShim({
    lookup: (n) => pool.includes(n), run: () => 0,
    names() { calls++; return pool.slice(); },
  });
  assert.deepEqual(allNames(env, memory), ['aaa', 'bbb', 'ccc']);
  assert.equal(calls, 1, 'one call for the whole walk');
  pool.length = 0;
  assert.deepEqual(allNames(env, memory), ['aaa', 'bbb', 'ccc'], 'the snapshot stands for this session');
});
