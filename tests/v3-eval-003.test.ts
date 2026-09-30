import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

/** EVAL-003 indexes the frozen RET-008 benchmark and its deterministic degradation oracle. */
const CASES = [
  {
    id: 'benchmark',
    testName: 'RET-008 G13 benchmark freezes reproducible performance and budget evidence',
  },
  {
    id: 'degradation',
    testName: 'RET-008 G16 retrieval budget ends in bounded abstention',
  },
] as const;

for (const entry of CASES) {
  test(`EVAL-003 ${entry.id}`, () => {
    const file = resolve('tests/v3-ret-008-evaluator.test.ts');
    const child = spawnSync(
      process.execPath,
      [
        '--test',
        '--import',
        'tsx',
        `--test-name-pattern=^${escapeRegExp(entry.testName)}$`,
        file,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: withoutNodeTestContext(),
      },
    );
    const output = `${child.stdout}\n${child.stderr}`;
    assert.equal(child.status, 0, output);
    assert.match(output, /^ℹ tests 1$/m, `expected one selected child test for ${entry.id}`);
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
