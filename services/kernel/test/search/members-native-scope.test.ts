import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter, type FilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import type { WorkAllowance, WorkReceipt } from '../../src/library/collection-source.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import type { NativeOrdinalKey } from '../../src/library/collection-source-order.ts';
import type { PreparationDefinition, PreparationLocator } from '../../src/library/members-preparation.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { scopeWorkAxes } from '../../src/search/scope-execution.ts';
import { membersBounded } from '../../src/search/scope-members-work-cost.ts';
import { createSearchScopeSource, type ScopeEvaluationProgress } from '../../src/search/scope-source.ts';
import {
  readMembersPreparationWorkDefinition,
  type MembersPreparationWorkContext,
} from '../../src/search/scope-work-context.ts';
import { membersPreparationRuntime } from '../library/support/members-preparation-runtime.ts';
import { testRouteKey } from '../support/test-kernel.ts';

type Runtime = Awaited<ReturnType<typeof membersPreparationRuntime>>;
type Fixture = Awaited<ReturnType<Runtime['fixture']>>;
const presence: FilterDocument = { owner: { presence: true } };
const definition = (sort: 'id' | 'ordinal', filter: FilterDocument = presence): PreparationDefinition => ({
  filter: admitFilter(parseFilter(filter), bundledRelease, { owner: true, saved: true }),
  sort,
  release: { digest: bundledDigest, value: bundledRelease },
});

/** One finite original, explicitly settled across prepare, prefixes, evaluation and replay. */
function original() {
  const allowance: WorkAllowance = {
    reservationId: randomUUID(),
    remaining: {
      candidateKeys: 32768,
      nativeRows: 2_000_000,
      identityMetadataRows: 65536,
      nativePoints: 32768,
      witnessKeys: 32768,
      statements: 32768,
      emptySeeks: 8192,
      // Includes the conservative cold compressed-release projection bound, rather than assuming a cache hit.
      bytes: 16 * 1024 ** 3,
    },
  };
  const remaining = { ...allowance.remaining };
  return {
    next: (): WorkAllowance => ({ reservationId: allowance.reservationId, remaining: { ...remaining } }),
    settle(receipt: WorkReceipt) {
      expect(receipt.reservationId).toBe(allowance.reservationId);
      for (const axis of scopeWorkAxes) {
        expect(Number.isSafeInteger(receipt.used[axis])).toBe(true);
        expect(receipt.used[axis]).toBeGreaterThanOrEqual(0);
        expect(receipt.used[axis]).toBeLessThanOrEqual(remaining[axis]);
        remaining[axis] -= receipt.used[axis];
      }
      expect(receipt.used.statements).toBeGreaterThan(0);
      expect(receipt.used.nativePoints).toBeGreaterThan(0);
      expect(receipt.used.nativeRows).toBeGreaterThan(0);
      expect(receipt.used.identityMetadataRows).toBeGreaterThan(0);
      expect(receipt.used.bytes).toBeGreaterThan(0);
    },
  };
}

function adapter(native: Runtime, work: MembersPreparationWorkContext, deadline: number) {
  return createSearchScopeSource({
    pool: native.db.pool,
    prefix: 'members-native',
    // A genuine native-only plan must never call either public transport. These supply no evidence.
    client: new Proxy({} as Parameters<typeof createSearchScopeSource>[0]['client'], {
      get() {
        throw new Error('Native Members opened OpenSearch');
      },
    }),
    source: new Proxy({} as Parameters<typeof createSearchScopeSource>[0]['source'], {
      get() {
        throw new Error('Native Members opened public Subject evidence');
      },
    }),
    evidence: { access: native.kernel.testAccess, routeKey: testRouteKey(), work, deadline },
  });
}

async function step<T>(
  native: Runtime,
  locator: PreparationLocator,
  body: (work: MembersPreparationWorkContext, deadline: number) => Promise<T>,
  clock?: () => Date,
) {
  const deadline = Date.now() + 30000;
  return runOperationalTransaction(
    native.db.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: 'library.membersPreparation.step',
      accounts: [locator.ownerAccountId],
      workClient: native.workClient,
      deadline,
      ...(clock ? { clock } : {}),
    },
    (tx) => body({ kind: 'members-preparation', tx, locator }, deadline - 1),
  );
}

