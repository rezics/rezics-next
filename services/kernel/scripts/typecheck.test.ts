import { expect, test } from 'bun:test';
import { runKernelTypecheck } from './typecheck.ts';

test('client-only generation retains managed database execution', async () => {
  const calls: unknown[] = [];
  const status = await runKernelTypecheck(
    {},
    {
      recognize: () => ({
        outcome: 'admitted',
        runId: 'kernel-client-only-test',
        scope: 'kernel-client-only-test',
        supervisor: { pid: 1, started: '1', group: 1 },
      }),
      withThrowawayDatabase: async (work) => work({ DATABASE_URL: 'postgres://kernel/test' }),
      typecheck: async (env, emitClient, emitSchema, emitClientOnly) => {
        calls.push([env.DATABASE_URL, emitClient, emitSchema, emitClientOnly]);
        return 0;
      },
      outputTree: async (_root, run) => run(),
    },
    ['--emit-client-only'],
  );

  expect(status).toBe(0);
  expect(calls).toEqual([['postgres://kernel/test', true, undefined, true]]);
});
