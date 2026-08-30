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

// Known deviations in the backend, not gaps in the contract — recorded as
// todo so they stay visible and re-check themselves on every upgrade, without
// turning a third-party bug into our red build.
//
// All four are in @zenfs/core 2.6.3's InMemory backend, and all four are
// upstreamable:
//
//   truncate — shrinking is metadata-only. 'abcdefgh' truncated to 3 and back
//   to 5 reads 'abcde', where POSIX ftruncate discards the extra data and
//   zero-fills the extension. Ours must zero-fill: O_TRUNC followed by a short
//   write goes straight through it, so a store that does not would show the
//   guest bytes it believes it deleted.
//
//   directory writes — writeSync against a directory path is accepted and
//   overwrites the directory's own serialized index, so `echo hi > /dir`
//   destroys the directory rather than failing with EISDIR.
//
//   readdir of a file — throws a SyntaxError from parsing the file as an
//   index, with no .code or .errno for the shim to translate.
//
//   chmod — touchSync({mode}) replaces the whole mode rather than only the
//   permission bits, so a chmod clears S_IFREG and leaves a node that is
//   neither a file nor a directory. Nothing in the shell chmods today (there
//   is no chmod applet), but a second guest over the same store does.
const KNOWN_DEVIATIONS = new Map([
  ['touchSync truncates, both shorter and longer', 'upstream: InMemory truncate is metadata-only (@zenfs/core 2.6.3)'],
  ['directories refuse file operations', 'upstream: InMemory writes bytes into the directory index (@zenfs/core 2.6.3)'],
  ['readdirSync lists entry names, and a file is not a directory', 'upstream: InMemory readdir of a file throws SyntaxError, not ENOTDIR (@zenfs/core 2.6.3)'],
  ['touchSync changes permission bits and leaves the type alone', 'upstream: InMemory touchSync replaces the whole mode, clearing S_IFREG (@zenfs/core 2.6.3)'],
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