async function subject(native: Runtime, owner: Fixture['owner'], label: string) {
  const response = await native.send(owner, 'POST', '/v1/subjects', {
    type: 'schema:Book',
    labels: { en: label },
    statements: {},
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { subject: { id: string } }).subject.id;
}

async function preparedFixture(native: Runtime) {
  await bootstrapRelease(native.db.pool, bundledRelease);
  const f = await native.fixture();
  for (const feature of ['personal_library', 'reading_progress'])
    expect((await native.send(native.personas.staff, 'POST', `/v1/platform/exposure/${feature}:open`, {})).status).toBe(
      200,
    );
  expect(
    (
      await native.send(native.personas.staff, 'POST', '/v1/grants', {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: f.owner.accountId },
        actions: ['subject:create'],
        valid: '(,)',
      })
    ).status,
  ).toBe(201);
  const rejected = await subject(native, f.owner, 'Native rejected raw slot');
  const accepted = await subject(native, f.owner, 'Native admitted owner entry');
  const deleted = await subject(native, f.owner, 'Native deleted raw slot');
  const profileId = bundledRelease.types['schema:Book']!.library!.profileId;
  const profile = bundledRelease.libraryProfiles![profileId]!;
  const state = profile.entryStateSet!.states.find((value) => value.role === 'active')!;
  expect((await native.send(f.owner, 'PUT', `/v1/libraryEntries/${accepted}`, { state: state.id })).status).toBe(201);
  const members: { id: string; subjectId: string }[] = [];
  for (const subjectId of [rejected, accepted, deleted]) {
    const response = await native.send(f.owner, 'POST', `/v1/collections/${f.collectionId}/members`, { subjectId });
    expect(response.status).toBe(201);
    members.push(((await response.json()) as { member: (typeof members)[number] }).member);
  }
  const header = await native.send(f.owner, 'GET', `/v1/collections/${f.collectionId}`);
  expect(header.status).toBe(200);
  const { collection } = (await header.json()) as { collection: { revision: number } };
  expect(
    (
      await native.kernel.handle(
        new Request(
          `http://kernel.test/v1/collections/${f.collectionId}/members/${members[2]!.id}?revision=${collection.revision}`,
          {
            method: 'DELETE',
            headers: { authorization: `Bearer ${f.owner.bearer}`, 'idempotency-key': JSON.stringify(randomUUID()) },
          },
        ),
      )
    ).status,
  ).toBe(204);
  const repeated = await native.send(f.owner, 'POST', `/v1/collections/${f.collectionId}/members`, {
    subjectId: accepted,
  });
  expect(repeated.status).toBe(201);
  members.push(((await repeated.json()) as { member: (typeof members)[number] }).member);
  // Exercise the ordinary native Source producer before the work consumer. No capture/generation is seeded.
  expect((await native.send(f.owner, 'GET', `/v1/collections/${f.collectionId}/members`)).status).toBe(200);
  return {
    ...f,
    accepted,
    rejected,
    members,
    entryState: state.id,
    stateFilter: {
      owner: { state: { profileId, stateSetId: profile.entryStateSet!.id, in: [state.id] } },
    } satisfies FilterDocument,
  };
}

