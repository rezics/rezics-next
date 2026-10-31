import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import { createCollectionSource } from '../../src/library/collection-source.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import type { ScopeWorkContext } from '../../src/search/scope-work-context.ts';
import { readScopeWorkDefinition } from '../../src/search/scope-work-context.ts';
import { ownerAllowance } from './canonical-source-fixture.ts';
import { definition, membersPreparationRuntime } from './support/members-preparation-runtime.ts';

test('The actual CollectionSource work-context branch executes real admitted native preparation without a fabricated ordinary Actor', async () => {
  const native = await membersPreparationRuntime();
  try {
    const f = await native.fixture();
    const reserved = await f.store.reserve(f.actor, f.collectionId, [definition()]);
    expect(reserved.episodes).toHaveLength(1);
    const locator = reserved.episodes[0]!.locator;
    const source = createCollectionSource({ pool: native.db.pool, access: native.kernel.testAccess });
    let completed: ScopeWorkContext | undefined;
    await runOperationalTransaction(
      native.db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(locator.route),
        kind: 'library.membersPreparation.step',
        accounts: [locator.ownerAccountId],
        workClient: native.workClient,
        deadline: Date.now() + 30000,
      },
      async (tx) => {
        const work: ScopeWorkContext = { kind: 'members-preparation', tx, locator };
        completed = work;
        const context = { work, deadline: Date.now() + 10000 };
        const admitted = await readScopeWorkDefinition(work, {
          pool: native.db.pool,
          access: native.kernel.testAccess,
          deadline: context.deadline,
        });
        const prepared = await source.prepare({
          ...context,
          collectionId: f.collectionId,
          allowance: ownerAllowance(),
        });
        expect(prepared.source.observation).toEqual(admitted.observation);
        expect(prepared.work.used.statements).toBeGreaterThan(0);
        const call = { ...context, source: prepared.source };
        const prefix = await source.prefix({ ...call, afterSubjectId: null, allowance: ownerAllowance() });
        expect(prefix.candidates).toEqual([]);
        expect(prefix.exhausted).toBe(true);
        const absent = await source.containsSubject({
          ...call,
          subjectId: newId(locator.route),
          allowance: ownerAllowance(),
        });
        expect(absent.result).toBe(false);
        const ordinal = await source.readRawOrdinalPrefix({
          ...call,
          after: null,
          limit: 1,
          allowance: ownerAllowance(),
        });
        expect(ordinal.rows).toEqual([]);
        expect(ordinal.exhausted).toBe(true);
        const raw = await source.readRawStoredPrefix({
          ...call,
          afterStoredSubjectId: null,
          allowance: ownerAllowance(),
        });
        expect(raw.storedSubjectIds).toEqual([]);
        expect(raw.storedExhausted).toBe(true);
        await expect(
          source.prepare({
            work: { ...work, locator: { ...locator, episodeId: newId(locator.route) } },
            deadline: context.deadline,
            collectionId: f.collectionId,
            allowance: ownerAllowance(),
          }),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
        expect(
          await readScopeWorkDefinition(work, {
            pool: native.db.pool,
            access: native.kernel.testAccess,
            deadline: context.deadline,
          }),
        ).toEqual(admitted);
      },
    );
    await expect(
      source.prepare({
        work: completed!,
        deadline: Date.now() + 5000,
        collectionId: f.collectionId,
        allowance: ownerAllowance(),
      }),
    ).rejects.toMatchObject({ code: 'semantic_not_ready' });
  } finally {
    await native.close();
  }
}, 120000);

test('a locator and a query-shaped object cannot admit Source work or open a checkout', async () => {
  const collectionId = newId(0xc100);
  let checkouts = 0;
  const pool = {
    connect() {
      checkouts++;
      throw new Error('Unadmitted Source checkout');
    },
  } as unknown as Pool;
  // No Access operation is allowed before real Core/native admission.
  const access = new Proxy({} as Access, {
    get() {
      throw new Error('Unadmitted Access call');
    },
  });
  for (const kind of ['members-preparation', 'collection-kind-preparation'] as const) {
    // @ts-expect-error Deliberately unminted: a query shape lacks Core's transaction brand.
    const tx: ScopeWorkContext['tx'] = {
      query() {
        throw new Error('Unadmitted Source SQL');
      },
    };
    const locator = {
      route: 0xc100,
      ownerAccountId: newId(0xc100),
      collectionId,
      episodeId: newId(0xc100),
      preparationId: newId(0xc100),
    };
    const work: ScopeWorkContext = kind === 'members-preparation' ? { kind, tx, locator } : { kind, tx, locator };
    await expect(
      createCollectionSource({ pool, access }).prepare({
        work,
        collectionId,
        deadline: Date.now() + 5000,
        allowance: ownerAllowance(),
      }),
    ).rejects.toMatchObject({ code: 'semantic_not_ready' });
  }
  expect(checkouts).toBe(0);
});
