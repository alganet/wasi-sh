// The claim in the contract's header is that the `fs` shape is ZenFS's, not
// one we invented — and a claim like that rots silently. So a stock
// `@zenfs/core` backend runs the very same conformance suite our own store
// does. If someone bends the contract toward memoryFs, this is what fails.
//
// A DEV DEPENDENCY ONLY, and an optional one: `npm i wasi-sh` must keep
// installing exactly one thing, and a bare checkout must still test clean.
// ZenFS is LGPL-3.0-or-later; it appears here and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformanceCases } from '../src/fs-conformance.mjs';

let zenfs = null;
try {
  zenfs = await import('@zenfs/core');
} catch (err) {
  // Absent is fine and expected in a bare checkout; anything else — a broken
  // install, a package that no longer loads — must not disguise itself as one.
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
}

// Three cases are recorded as `todo` rather than run for a verdict: they are
// the backend's deviations, not gaps in the contract, so they stay visible and
// re-check themselves on every upgrade without turning a third-party bug into
// our red build.
//
// All three are `StoreFS` not reading the type of the inode it just resolved —
// a `readdir` of a file parses the file as a listing, a `write` to a directory
// overwrites that listing, and `touchSync({mode})` clears S_IFREG. They are
// **not filed upstream and deliberately so.** ZenFS's supported surface is the
// `fs` API, the VFS refuses all three before a backend ever sees them, and
// `FileSystem` is documented `@internal` for people extending it rather than
// calling it. A caller holding a backend directly — this one — is outside what
// upstream promises, and nothing that reaches this shell can arrive here
// anyway: `path_open` reads the type before a write, and `fd_readdir` before a
// listing. So the deviation is real, ours to know about, and no one's bug.
//
// The fourth, `touchSync` truncating the data as well as the size, WAS filed
// and is fixed: `StoreFS` owns its data nodes, so a caller of `fs.truncateSync`
// hits it and it is upstream's to answer.
const KNOWN_DEVIATIONS = new Map([
  ['directories refuse file operations', 'upstream: InMemory writeSync to a directory overwrites its index (@zenfs/core 2.6.4)'],
  ['readdirSync lists entry names, and a file is not a directory', 'upstream: InMemory readdir of a file throws SyntaxError, not ENOTDIR (@zenfs/core 2.6.4)'],
  ['touchSync changes permission bits and leaves the type alone', 'upstream: InMemory touchSync replaces the whole mode, clearing S_IFREG (@zenfs/core 2.6.4)'],
]);

if (!zenfs) {
  test('@zenfs/core InMemory conformance', { skip: '@zenfs/core is not installed' }, () => {});
} else {
  const store = await zenfs.resolveMountConfig({ backend: zenfs.InMemory, name: 'conformance' });
  conformanceCases().forEach((testCase, index) => {
    const todo = KNOWN_DEVIATIONS.get(testCase.name);
    test(`@zenfs/core InMemory: ${testCase.name}`, todo ? { todo } : {}, () => {
      testCase.run(store, `/conformance-${index}`);
    });
  });
}

// And the downstream half of the same claim, which the conformance suite
// cannot see: what the SHIM asks a stock backend for. shim-fs.test.mjs pins
// the ask against a store written for the purpose; this pins it against the
// real thing, because the whole defect was that every store the suite reached
// for was a friendly one. ZenFS records the mode it is given and nothing else,
// so a shell that names none leaves a tree no second guest can read.
//
// The only case in this file that runs a shell, and therefore the only one
// that needs dist/busybox.wasm — every other case here is pure JS, which is
// what lets CI run this file in a job with no wasm build. It skips there
// rather than failing; the conformance cases above are what that job is for.
if (zenfs) {
  const { run } = await import('../src/run.mjs');
  const { existsSync } = await import('node:fs');
  const WASM_BUILT = existsSync(new URL('../dist/busybox.wasm', import.meta.url));

  test('a shell creates readable files in a stock ZenFS store', async (t) => {
    if (!WASM_BUILT) { t.skip('no dist/busybox.wasm — run npm run build:wasm'); return; }
    const store = await zenfs.resolveMountConfig({ backend: zenfs.InMemory, name: 'modes' });
    const r = await run({
      inline: true,
      fs: store,
      script: 'mkdir -p /srv && printf \'<?php\' > /srv/index.php',
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(store.statSync('/srv').mode & 0o7777, 0o755);
    assert.equal(store.statSync('/srv/index.php').mode & 0o7777, 0o644);
  });
}
