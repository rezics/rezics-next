import { expect, test } from 'bun:test';
import type {
  AuthorErasureDependencies,
  BeginAuthorErasure,
  CommandRequestContext,
  ReadOperation,
  RequestContext,
} from '../../src/content/operation-contract.ts';
import { beginAuthorErasure, readOperation } from '../../src/content/operations.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

test('operation implementations have exactly the native command and read signatures', () => {
  const signatures: [
    Equal<typeof beginAuthorErasure, BeginAuthorErasure>,
    Equal<Parameters<typeof beginAuthorErasure>[3], CommandRequestContext>,
    Equal<typeof readOperation, ReadOperation>,
    Equal<Parameters<typeof readOperation>[3], Readonly<{ deadline: number }>>,
  ] = [true, true, true, true];
  expect(signatures).toEqual([true, true, true, true]);

  // Compile compatibility without invoking either port.
  const compatibility = (deps: AuthorErasureDependencies, command: CommandRequestContext, read: RequestContext) => {
    const begin: BeginAuthorErasure = beginAuthorErasure;
    const readPort: ReadOperation = readOperation;
    const actor = { kind: 'anonymous' } satisfies Parameters<BeginAuthorErasure>[1];
    const input = { threadId: 'thread', authorId: 'author' };
    const commandResult: ReturnType<BeginAuthorErasure> = begin(deps, actor, input, command);
    const readResult: ReturnType<ReadOperation> = readPort(deps, actor, 'operation', read);
    // @ts-expect-error Initiation requires both command identifiers.
    void beginAuthorErasure(deps, actor, input, { deadline: 1 });
    // @ts-expect-error Initiation requires idempotencyKey.
    void beginAuthorErasure(deps, actor, input, { deadline: 1, requestId: 'request' });
    // @ts-expect-error Initiation requires requestId.
    void beginAuthorErasure(deps, actor, input, { deadline: 1, idempotencyKey: 'key' });
    void commandResult;
    void readResult;
  };
  expect(compatibility).toBeFunction();
});

test('operation stubs reject before touching any dependency', async () => {
  const touches: string[] = [];
  const touched = (name: string): never => {
    touches.push(name);
    throw new Error(`Unexpected dependency access: ${name}`);
  };
  const deps: AuthorErasureDependencies = {
    get pool() {
      return touched('pool');
    },
    get access() {
      return touched('access');
    },
    get clock() {
      return touched('clock');
    },
    get workflows() {
      return touched('workflows');
    },
  };

  await expect(
    beginAuthorErasure(
      deps,
      { kind: 'anonymous' },
      { threadId: 'thread', authorId: 'author' },
      { deadline: 1, idempotencyKey: 'key', requestId: 'request' },
    ),
  ).rejects.toThrow('Author erasure initiation is not implemented');
  await expect(readOperation(deps, { kind: 'anonymous' }, 'operation', { deadline: 1 })).rejects.toThrow(
    'Operation reads are not implemented',
  );
  expect(touches).toEqual([]);
});
