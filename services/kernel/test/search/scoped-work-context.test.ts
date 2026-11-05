import { afterAll, beforeAll, expect, expectTypeOf, test } from 'bun:test';
import { commandTime, type AuthoritativeTime } from '../../src/command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  runOperationalTransaction,
  type OperationalTransaction,
} from '../../src/command/operational.ts';
import type {
  CollectionSourceContext,
  CollectionSourceCall,
  ContainsCollectionSubject,
  PrepareCollectionSource,
} from '../../src/library/collection-source.ts';
import type { PreparationLocator } from '../../src/library/members-preparation.ts';
import type { Actor } from '../../src/request/access.ts';
import { partitionOf } from '../../src/route/route.ts';
import {
  admitMembersPreparationWork,
  type MembersPreparationWorkContext,
  type ScopeWorkContext,
} from '../../src/search/scope-work-context.ts';
import type { createSearchScopeOrder } from '../../src/search/service-scope-order.ts';
import type { createSearchScopeSource } from '../../src/search/scope-source.ts';
import type { LeafOptions } from '../../src/semantic/scope-leaf-evidence.ts';
import { definition, membersPreparationRuntime } from '../library/support/members-preparation-runtime.ts';

let native: Awaited<ReturnType<typeof membersPreparationRuntime>>;
beforeAll(async () => {
  native = await membersPreparationRuntime();
}, 120_000);
afterAll(async () => {
  await native.close();
});

test('work context is additive and uses the existing native scope adapter types', () => {
  expectTypeOf<MembersPreparationWorkContext>().toEqualTypeOf<
    Readonly<{ kind: 'members-preparation'; tx: OperationalTransaction; locator: PreparationLocator }>
  >();
  expectTypeOf<Extract<LeafOptions, { work: MembersPreparationWorkContext }>['actor']>().toEqualTypeOf<undefined>();
  expectTypeOf<Extract<LeafOptions, { work: MembersPreparationWorkContext }>['nativeT']>().toEqualTypeOf<undefined>();
  expectTypeOf<Extract<LeafOptions, { actor: Actor }>['work']>().toEqualTypeOf<undefined>();
  expectTypeOf<Extract<CollectionSourceContext, { actor: Actor }>['at']>().toEqualTypeOf<AuthoritativeTime>();
  expectTypeOf<
    Extract<CollectionSourceContext, { work: MembersPreparationWorkContext }>['actor']
  >().toEqualTypeOf<undefined>();
  expectTypeOf<
    Extract<CollectionSourceContext, { work: MembersPreparationWorkContext }>['at']
  >().toEqualTypeOf<undefined>();
  expectTypeOf<PrepareCollectionSource['work']>().toEqualTypeOf<ScopeWorkContext | undefined>();
  expectTypeOf<CollectionSourceCall['work']>().toEqualTypeOf<ScopeWorkContext | undefined>();
  expectTypeOf<ContainsCollectionSubject['work']>().toEqualTypeOf<ScopeWorkContext | undefined>();
  expectTypeOf<Parameters<typeof createSearchScopeOrder>[0]['options']>().toEqualTypeOf<LeafOptions>();
  expectTypeOf<Parameters<typeof createSearchScopeSource>[0]['evidence']>().toEqualTypeOf<LeafOptions | undefined>();
});

// Positive admission is deliberately real: no replacement MembersPreparation, ready Source or Actor
// is supplied. A missing producer is a native failure here, never an expected successful outcome.
test('Implement the sole4b native MembersPreparation work-context handoff', async () => {
  {
    const f = await native.fixture();
    const reserved = await f.store.reserve(f.actor, f.collectionId, [definition()]);
    expect(reserved.episodes).toHaveLength(1);
    const locator = reserved.episodes[0]!.locator;
    const options = {
      pool: native.db.pool,
      access: native.kernel.testAccess,
      deadline: Date.now() + 10_000,
    };
    let completed: MembersPreparationWorkContext | undefined;
    await runOperationalTransaction(
      native.db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(locator.route),
        kind: 'library.membersPreparation.step',
        accounts: [locator.ownerAccountId],
        workClient: native.workClient,
        deadline: options.deadline,
      },
      async (tx) => {
        const work: MembersPreparationWorkContext = { kind: 'members-preparation', tx, locator };
        completed = work;
        expect(hasLiveOperationalTransaction(tx)).toBe(true);
        const time = commandTime(tx);
        if (!time) throw new Error('Native operational attempt has no authoritative time');
        expect(await admitMembersPreparationWork(work, options)).toBe(time);
        // Re-use repeats the real native admission in the same attempt; no verdict is retained.
        expect(await admitMembersPreparationWork(work, options)).toBe(time);
        await expect(
          admitMembersPreparationWork({ ...work, locator: native.locator(f.owner, f.collectionId) }, options),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
        await expect(admitMembersPreparationWork(work, { ...options, deadline: Date.now() - 1 })).rejects.toMatchObject(
          { code: 'semantic_not_ready' },
        );
      },
    );
    expect(completed).toBeDefined();
    expect(hasLiveOperationalTransaction(completed!.tx)).toBe(false);
    expect(() => currentOperationalResources(completed!.tx)).toThrow('No live operational transaction');
    await expect(admitMembersPreparationWork(completed!, options)).rejects.toMatchObject({
      code: 'semantic_not_ready',
    });
    expect(native.db.pool.idleCount).toBe(native.db.pool.totalCount);
  }
}, 120_000);

test('native work handoff refuses a different fenced account before episode admission', async () => {
  {
    const f = await native.fixture();
    const other = await native.person();
    const locator = native.locator(f.owner, f.collectionId);
    await runOperationalTransaction(
      native.db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(locator.route),
        kind: 'library.membersPreparation.step',
        accounts: [other.accountId],
        workClient: native.workClient,
      },
      async (tx) => {
        await expect(
          admitMembersPreparationWork(
            { kind: 'members-preparation', tx, locator },
            { pool: native.db.pool, access: native.kernel.testAccess, deadline: Date.now() + 5000 },
          ),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
      },
    );
  }
}, 120_000);
