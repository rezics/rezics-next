import { describe, expect, test } from 'bun:test';
import { beginAuthorErasure, readOperation } from '../../src/content/operations.ts';
import type { AuthorErasureDependencies, Operation } from '../../src/content/operation-contract.ts';
import type { Actor } from '../../src/request/access.ts';

describe('author erasure operation ports', () => {
  test('ports use native kernel contracts and bounded AIP-151 results', () => {
    const operation: Operation = {
      name: 'operations/018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
      metadata: {
        type: 'content.author_erasure',
        threadId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
        authorId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
        processedPosts: 0,
        erasedRevisions: 0,
      },
      done: true,
      response: { processedPosts: 0, erasedRevisions: 0 },
    };
    const pending: Operation = {
      name: operation.name,
      metadata: operation.metadata,
      done: false,
    };
    const failed: Operation = {
      name: operation.name,
      metadata: operation.metadata,
      done: true,
      error: { type: 'about:blank', title: 'Forbidden', status: 403 },
    };
    const actor: Actor = {
      kind: 'account',
      accountId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
      clientId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b72',
      scopes: [],
      requestedBy: null,
      authnEpoch: 1,
    };
    void actor;
    void pending;
    void failed;
    void (null as unknown as AuthorErasureDependencies);
  });

  test('unfinished ports fail before access, database, or native workflow I/O', async () => {
    const calls: string[] = [];
    const deps = {
      pool: {
        query: () => {
          calls.push('pool');
          throw new Error('unexpected pool I/O');
        },
      },
      access: {
        authorize: () => {
          calls.push('access');
          throw new Error('unexpected access');
        },
        authenticate: () => {
          calls.push('authenticate');
          throw new Error('unexpected access');
        },
      },
      clock: () => {
        calls.push('clock');
        throw new Error('unexpected clock');
      },
      workflows: {
        enqueue: () => {
          calls.push('enqueue');
          throw new Error('unexpected enqueue');
        },
        status: () => {
          calls.push('status');
          throw new Error('unexpected status');
        },
      },
    } as unknown as AuthorErasureDependencies;
    const actor: Actor = {
      kind: 'account',
      accountId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b71',
      clientId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b72',
      scopes: [],
      requestedBy: null,
      authnEpoch: 1,
    };

    await expect(
      beginAuthorErasure(
        deps,
        actor,
        {
          threadId: '018f47b2-1a33-7d11-8c0a-22f32f9a4b73',
          authorId: actor.accountId,
        },
        { deadline: Date.now() + 1000 },
      ),
    ).rejects.toThrow();
    await expect(
      readOperation(deps, actor, '018f47b2-1a33-7d11-8c0a-22f32f9a4b74', {
        deadline: Date.now() + 1000,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
