// The CI list and the suites that need a dev dependency, kept in step.
//
// `test/fs-journal.test.mjs` and `test/fs-persist.test.mjs` — 815 lines over
// the journal and the persistence adapter, the most intricate code in this
// package — ran in NEITHER CI job for as long as they had existed. The build
// job installs nothing, so both skipped themselves; the job that installs names
// its files by hand, and did not name them. Nothing said so, because a suite
// that skips and a suite that passes look the same in a log nobody reads.
//
// So the hand-written list is checked against the tests that need the thing
// that job installs. Adding a suite over `@zenfs/core` now fails here until the
// workflow runs it, which is the only place that failure can be noticed by
// somebody who is not looking for it.
//
// It reads the workflow as TEXT rather than parsing YAML, deliberately: the
// package has one devDependency and a YAML parser is not going to be the
// second. What it needs from the file is one command line, and a regex that
// stops matching is a test that fails loudly rather than a check that quietly
// passes on nothing — which is the failure mode this whole file exists about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const WORKFLOW = new URL('../.github/workflows/build.yml', import.meta.url);
const HERE = new URL('./', import.meta.url);

/** The step that runs the suites needing the installed dev dependency. */
function listedInCi() {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const step = /- name: Run the suites that need @zenfs\/core\n[ \t]+run: >\n((?:[ \t]+\S[^\n]*\n)+)/.exec(yaml);
  assert.ok(step, 'the CI step that runs them has been renamed or rewritten — update this test with it');
  return new Set(step[1].match(/test\/\S+\.test\.mjs/g) || []);
}

/** The suites that cannot run without `@zenfs/core`, by what they import. */
function needTheDependency() {
  const needs = [];
  for (const name of readdirSync(HERE)) {
    if (!name.endsWith('.test.mjs') || name === 'workflow.test.mjs') continue;
    const source = readFileSync(new URL(name, HERE), 'utf8');
    // Both spellings, and the shared double: fs-journal and fs-persist reach
    // the dependency through `backing.mjs` rather than naming it themselves.
    if (/from '@zenfs\/core'|import\('@zenfs\/core'\)|from '\.\/backing\.mjs'/.test(source)) {
      needs.push(`test/${name}`);
    }
  }
  return needs;
}

test('every suite that needs @zenfs/core is run by CI', () => {
  const listed = listedInCi();
  const needs = needTheDependency();
  assert.ok(needs.length >= 3, `only ${needs.length} suites were detected — the import test has stopped matching`);
  const missing = needs.filter((file) => !listed.has(file));
  assert.deepEqual(missing, [], `these skip themselves everywhere else and CI does not run them: ${missing.join(', ')}`);
});
