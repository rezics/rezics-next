import { test } from 'bun:test';
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
