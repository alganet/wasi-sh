// memoryFs against the exported conformance suite — the same cases any other
// store runs. Store-specific behaviour (seeding, copy-on-write) is in
// fs.test.mjs; this file is only the shared contract.
import { test } from 'node:test';
import { memoryFs } from '../src/fs.mjs';
import { conformanceCases, checkConformance } from '../src/fs-conformance.mjs';

const fs = memoryFs();

conformanceCases().forEach((testCase, index) => {
  test(`memoryFs: ${testCase.name}`, () => { testCase.run(fs, `/conformance-${index}`); });
});

test('checkConformance reports every case as passing for memoryFs', () => {
  const { passed, failed } = checkConformance(() => memoryFs(), { prefix: '/checked' });
  if (failed.length) throw new Error(`${failed.length} failed: ${failed.map((f) => `${f.name} (${f.error.message})`).join('; ')}`);
  if (passed.length !== conformanceCases().length) throw new Error('checkConformance skipped a case');
});
