import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import { runOperationalTransaction, type OperationalTransaction } from '../../src/command/operational.ts';
import type {
  CollectionPublicationLocator,
  CollectionPublicationWorkDefinition,
} from '../../src/library/collection-publication-work-admission.ts';
import { createCollectionSource, type CollectionSourceContext } from '../../src/library/collection-source.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { scopeAllowance } from '../../src/search/scope-execution.ts';
import {
  admitScopeWork,
  readCollectionKindPreparationWorkDefinition,
  readCollectionPublicationScopeWorkDefinition,
  readMembersPreparationWorkDefinition,
  readScopeWorkDefinition,
  type CollectionKindPreparationWorkContext,
  type CollectionPublicationWorkContext,
  type MembersPreparationWorkContext,
  type ScopeWorkContext,
} from '../../src/search/scope-work-context.ts';
import { readScopeLeafEvidence, type LeafOptions } from '../../src/semantic/scope-leaf-evidence.ts';
import { membersPreparationRuntime } from '../library/support/members-preparation-runtime.ts';

test('publication is an original actor-free Scope branch with the exact Library locator and whole result', () => {
  expectTypeOf<CollectionPublicationWorkContext>().toEqualTypeOf<
    Readonly<{
      kind: 'collection-publication';
      tx: OperationalTransaction;
      locator: CollectionPublicationLocator;
    }>
  >();
  expectTypeOf<ScopeWorkContext>().toEqualTypeOf<
    MembersPreparationWorkContext | CollectionKindPreparationWorkContext | CollectionPublicationWorkContext
  >();
  expectTypeOf<
    Awaited<ReturnType<typeof readCollectionPublicationScopeWorkDefinition>>
  >().toEqualTypeOf<CollectionPublicationWorkDefinition>();
  expectTypeOf<
    Extract<CollectionSourceContext, { work: CollectionPublicationWorkContext }>['actor']
  >().toEqualTypeOf<undefined>();
  expectTypeOf<
    Extract<LeafOptions, { work: CollectionPublicationWorkContext }>['nativeT']
  >().toEqualTypeOf<undefined>();
});

test('publication refuses forged clients and wrong roles before Source or Type audience I/O', async () => {
  const route = 0xc100;
  const work: CollectionPublicationWorkContext = {
    kind: 'collection-publication',
    locator: { route, ownerAccountId: newId(route), collectionId: newId(route), publicationId: crypto.randomUUID() },
    // Deliberately unminted: structural resemblance cannot create a live Core client.
    tx: {
      query() {
        throw new Error('Forged publication reached I/O');
      },
    } as unknown as OperationalTransaction,
  };
  const pool = {
    connect() {
      throw new Error('Publication opened a foreign checkout');
    },
  } as unknown as Pool;
  const access = {} as Access;
  const options = { pool, access, deadline: Date.now() + 5000 };
  await expect(readCollectionPublicationScopeWorkDefinition(work, options)).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  await expect(readScopeWorkDefinition(work, options)).rejects.toMatchObject({ code: 'semantic_not_ready' });
  await expect(admitScopeWork(work, options)).rejects.toMatchObject({ code: 'semantic_not_ready' });
  // @ts-expect-error Publication cannot borrow curated Members admission.
  await expect(readMembersPreparationWorkDefinition(work, options)).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  // @ts-expect-error Publication cannot borrow native Kind admission.
  await expect(readCollectionKindPreparationWorkDefinition(work, options)).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  await expect(
    createCollectionSource({ pool, access }).prepare({
      work,
      collectionId: work.locator.collectionId,
      deadline: options.deadline,
      allowance: scopeAllowance(16, 'publication-refusal'),
    }),
  ).rejects.toMatchObject({ code: 'semantic_not_ready' });
  await expect(
    readScopeLeafEvidence(
      pool,
      {
        subject: newId(route),
        leaf: { facet: 'type', values: ['example:Type'] },
        after: null,
        revalidate: null,
        budget: { keys: 1, points: 1, witnesses: 1, rows: 1, bytes: 1024, emptySeeks: 1 },
      },
      { work, access, routeKey: new Uint8Array(32), deadline: options.deadline },
    ),
  ).rejects.toMatchObject({ code: 'semantic_not_ready' });
});

// Real Core admission is necessary but not sufficient. No native producer or ready Source
// is substituted here; a committed publication episode is still required from Library.
test('the distinct publication work context requires real native episode admission current immutable rule private input and staged output under the live Core transaction without borrowing Members Kind public output or final command authority', async () => {
  const native = await membersPreparationRuntime();
  try {
    const f = await native.fixture();
    const route = routeOf(f.collectionId)!;
    const locator: CollectionPublicationLocator = {
      route,
      ownerAccountId: f.owner.accountId,
      collectionId: f.collectionId,
      publicationId: crypto.randomUUID(),
    };
    const options = { pool: native.db.pool, access: native.kernel.testAccess, deadline: Date.now() + 10000 };
    let completed: CollectionPublicationWorkContext | undefined;
    await runOperationalTransaction(
      native.db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(route),
        kind: 'library.collectionPublication.step',
        accounts: [locator.ownerAccountId],
        workClient: native.workClient,
        deadline: options.deadline,
      },
      async (tx) => {
        const work: CollectionPublicationWorkContext = { kind: 'collection-publication', tx, locator };
        completed = work;
        const failure = await readCollectionPublicationScopeWorkDefinition(work, options).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).not.toBeNull();
        expect(['semantic_not_ready', 'dependency_unavailable']).toContain((failure as { code: string }).code);
        for (const foreign of [
          { ...locator, ownerAccountId: newId(route) },
          { ...locator, route: route ^ 1 },
          { ...locator, collectionId: newId(route ^ 1) },
          { ...locator, publicationId: '' },
        ]) {
          await expect(
            readCollectionPublicationScopeWorkDefinition({ ...work, locator: foreign }, options),
          ).rejects.toMatchObject({ code: 'semantic_not_ready' });
        }
        await expect(
          readCollectionPublicationScopeWorkDefinition(work, { ...options, pool: {} as Pool }),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
        await expect(
          readCollectionPublicationScopeWorkDefinition(work, { ...options, deadline: Date.now() - 1 }),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
      },
    );
    await expect(readCollectionPublicationScopeWorkDefinition(completed!, options)).rejects.toMatchObject({
      code: 'semantic_not_ready',
    });
  } finally {
    await native.close();
  }
}, 120000);
