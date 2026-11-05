import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import { runOperationalTransaction, type OperationalTransaction } from '../../src/command/operational.ts';
import type {
  CollectionKindPreparationLocator,
  CollectionKindWorkDefinition,
} from '../../src/library/collection-kind-work-admission.ts';
import type { CollectionSourceContext, PrepareCollectionSource } from '../../src/library/collection-source.ts';
import { createCollectionSource } from '../../src/library/collection-source.ts';
import type { NativePublicOutputIdentity, NativeSourceIdentity } from '../../src/library/native-source-custody.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import type { LeafOptions } from '../../src/semantic/scope-leaf-evidence.ts';
import { readScopeLeafEvidence } from '../../src/semantic/scope-leaf-evidence.ts';
import { scopeAllowance } from '../../src/work-ledger/scope-work.ts';
import {
  readCollectionKindPreparationWorkDefinition,
  readMembersPreparationWorkDefinition,
  type CollectionKindPreparationWorkContext,
  type CollectionPublicationWorkContext,
  type MembersPreparationWorkContext,
  type ScopeWorkContext,
} from '../../src/search/scope-work-context.ts';
import { membersPreparationRuntime } from '../library/support/members-preparation-runtime.ts';

test('Kind has its exact native locator and a distinct actor-free Source work branch', () => {
  expectTypeOf<CollectionKindPreparationWorkContext>().toEqualTypeOf<
    Readonly<{
      kind: 'collection-kind-preparation';
      tx: OperationalTransaction;
      locator: CollectionKindPreparationLocator;
    }>
  >();
  expectTypeOf<ScopeWorkContext>().toEqualTypeOf<
    MembersPreparationWorkContext | CollectionKindPreparationWorkContext | CollectionPublicationWorkContext
  >();
  expectTypeOf<PrepareCollectionSource['work']>().toEqualTypeOf<ScopeWorkContext | undefined>();
  expectTypeOf<Exclude<LeafOptions['work'], undefined>>().toEqualTypeOf<ScopeWorkContext>();
  expectTypeOf<Extract<LeafOptions, { actor: unknown }>['work']>().toEqualTypeOf<undefined>();
  expectTypeOf<Extract<CollectionSourceContext, { actor: unknown }>['work']>().toEqualTypeOf<undefined>();
  expectTypeOf<
    Awaited<ReturnType<typeof readCollectionKindPreparationWorkDefinition>>
  >().toEqualTypeOf<CollectionKindWorkDefinition>();
});

test('native public output has no account and keeps current, activation and output generations distinct', () => {
  const source: NativePublicOutputIdentity = {
    scope: 'public_output',
    route: 0xc100,
    collectionId: newId(0xc100),
    incarnation: 'native-incarnation',
    generation: '14',
    ownerEpoch: 3,
    receivingEpoch: '5',
    effectKey: 'native-output',
    outputGeneration: '9',
    activation: { transactionId: crypto.randomUUID(), position: '9007199254740993', sourceGeneration: '12' },
  };
  expectTypeOf<Extract<NativeSourceIdentity, { scope: 'public_output' }>>().toEqualTypeOf<NativePublicOutputIdentity>();
  expect('accountId' in source).toBe(false);
  expect(source.generation).toBe('14');
  expect(source.activation.sourceGeneration).toBe('12');
  expect(source.outputGeneration).toBe('9');
  expect(source.activation.position).toBe('9007199254740993');
});

test('a forged Kind context cannot reach Source I/O, leaf audience checks or the Members branch', async () => {
  const accountId = newId(0xc100);
  const locator: CollectionKindPreparationLocator = {
    route: 0xc100,
    ownerAccountId: accountId,
    collectionId: newId(0xc100),
    preparationId: crypto.randomUUID(),
  };
  const work: CollectionKindPreparationWorkContext = {
    kind: 'collection-kind-preparation',
    locator,
    // Deliberately unminted: shape is never native Core authority.
    tx: {
      query() {
        throw new Error('Forged transaction reached I/O');
      },
    } as unknown as OperationalTransaction,
  };
  const pool = {
    connect() {
      throw new Error('Work opened a Source checkout');
    },
  } as unknown as Pool;
  const access = {} as Access;
  const options = { pool, access, deadline: Date.now() + 5000 };
  await expect(readCollectionKindPreparationWorkDefinition(work, options)).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  // @ts-expect-error A Kind locator is never a curated Members episode.
  await expect(readMembersPreparationWorkDefinition(work, options)).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  await expect(
    createCollectionSource({ pool, access }).prepare({
      work,
      collectionId: locator.collectionId,
      deadline: options.deadline,
      allowance: scopeAllowance(16, 'kind-refusal'),
    }),
  ).rejects.toMatchObject({ code: 'semantic_not_ready' });
  await expect(
    readScopeLeafEvidence(
      pool,
      {
        subject: newId(0xc100),
        leaf: { facet: 'type', values: ['example:Type'] },
        after: null,
        revalidate: null,
        budget: { keys: 1, points: 1, witnesses: 1, rows: 1, bytes: 1024, emptySeeks: 1 },
      },
      { work, access, routeKey: new Uint8Array(32), deadline: options.deadline },
    ),
  ).rejects.toMatchObject({ code: 'semantic_not_ready' });
});

test('live Core work requires the actual Kind episode and exact current fenced owner', async () => {
  const native = await membersPreparationRuntime();
  try {
    const f = await native.fixture();
    const route = routeOf(f.collectionId)!;
    const locator: CollectionKindPreparationLocator = {
      route,
      ownerAccountId: f.owner.accountId,
      collectionId: f.collectionId,
      preparationId: crypto.randomUUID(),
    };
    const options = { pool: native.db.pool, access: native.kernel.testAccess, deadline: Date.now() + 10000 };
    let completed: CollectionKindPreparationWorkContext | undefined;
    await runOperationalTransaction(
      native.db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(route),
        kind: 'library.collectionKindPreparation.step',
        accounts: [locator.ownerAccountId],
        workClient: native.workClient,
        deadline: options.deadline,
      },
      async (tx) => {
        const work: CollectionKindPreparationWorkContext = { kind: 'collection-kind-preparation', tx, locator };
        completed = work;
        // No native Kind intent was committed for this locator. A live client alone never admits it.
        const failure = await readCollectionKindPreparationWorkDefinition(work, options).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).not.toBeNull();
        expect(['semantic_not_ready', 'dependency_unavailable']).toContain((failure as { code: string }).code);
        await expect(
          readCollectionKindPreparationWorkDefinition(
            {
              ...work,
              locator: { ...locator, ownerAccountId: newId(route) },
            },
            options,
          ),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
        await expect(
          readCollectionKindPreparationWorkDefinition(work, {
            ...options,
            deadline: Date.now() - 1,
          }),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
      },
    );
    await expect(readCollectionKindPreparationWorkDefinition(completed!, options)).rejects.toMatchObject({
      code: 'semantic_not_ready',
    });
  } finally {
    await native.close();
  }
}, 120000);