// Connected native and growth regression: intentionally UNRUN under MINIMAL. The installed production
// reserve/admit/getter, Source capture, Semantic association and operational custody must actually succeed.
// A specification stub, fake READY empty result or test certificate is a failure, never an accepted outcome.
test('genuine Members native scopes evaluate owner facts and continue ID/ordinal with one client and cumulative work', async () => {
  const native = await membersPreparationRuntime();
  try {
    const f = await preparedFixture(native);
    let unrelated = 0;
    const footprints: number[] = [];
    for (const scale of [1, 10, 100]) {
      while (unrelated < scale) {
        const id = await subject(native, f.owner, `Unrelated native owner fact ${unrelated++}`);
        expect((await native.send(f.owner, 'PUT', `/v1/libraryEntries/${id}`, { state: f.entryState })).status).toBe(
          201,
        );
      }
      for (const requested of [
        definition('id'),
        definition('ordinal'),
        definition('id', f.stateFilter),
        definition('id', { not: presence }),
      ]) {
        const alternate = (
          await f.store.reserve(await native.actor(f.owner), f.collectionId, [
            definition('id', 'not' in requested.filter ? presence : { not: presence }),
          ])
        ).episodes[0]!.locator;
        const reserved = await f.store.reserve(await native.actor(f.owner), f.collectionId, [requested]);
        expect(reserved.episodes).toHaveLength(1);
        const locator = reserved.episodes[0]!.locator;
        let completed: MembersPreparationWorkContext | undefined;
        await step(native, locator, async (work, deadline) => {
          completed = work;
          const admitted = await readMembersPreparationWorkDefinition(work, {
            pool: native.db.pool,
            access: native.kernel.testAccess,
            deadline,
          });
          expect(admitted.definition).toEqual(requested);
          // The connection has already been acquired by Core. Trap ANY further checkout for the whole use.
          const connect = native.db.pool.connect;
          let checkouts = 0;
          native.db.pool.connect = (() => {
            checkouts++;
            throw new Error('Second native Members checkout');
          }) as Pool['connect'];
          try {
            const scope = adapter(native, work, deadline);
            const payer = original();
            const prepared = await scope.prepare(requested.filter, { allowance: payer.next() });
            expect(prepared.readiness).toBe('ready');
            expect(prepared.basis.nativeOwner).toEqual({
              source: admitted.sourceIdentity,
              observation: admitted.observation,
            });
            expect(prepared.basis.index).toBeUndefined();
            expect(prepared.basis.generation).toBeUndefined();
            const preparation = scope.work(prepared);
            payer.settle(preparation);
            if (requested.sort === 'id') {
              const first = await scope.sourcePrefix(prepared, { afterSubjectId: null, allowance: payer.next() });
              payer.settle(first.work);
              const ids = first.candidates.map((value) => value.subjectId);
              expect(ids).toEqual([f.rejected, f.accepted].sort());
              const checked = await scope.evaluate(prepared, ids, {
                rawKeys: 256,
                native: { points: 8192, witnesses: 8192, rows: 65536, bytes: 8 * 1024 ** 3, emptySeeks: 1024 },
                allowance: payer.next(),
              });
              payer.settle(scope.work(checked));
              const negative = 'not' in requested.filter;
              expect(checked.values).toEqual(ids.map((id) => (negative ? id === f.rejected : id === f.accepted)));
              expect(checked.progress).toBeNull();
              const rest = await scope.sourcePrefix(prepared, {
                afterSubjectId: first.coveredThrough,
                allowance: payer.next(),
              });
              payer.settle(rest.work);
              expect(rest.candidates).toEqual([]);
              expect(rest.exhausted).toBe(true);
              const unknown = await scope.evaluate(prepared, [f.accepted], {
                rawKeys: 0,
                native: { points: 8192, witnesses: 8192, rows: 65536, bytes: 8 * 1024 ** 3, emptySeeks: 1024 },
                allowance: payer.next(),
              });
              payer.settle(scope.work(unknown));
              expect(unknown.values).toEqual(['not_proven']);
              // A full one-key window retains its real raw position and cannot certify exhaustion.
              const replay = adapter(native, work, deadline);
              const replayScope = await replay.prepare(requested.filter, { allowance: payer.next() });
              payer.settle(replay.work(replayScope));
              const partial = await replay.evaluate(replayScope, [f.accepted], {
                rawKeys: 1,
                native: { points: 8192, witnesses: 8192, rows: 65536, bytes: 8 * 1024 ** 3, emptySeeks: 1024 },
                allowance: payer.next(),
              });
              payer.settle(replay.work(partial));
              expect(partial.values).toEqual(['not_proven']);
              expect(partial.progress?.after).toBe('1');
              const progress = partial.progress!;
              const resumed = await replay.evaluate(replayScope, [f.accepted], {
                rawKeys: 256,
                progress,
                native: { points: 8192, witnesses: 8192, rows: 65536, bytes: 8 * 1024 ** 3, emptySeeks: 1024 },
                allowance: payer.next(),
              });
              payer.settle(replay.work(resumed));
              expect(resumed.values).toEqual([!negative]);
              const invalid: ScopeEvaluationProgress = { ...progress, phase: 'compact' };
              await expect(
                replay.evaluate(replayScope, [f.accepted], {
                  rawKeys: 256,
                  progress: invalid,
                  native: { points: 8192, witnesses: 8192, rows: 65536, bytes: 8 * 1024 ** 3, emptySeeks: 1024 },
                  allowance: original().next(),
                }),
              ).rejects.toThrow('Invalid Members raw progress');
            } else {
              const limited = payer.next();
              const unknown = await scope.ordinalPrefix(prepared, {
                after: null,
                quota: 1,
                allowance: { ...limited, remaining: { ...limited.remaining, candidateKeys: 2 } },
              });
              payer.settle(unknown.work);
              expect(unknown.subjects).toEqual([]);
              expect(unknown.frontier.after).toBeNull();
              expect(unknown.exhausted).toBe(false);
              let after: NativeOrdinalKey | null = null;
              const selected: string[] = [];
              for (let page = 0; page < 5; page++) {
                const next = await scope.ordinalPrefix(prepared, { after, quota: 1, allowance: payer.next() });
                payer.settle(next.work);
                expect(next.frontier.after?.memberId).toBe(f.members[Math.min(page, f.members.length - 1)]!.id);
                if (page === 0) {
                  expect(next.subjects).toEqual([]);
                  expect(next.frontier.after?.memberId).toBe(f.members[0]!.id);
                  expect(next.exhausted).toBe(false);
                }
                selected.push(...next.subjects.map((value) => value.subject));
                if (next.exhausted) break;
                expect(next.frontier.after).not.toEqual(after);
                after = next.frontier.after;
                expect(page).toBeLessThan(4);
              }
              expect(selected).toEqual([f.accepted]);
            }
            footprints.push(preparation.used.statements);
            for (const hint of [
              { releaseDigest: `sha256:${'0'.repeat(64)}` },
              { order: { kind: requested.sort === 'id' ? 'ordinal' : 'id', source: admitted.sourceIdentity } as const },
            ])
              await expect(
                scope.prepare(requested.filter, { ...hint, allowance: original().next() }),
              ).rejects.toMatchObject({ code: 'semantic_not_ready' });
            await expect(
              scope.prepare({ owner: { label: { id: newId(locator.route) } } }, { allowance: original().next() }),
            ).rejects.toMatchObject({ code: 'semantic_not_ready' });
            await expect(
              adapter(native, { ...work, locator: { ...locator, episodeId: newId(locator.route) } }, deadline).prepare(
                requested.filter,
                { allowance: original().next() },
              ),
            ).rejects.toMatchObject({ code: 'semantic_not_ready' });
            await expect(
              adapter(
                native,
                { ...work, locator: { ...locator, ownerAccountId: native.personas.bob.accountId } },
                deadline,
              ).prepare(requested.filter, { allowance: original().next() }),
            ).rejects.toMatchObject({ code: 'semantic_not_ready' });
            // No statement may escape an empty original statement allowance, including native admission.
            const bounded = original().next();
            await expect(
              scope.prepare(requested.filter, {
                allowance: { ...bounded, remaining: { ...bounded.remaining, statements: 0 } },
              }),
            ).rejects.toMatchObject({
              code: 'dependency_unavailable',
              work: { used: { statements: 0 } },
            });
            if (requested.sort === 'id' || requested.sort === 'ordinal') {
              // Change the supplied episode during real dependent SQL, without faking a native getter result.
              // The final fresh reread must refuse both a positive and an empty result, including ordinal selection.
              const mutable = { ...locator };
              const currentScope = adapter(native, { ...work, locator: mutable }, deadline);
              const captured = await currentScope.prepare(requested.filter, { allowance: original().next() });
              const read = work.tx.query;
              let changed = false;
              work.tx.query = (async (...args: unknown[]) => {
                const result = await Reflect.apply(read, work.tx, args);
                const config = args[0] as string | { text: string };
                if (!changed && /library\.entry\b/.test(typeof config === 'string' ? config : config.text)) {
                  changed = true;
                  mutable.episodeId = alternate.episodeId;
                }
                return result;
              }) as typeof read;
              try {
                const selection =
                  requested.sort === 'ordinal'
                    ? currentScope.ordinalPrefix(captured, {
                        after: null,
                        quota: 1,
                        allowance: original().next(),
                      })
                    : currentScope.evaluate(captured, [f.accepted], {
                        rawKeys: 256,
                        native: {
                          points: 8192,
                          witnesses: 8192,
                          rows: 65536,
                          bytes: 8 * 1024 ** 3,
                          emptySeeks: 1024,
                        },
                        allowance: original().next(),
                      });
                await expect(selection).rejects.toMatchObject({ code: 'semantic_not_ready' });
                expect(changed).toBe(true);
              } finally {
                work.tx.query = read;
              }
            }
            expect(checkouts).toBe(0);
          } finally {
            native.db.pool.connect = connect;
          }
        });
        await expect(
          adapter(native, completed!, Date.now() + 1000).prepare(requested.filter, { allowance: original().next() }),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
      }
    }
    // Native admission/current points do not scan unrelated owner facts.
    expect(Math.max(...footprints) - Math.min(...footprints)).toBeLessThan(16);
  } finally {
    await native.close();
  }
}, 240000);

test('genuine Members admission refuses stale native source, expired episode and revoked owner without fake readiness', async () => {
  const native = await membersPreparationRuntime();
  try {
    for (const scale of [1, 10, 100]) {
      const f = await preparedFixture(native);
      for (let index = 0; index < scale; index++) {
        const id = await subject(native, f.owner, `Unrelated native admission control ${scale}:${index}`);
        expect((await native.send(f.owner, 'PUT', `/v1/libraryEntries/${id}`, { state: f.entryState })).status).toBe(
          201,
        );
      }
      const requested = definition('id');
      const mixed = definition('id', { and: [presence, { type: { in: ['schema:Book'] } }] });
      const mixedLocator = (await f.store.reserve(await native.actor(f.owner), f.collectionId, [mixed])).episodes[0]!
        .locator;
      await step(native, mixedLocator, async (work, deadline) => {
        const connect = native.db.pool.connect;
        native.db.pool.connect = (() => {
          throw new Error('Mixed Members opened another client');
        }) as typeof connect;
        try {
          // The real admitted private source is useful, but supplies no independent public predicate proof.
          await expect(
            adapter(native, work, deadline).prepare(mixed.filter, { allowance: original().next() }),
          ).rejects.toMatchObject({ code: 'dependency_unavailable' });
        } finally {
          native.db.pool.connect = connect;
        }
      });
      const reserve = async () =>
        (await f.store.reserve(await native.actor(f.owner), f.collectionId, [requested])).episodes[0]!.locator;
      const stale = await reserve();
      const added = await subject(native, f.owner, 'Actual changed curated source');
      expect(
        (await native.send(f.owner, 'POST', `/v1/collections/${f.collectionId}/members`, { subjectId: added })).status,
      ).toBe(201);
      await expect(
        step(native, stale, async (work, deadline) =>
          adapter(native, work, deadline).prepare(requested.filter, { allowance: original().next() }),
        ),
      ).rejects.toMatchObject({ code: 'semantic_not_ready' });
      const fresh = await reserve();
      await expect(
        step(
          native,
          fresh,
          async (work, deadline) =>
            adapter(native, work, deadline).prepare(requested.filter, { allowance: original().next() }),
          () => new Date(Date.now() + 25 * 3600000),
        ),
      ).rejects.toMatchObject({ code: 'semantic_not_ready' });
      expect(
        (
          await native.send(native.personas.staff, 'POST', `/v1/accounts/${f.owner.accountId}:suspend`, {
            reason: 'Native admission current owner control',
          })
        ).status,
      ).toBe(200);
      await expect(
        step(native, fresh, async (work, deadline) =>
          adapter(native, work, deadline).prepare(requested.filter, { allowance: original().next() }),
        ),
      ).rejects.toBeDefined();
    }
  } finally {
    await native.close();
  }
}, 240000);

// Accounting regression only; it is deliberately separate from the connected native claim above.
test('Members work reserves all eight axes before dispatch and settles failures and repeats once', async () => {
  const root = original().next();
  const bound = {
    candidateKeys: 1,
    nativeRows: 4,
    identityMetadataRows: 2,
    nativePoints: 1,
    witnessKeys: 1,
    statements: 1,
    bytes: 256,
    emptySeeks: 1,
  };
  for (const axis of scopeWorkAxes) {
    const work = new NativeCollectionWork({ ...root, remaining: { ...root.remaining, [axis]: 0 } }, Date.now() + 1000);
    let calls = 0;
    await expect(
      membersBounded(work, bound, async () => {
        calls++;
        return [];
      }),
    ).rejects.toMatchObject({ code: 'dependency_unavailable' });
    expect(calls).toBe(0);
    expect(Object.values(work.receipt().used).every((value) => value === 0)).toBe(true);
  }
  const work = new NativeCollectionWork(root, Date.now() + 1000);
  for (let repeat = 1; repeat <= 2; repeat++) {
    await expect(
      membersBounded(work, bound, async () => {
        throw new Error('Dispatched native failure');
      }),
    ).rejects.toThrow('Dispatched native failure');
    for (const axis of scopeWorkAxes) expect(work.receipt().used[axis]).toBe(repeat * bound[axis]);
  }
});
