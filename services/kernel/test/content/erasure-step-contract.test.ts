import { expect, expectTypeOf, test } from 'bun:test';
import type { CurrentConsentReader } from '../../src/request/auth-consent.ts';
import type { ErasureJob } from '../../src/content/erasure-job.ts';
import type { CommandOutcome } from '../../src/command/command.ts';
import { erasePostLogical } from '../../src/content/erase-post.ts';
import {
  runAuthorErasure,
  type ErasureCheckpointAdapter,
  type NativeDurableStep,
} from '../../src/content/erasure-workflow.ts';
import type { NativeAuthorErasureWorkflows, OperationProgress } from '../../src/content/operation-contract.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import type { Pool } from 'pg';

test('uncalled erasure entry points retain exact native kernel signatures', () => {
  type Erase = (
    deps: Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array; clock?: () => Date }>,
    actor: Actor,
    input: Readonly<{ postId: string; reason: string }>,
    context: Readonly<{ deadline: number; idempotencyKey: string; requestId: string }>,
  ) => Promise<CommandOutcome<{ postId: string; securityRevision: string }>>;
  type Workflow = (
    deps: Readonly<{
      pool: Pool;
      access: Access;
      readConsent: CurrentConsentReader;
      erasureJob?: ErasureJob;
      currentTime: () => Date;
      durableStep: NativeDurableStep;
      checkpoint: ErasureCheckpointAdapter;
    }>,
    operationId: string,
  ) => Promise<Readonly<{ processedPosts: number; erasedRevisions: number }>>;
  expectTypeOf<typeof erasePostLogical>().toEqualTypeOf<Erase>();
  expectTypeOf<typeof runAuthorErasure>().toEqualTypeOf<Workflow>();
  expectTypeOf<NativeDurableStep>().toEqualTypeOf<<T>(name: string, action: () => Promise<T>) => Promise<T>>();
  expectTypeOf<ErasureCheckpointAdapter['read']>().toEqualTypeOf<
    (operationId: string) => Promise<OperationProgress | null>
  >();
  expectTypeOf<ErasureCheckpointAdapter['write']>().toEqualTypeOf<
    (operationId: string, progress: OperationProgress) => Promise<void>
  >();
  const erase: Erase = erasePostLogical;
  const workflow: Workflow = runAuthorErasure;
  const workflows: NativeAuthorErasureWorkflows = {
    enqueue: async () => {},
    status: async () => ({
      done: false,
      progress: { processedPosts: 2, erasedRevisions: 3, steps: 1 },
    }),
  };
  const actor: Actor = { kind: 'anonymous' };
  expect([erase, workflow].every((port) => typeof port === 'function')).toBe(true);
  void [workflows, actor];
});
