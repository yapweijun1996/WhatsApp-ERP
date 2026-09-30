import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { V3_EVAL_001_CASES } from '../src/v3-eval-001-corpus.js';

for (const entry of V3_EVAL_001_CASES) {
  test(`EVAL-001 ${entry.id}: ${entry.criterion}`, () => {
    const file = resolve(entry.testFile);
    const child = spawnSync(process.execPath, [
      '--test', '--import', 'tsx', `--test-name-pattern=^${escapeRegExp(entry.testName)}$`, file,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: withoutNodeTestContext() });
    // Node's test reporter writes its summary to stderr in this execution mode.
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const output = `${child.stdout}\n${child.stderr}`;
    assert.match(output, /^ℹ tests 1$/m, `expected exactly one selected child test for ${entry.id}`);
    assert.match(output, /^ℹ pass 1$/m, `expected one passing child test for ${entry.id}`);
    assert.match(output, /^ℹ fail 0$/m, `expected zero failing child tests for ${entry.id}`);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withoutNodeTestContext(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
