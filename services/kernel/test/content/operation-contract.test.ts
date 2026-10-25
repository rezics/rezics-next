import { describe, expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import type { CommandOutcome } from '../../src/command/command.ts';
import { beginAuthorErasure, readOperation } from '../../src/content/operations.ts';
import type {
  AuthorErasureDependencies,
  AuthorErasureInput,
  BeginAuthorErasure,
  CommandRequestContext,
  NativeAuthorErasureWorkflows,
  NativeWorkflowStatus,
  Operation,
  OperationCount,
  OperationMetadata,
  OperationProgress,
  OperationResponse,
  Problem,
  ReadOperation,
  RequestContext,
  Status,
} from '../../src/content/operation-contract.ts';
import type { Access, AccountActor, Actor } from '../../src/request/access.ts';

describe('author erasure operation ports', () => {
  test('metadata and native progress carry bounded counters without an upfront total', () => {
    expectTypeOf<OperationCount>().toEqualTypeOf<number>();
    expectTypeOf<OperationMetadata>().toEqualTypeOf<
      Readonly<{
        type: 'content.author_erasure';
        threadId: string;
        authorId: string;
        processedPosts: number;
        erasedRevisions: number;
        steps: number;
      }>
    >();
    expectTypeOf<OperationProgress>().toEqualTypeOf<
      Readonly<{ processedPosts: number; erasedRevisions: number; steps: number }>
    >();
    expectTypeOf<NativeWorkflowStatus['progress']>().toEqualTypeOf<OperationProgress>();
    expectTypeOf<OperationResponse>().toEqualTypeOf<Readonly<{ processedPosts: number; erasedRevisions: number }>>();
    const metadata: OperationMetadata = {
      type: 'content.author_erasure',
      threadId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
      authorId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b72',
      processedPosts: 0,
      erasedRevisions: Number.MAX_SAFE_INTEGER,
      steps: 0,
    };
    const native: NativeWorkflowStatus = {
      done: false,
      progress: { processedPosts: 0, erasedRevisions: 0, steps: 0 },
    };
    expect(Object.keys(metadata).sort()).toEqual([
      'authorId',
      'erasedRevisions',
      'processedPosts',
      'steps',
      'threadId',
      'type',
    ]);
    expect(native.progress).toEqual({ processedPosts: 0, erasedRevisions: 0, steps: 0 });
  });

  test('AIP-151 operations discriminate pending, success, and Status failure arms', () => {
    type Base = Readonly<{ name: `operations/${string}`; metadata: OperationMetadata }>;
    expectTypeOf<Operation>().toEqualTypeOf<
      | (Base & Readonly<{ done: false; response?: never; error?: never }>)
      | (Base & Readonly<{ done: true; response: OperationResponse; error?: never }>)
      | (Base & Readonly<{ done: true; error: Status; response?: never }>)
    >();
    const operation: Operation = {
      name: 'operations/018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
      metadata: {
        type: 'content.author_erasure',
        threadId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
        authorId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
        processedPosts: 0,
        erasedRevisions: 0,
        steps: 0,
      },
      done: true,
      response: { processedPosts: 0, erasedRevisions: 0 },
    };
    const pending: Operation = { name: operation.name, metadata: operation.metadata, done: false };
    const failed: Operation = {
      name: operation.name,
      metadata: operation.metadata,
      done: true,
      error: { code: 7, message: 'Permission denied' },
    };
    expect(pending.done).toBe(false);
    expect(operation.response).toEqual({ processedPosts: 0, erasedRevisions: 0 });
    expect(failed.error).toEqual({ code: 7, message: 'Permission denied' });
  });

  test('terminal errors use google.rpc.Status while ordinary HTTP Problem stays RFC 9457', () => {
    expectTypeOf<Status>().toEqualTypeOf<Readonly<{ code: number; message: string; details?: unknown[] }>>();
    expectTypeOf<NativeWorkflowStatus['error']>().toEqualTypeOf<Status | undefined>();
    expectTypeOf<NativeWorkflowStatus['response']>().toEqualTypeOf<OperationResponse | undefined>();
    expectTypeOf<Problem>().toEqualTypeOf<
      Readonly<{ type: string; title: string; status: number; detail?: string; instance?: string }>
    >();
    expectTypeOf<Problem>().not.toExtend<Status>();
    expectTypeOf<Status>().not.toExtend<Problem>();
    const problem: Problem = { type: 'about:blank', title: 'Forbidden', status: 403 };
    const native: NativeWorkflowStatus = {
      done: true,
      progress: { processedPosts: 0, erasedRevisions: 0, steps: 0 },
      error: { code: 13, message: 'Internal error' },
    };
    expect(problem.status).toBe(403);
    expect(native.error).toEqual({ code: 13, message: 'Internal error' });
  });

  test('uncalled producer and consumer ports retain exact native signatures and strict contexts', () => {
    expectTypeOf<RequestContext>().toEqualTypeOf<Readonly<{ deadline: number }>>();
    expectTypeOf<CommandRequestContext>().toEqualTypeOf<
      RequestContext & Readonly<{ idempotencyKey: string; requestId: string }>
    >();
    expectTypeOf<RequestContext>().not.toExtend<CommandRequestContext>();
    expectTypeOf<AuthorErasureDependencies>().toEqualTypeOf<{
      pool: Pool;
      access: Access;
      clock: () => Date;
      workflows: NativeAuthorErasureWorkflows;
    }>();
    expectTypeOf<AuthorErasureInput>().toEqualTypeOf<Readonly<{ threadId: string; authorId: string }>>();
    expectTypeOf<BeginAuthorErasure>().toEqualTypeOf<
      (
        deps: AuthorErasureDependencies,
        actor: Actor,
        input: AuthorErasureInput,
        context: CommandRequestContext,
      ) => Promise<CommandOutcome<{ operationId: string }>>
    >();
    expectTypeOf<ReadOperation>().toEqualTypeOf<
      (
        deps: AuthorErasureDependencies,
        actor: Actor,
        operationId: string,
        context: RequestContext,
      ) => Promise<Operation | null>
    >();
    expectTypeOf<typeof beginAuthorErasure>().toEqualTypeOf<BeginAuthorErasure>();
    expectTypeOf<typeof readOperation>().toEqualTypeOf<ReadOperation>();
    expectTypeOf<NativeAuthorErasureWorkflows['enqueue']>().toEqualTypeOf<
      (
        input: Readonly<{ operationId: string; threadId: string; authorId: string; actor: AccountActor }>,
        context: CommandRequestContext,
      ) => Promise<void>
    >();
    expectTypeOf<NativeAuthorErasureWorkflows['status']>().toEqualTypeOf<
      (operationId: string, context: RequestContext) => Promise<NativeWorkflowStatus | null>
    >();
    const begin: BeginAuthorErasure = beginAuthorErasure;
    const read: ReadOperation = readOperation;
    expect([begin, read].every((port) => typeof port === 'function')).toBe(true);
  });
});
