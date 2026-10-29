import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import defaults from '../defaults.json';
import { integrationHarness } from './test-support.ts';
import type { IntegrationCheck } from './merge-train.ts';

const setChecks = (h: ReturnType<typeof integrationHarness>, checks: IntegrationCheck[]) => {
  (h.settings as typeof h.settings & { integrationChecks: IntegrationCheck[] }).integrationChecks = checks;
};

test('default affected checks keep only the kernel entry', () => {
  expect(defaults.affectedTests).toEqual([
    {
      paths: ['services/kernel/**'],
      command: ['env', 'KERNEL_CHECK_AFFECTED_MAX=60', 'bun', 'run', '--cwd', 'services/kernel', 'check'],
    },
  ]);
});

test('a batch runs a matching affected check once for the union of member paths', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    const runs = join(h.settings.stateDirectory, 'affected-batch-runs');
    h.settings.affectedTests = [
      {
        paths: ['packages/ui/**'],
        command: ['sh', '-c', `printf '%s\\n' "$PWD" >> '${runs}'`],
      },
    ];
    setChecks(h, []);
    const first = h.dispatch('packages/ui/one.ts');
    const second = h.dispatch('packages/ui/two.ts');
    await h.start(first);
    await h.start(second);
    await h.train();
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(h.outcomes.map((outcome) => outcome.passed)).toEqual([true, true]);
  } finally {
    h.dispose();
  }
});

test('a batch selects each check matching any member path once and skips unmatched checks', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    const runs = join(h.settings.stateDirectory, 'affected-batch-union-runs');
    h.settings.affectedTests = [
      { paths: ['packages/ui/one.ts'], command: ['sh', '-c', `printf 'one\n' >> '${runs}'`] },
      { paths: ['packages/ui/two.ts'], command: ['sh', '-c', `printf 'two\n' >> '${runs}'`] },
      { paths: ['packages/filter/**'], command: ['sh', '-c', `printf 'unmatched\n' >> '${runs}'`] },
    ];
    setChecks(h, []);
    const first = h.dispatch('packages/ui/one.ts');
    const second = h.dispatch('packages/ui/two.ts');
    await h.start(first);
    await h.start(second);
    await h.train();
    expect(readFileSync(runs, 'utf8').trim().split('\n').sort()).toEqual(['one', 'two']);
    expect(h.outcomes.map((outcome) => outcome.passed)).toEqual([true, true]);
  } finally {
    h.dispose();
  }
});

test('a failed batch affected check lands no combined candidate and passing members land individually', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    const runs = join(h.settings.stateDirectory, 'affected-batch-failure-runs');
    h.settings.affectedTests = [
      {
        paths: ['packages/ui/**'],
        command: [
          'sh',
          '-c',
          `count=$(($(wc -l < '${runs}' 2>/dev/null || printf 0) + 1)); printf '%s\\n' "$count" >> '${runs}'; test "$count" -ne 1`,
        ],
      },
    ];
    setChecks(h, []);
    const first = h.dispatch('packages/ui/one.ts');
    const second = h.dispatch('packages/ui/two.ts');
    await h.start(first);
    await h.start(second);
    await h.train();
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toEqual(['1', '2', '3']);
    expect(h.outcomes.map((outcome) => outcome.passed)).toEqual([true, true]);
  } finally {
    h.dispose();
  }
});
