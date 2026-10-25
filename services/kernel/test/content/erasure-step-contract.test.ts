import { expect, test } from 'bun:test';
import type { CommandOutcome } from '../../src/command/command.ts';
import { erasePostLogical } from '../../src/content/erase-post.ts';
import {
  runAuthorErasure,
  type ErasureCheckpointAdapter,
  type NativeDurableStep,
} from '../../src/content/erasure-workflow.ts';
import type { NativeAuthorErasureWorkflows } from '../../src/content/operation-contract.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import type { Pool } from 'pg';

test('erasure entry points retain the native kernel contracts', () => {
  const erase: (
    deps: { pool: Pool; access: Access; routeKey: Uint8Array; clock?: () => Date },
    actor: Actor,
    input: { postId: string; reason: string },
    context: { deadline: number; idempotencyKey: string; requestId: string },
  ) => Promise<CommandOutcome<{ postId: string; securityRevision: string }>> = erasePostLogical;
  const workflow: (
    deps: {
      pool: Pool;
      access: Access;
      currentTime: () => Date;
      durableStep: NativeDurableStep;
      checkpoint: ErasureCheckpointAdapter;
    },
    operationId: string,
  ) => Promise<{ processedPosts: number; erasedRevisions: number }> = runAuthorErasure;
  const workflows: NativeAuthorErasureWorkflows = {
    enqueue: async () => {},
    status: async () => ({
      done: false,
      progress: { processedPosts: 2, erasedRevisions: 3 },
    }),
  };
  const actor: Actor = { kind: 'anonymous' };
  void [erase, workflow, workflows, actor];
});

test('unfinished erasure ports fail before touching I/O dependencies', async () => {
  const calls: string[] = [];
  const pool = new Proxy(Object.create(null) as object, {
    get() {
      calls.push('pool');
      throw new Error('unexpected pool access');
    },
  }) as Pool;
  const access = new Proxy(Object.create(null) as object, {
    get() {
      calls.push('access');
      throw new Error('unexpected access');
    },
  }) as Access;

  await expect(
    erasePostLogical(
      { pool, access, routeKey: new Uint8Array(32), clock: () => new Date() },
      { kind: 'anonymous' },
      { postId: 'post', reason: 'requested' },
      { deadline: Date.now() + 1000, idempotencyKey: 'key', requestId: 'request' },
    ),
  ).rejects.toThrow();

  await expect(
    runAuthorErasure(
      {
        pool,
        access,
        currentTime: () => new Date(),
        durableStep: async (_name, action) => {
          calls.push('durable-step');
          return action();
        },
        checkpoint: {
          read: async () => {
            calls.push('checkpoint-read');
            return null;
          },
          write: async () => {
            calls.push('checkpoint-write');
          },
        },
      },
      'operation',
    ),
  ).rejects.toThrow();

  expect(calls).toEqual([]);
});
