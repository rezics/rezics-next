import { expect, test } from 'bun:test';
import { withOriginalContext } from './worker-check.ts';

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
