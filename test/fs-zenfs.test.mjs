// The claim in the contract's header is that the `fs` shape is ZenFS's, not
// one we invented — and a claim like that rots silently. So a stock
// `@zenfs/core` backend runs the very same conformance suite our own store
// does. If someone bends the contract toward memoryFs, this is what fails.
//
// A DEV DEPENDENCY ONLY, and an optional one: `npm i wasi-sh` must keep
// installing exactly one thing, and a bare checkout must still test clean.
// ZenFS is LGPL-3.0-or-later; it appears here and nowhere else.
import { test } from 'node:test';
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
// All three are in @zenfs/core 2.6.3's InMemory backend, and all three are
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
const KNOWN_DEVIATIONS = new Map([
  ['touchSync truncates, both shorter and longer', 'upstream: InMemory truncate is metadata-only (@zenfs/core 2.6.3)'],
  ['directories refuse file operations', 'upstream: InMemory writes bytes into the directory index (@zenfs/core 2.6.3)'],
  ['readdirSync lists entry names, and a file is not a directory', 'upstream: InMemory readdir of a file throws SyntaxError, not ENOTDIR (@zenfs/core 2.6.3)'],
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
