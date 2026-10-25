import { expect, test } from 'bun:test';
import type { CommandOutcome } from '../../src/command/command.ts';
import { erasePostLogical } from '../../src/content/erase-post.ts';
import { runAuthorErasure } from '../../src/content/erasure-workflow.ts';
import type { NativeAuthorErasureWorkflows } from '../../src/content/operation-contract.ts';
import type { Actor } from '../../src/request/access.ts';
import type { Pool } from 'pg';
import type { Access } from '../../src/request/access.ts';

test('erasure entry points retain the native kernel contracts', () => {
  const erase: typeof erasePostLogical = erasePostLogical;
  const workflow: typeof runAuthorErasure = runAuthorErasure;
  const outcome: CommandOutcome<{ postId: string; securityRevision: string }> | undefined = undefined;
  const actor: Actor = { kind: 'anonymous' };
  const workflows: NativeAuthorErasureWorkflows = {
    enqueue: async () => {},
    status: async () => ({
      done: false,
      progress: { processedPosts: 2, erasedRevisions: 3 },
    }),
  };
  const pool: Pool | undefined = undefined;
  const access: Access | undefined = undefined;
  void [erase, workflow, outcome, actor, workflows, pool, access];
});

test('unfinished erasure entry points throw before touching dependencies', async () => {
  const calls: string[] = [];
  const pool = new Proxy({}, { get() { calls.push('pool'); throw new Error('unexpected pool access'); } });
  const access = new Proxy({}, { get() { calls.push('access'); throw new Error('unexpected access'); } });
  const deps = {
    pool,
    access,
    routeKey: new Uint8Array(32),
    clock: () => { calls.push('clock'); throw new Error('unexpected clock'); },
  };
  await expect(erasePostLogical(
    deps as never,
    { kind: 'anonymous' },
    { postId: 'post', reason: 'requested' },
    { deadline: Date.now() + 1000, idempotencyKey: 'key', requestId: 'request' },
  )).rejects.toThrow();
  await expect(runAuthorErasure({
    ...deps,
    step: async () => { calls.push('step'); throw new Error('unexpected step'); },
    checkpoint: async () => { calls.push('checkpoint'); throw new Error('unexpected checkpoint'); },
  } as never, 'operation')).rejects.toThrow();
  expect(calls).toEqual([]);
});
