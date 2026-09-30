import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {V3_EVAL_002_CASES} from '../src/v3-eval-002-harness.js';

for (const entry of V3_EVAL_002_CASES) {
  test(`EVAL-002 ${entry.id}: ${entry.scenario}`, () => {
    const child = spawnSync(process.execPath, [
      '--test', '--import', 'tsx', `--test-name-pattern=^${escapeRegExp(entry.testName)}$`, resolve(entry.testFile),
    ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: withoutNodeTestContext()});
    assert.equal(child.status, 0, `${entry.id} child failed\n${child.stdout}\n${child.stderr}`);
    assert.equal(child.error, undefined, `${entry.id} child process failed to start`);
    const output = `${child.stdout}\n${child.stderr}`;
    // Node 24's parent test reporter suppresses nested child names. Verify the
    // exact declaration in the selected child source, then require the child
    // summary so a stale/partial name cannot pass as a zero-match run.
    const childSource = readFileSync(resolve(entry.testFile), 'utf8');
    assert.ok(childSource.includes(`test('${entry.testName}'`), `expected exact indexed child test declaration for ${entry.id}`);
    assert.match(output, /^ℹ tests 1$/m, `expected exactly one selected child test for ${entry.id}`);
    assert.match(output, /^ℹ pass 1$/m, `expected one passing child test for ${entry.id}`);
    assert.match(output, /^ℹ fail 0$/m, `expected zero failing child tests for ${entry.id}`);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withoutNodeTestContext(): NodeJS.ProcessEnv {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  env.NODE_OPTIONS = '';
  return env;
}
