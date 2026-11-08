import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KERNEL_CLIENT_OUTPUT } from './check-output-tree.ts';
import { expect, test } from 'bun:test';
import { withOriginalContext, workerCheckCompilerOutputs } from './worker-check.ts';

const command = [
  'bun',
  'services/auth/scripts/dev-stack.ts',
  'walk',
  '--',
  'bun',
  'apps/web/scripts/vndb-seeded-journey.ts',
];

test('remote handoff keeps original argv when the launcher has no task context', () => {
  expect(withOriginalContext(command, {})).toEqual(command);
});

test('remote handoff prefixes original task, attempt and acceptance without rewriting the walk command', () => {
  expect(
    withOriginalContext(command, {
      GOAL_TASK_ID: '24256f23-7a74-4949-881c-7dbaea6b0207',
      GOAL_ATTEMPT: '3',
      GOAL_ACCEPTANCE_REQUIRES: 'native,browser,root',
    }),
  ).toEqual([
    'env',
    'GOAL_TASK_ID=24256f23-7a74-4949-881c-7dbaea6b0207',
    'GOAL_ATTEMPT=3',
    'GOAL_ACCEPTANCE_REQUIRES=native,browser,root',
    ...command,
  ]);
});

test('original context merges into an existing env prefix used for artifact staging', () => {
  expect(
    withOriginalContext(['env', 'REZICS_CHECK_ARTIFACTS_DIR=.temp/stage', ...command], {
      GOAL_TASK_ID: '24256f23-7a74-4949-881c-7dbaea6b0207',
    }),
  ).toEqual([
    'env',
    'GOAL_TASK_ID=24256f23-7a74-4949-881c-7dbaea6b0207',
    'REZICS_CHECK_ARTIFACTS_DIR=.temp/stage',
    ...command,
  ]);
});

test('known producer-consumer chain declares the official client tree once; custom and non-fail-fast chains do not', () => {
  const parent = join(import.meta.dir, '../.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'compiler-output-plan-'));
  try {
    for (const [path, typecheck] of [
      ['services/kernel', 'bun scripts/typecheck.ts'],
      ['packages/client', 'bun check --no-script -p tsconfig.json'],
    ]) {
      mkdirSync(join(root, path!), { recursive: true });
      writeFileSync(join(root, path!, 'package.json'), JSON.stringify({ scripts: { typecheck } }));
    }
    const chain = 'bun run --cwd services/kernel typecheck --emit-client && bun run --cwd packages/client typecheck';
    expect(workerCheckCompilerOutputs(['sh', '-c', chain], root)).toEqual([KERNEL_CLIENT_OUTPUT.transport]);
    expect(workerCheckCompilerOutputs(['sh', '-c', chain.replace('&&', ';')], root)).toEqual([]);
    expect(workerCheckCompilerOutputs(['sh', '-c', chain.replace('packages/client', 'packages/custom')], root)).toEqual(
      [],
    );
    writeFileSync(
      join(root, 'services/kernel/package.json'),
      JSON.stringify({ scripts: { typecheck: 'custom-generator' } }),
    );
    expect(workerCheckCompilerOutputs(['sh', '-c', chain], root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
