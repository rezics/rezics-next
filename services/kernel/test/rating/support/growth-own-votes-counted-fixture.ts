import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, spyOn } from 'bun:test';
import type { PoolClient, QueryResult } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createOwnCountedVoteReader } from '../../../src/rating/own-votes-counted.ts';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { identityEpochStore } from '../../../src/semantic/identity-epoch-store.ts';
import * as commandTiming from '../../../src/command/timing.ts';
import { withReadTransaction } from '../../../src/semantic/read.ts';
import { createSubject } from '../../../src/semantic/subject.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { openGrowthDatabase, seed, type CountedValues, type Row } from '../../support/growth.ts';
import { createRealAccess } from '../../semantic/real-access.ts';
import { configureTestReceiptKeys } from '../../support/receipt-keys.ts';
import { createAccess } from '../../../src/access/index.ts';
import { GLOBAL_CONTEXT as accessGlobal } from '../../../src/access/gates/catalogue.ts';
import { accessCommandAuthorization } from '../../../src/request/access.ts';

export const countedAxes = [
  'unrelated votes',
  'selected retained votes',
  'identity/source/authority history',
  'repair backlog',
] as const;
export type CountedAxis = (typeof countedAxes)[number];
const at = '2026-11-03T00:00:00.000000Z';
const byteCap = 65_536;
const stringify = JSON.stringify;

// UTF-8 payload bytes, not a JavaScript heap-size estimate. Maps and bigint are native Access/identity payloads.
function bytes(value: unknown): number {
  const seen = new WeakSet<object>();
  return Buffer.byteLength(
    stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item && typeof item === 'object') {
        if (seen.has(item)) return null;
        seen.add(item);
        if (item instanceof Map || item instanceof Set) return [...item];
      }
      return item;
    }) ?? '',
    'utf8',
  );
}

export async function createCountedGrowthFixture() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  try {
    await bootstrapRelease(db.pool, bundledRelease);
    configureTestReceiptKeys(db.pool);
    const scopes = ['subject:create', 'subject:read', 'definitions:read', 'rating:vote'];
    const accountId = newId(0x23a1);
    const real = await createRealAccess(db.admin, { voter: accountId }, scopes);
    const access = createAccess({
      auth: real.auth,
      actions: new Map(
        scopes.map((action) => [
          action,
          {
            anonymous: action === 'subject:read' || action === 'definitions:read',
          },
        ]),
      ),
    });
    const global = { route: 0, id: GLOBAL_CONTEXT };
    await real.grant(global, 'voter', 'subject:create');
    await real.grant(accessGlobal, 'voter', 'definitions:read');
    // Match the retained native lifecycle account and its fixed Global authority.
    await db.admin.query(
      'UPDATE access.account SET membership_inverse_complete=true WHERE route=$1 AND account_id=$2',
      [routeOf(accountId), accountId],
    );
    await db.admin.query(
      `INSERT INTO access.resource_role_grant
       (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
       VALUES(0,$1,'identity',$2,'','platform.governance','[2020-01-01T00:00:00Z,)',$2)`,
      [GLOBAL_CONTEXT, accountId],
    );
    const actor = await access.authenticate(real.bearer('voter'), { pool: db.pool, deadline: Date.now() + 120_000 });
    const subject = async (route: number) => {
      const key = crypto.randomUUID();
      return (
        await createSubject(db.pool, {
          actor,
          deadline: Date.now() + 120_000,
          authorization: await accessCommandAuthorization(
            access,
            actor,
            'subject:create',
            global,
            { pool: db.pool, deadline: Date.now() + 120_000 },
            () => new Error('Denied native fixture creation'),
          ),
          target: { route, id: newId(route) },
          idempotencyKey: key,
          digest: new Uint8Array(32).fill(7),
          item: { type: 'schema:Book', labels: { en: 'Counted prefix anchor' } },
          release: { digest: bundledDigest, release: bundledRelease },
        })
      ).subject.id;
    };
    // Two fixed Subject homes, separate from the account and standard question; no random fan-out per scale.
    const original = await subject(0x6a20);
    const terminal = await subject(0x6a30);
    const clear = await subject(0x6a30);
    const absent = await subject(0x6a30);
    const voterRoute = routeOf(actor.accountId)!;
    const sourceRoute = routeOf(original!)!;
    const controlHome = partitionOf(routeOf(terminal!)!);
    const missing = newId(routeOf(absent!)!);
    const otherQuestion = newId(sourceRoute);
    await db.admin.query(
      `INSERT INTO rating.question(id,revision,label,grain,minimum_units,maximum_units,step_units)
       VALUES($1,1,'Unselected fixture question','work',0,100,1)`,
      [otherQuestion],
    );
    const request = { actor, targetIds: [original!, clear!, absent!, missing, original!] };
    const transaction = newId(voterRoute);
    const pendingJob = newId(sourceRoute);

    // Physical fixtures retain an already-published legacy alias. Native merge/repair outcomes remain in
    // own-votes-page.test.ts; these fixtures vary storage prefixes without varying the admitted mapping.
    await db.admin.query(
      `INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
       VALUES($1,$2,1000000,$3,$4)`,
      [sourceRoute, original, terminal, transaction],
    );
    await db.admin.query(
      `UPDATE semantic.identity_epoch_mapping SET terminal=$3,control_group=$3,control_partition=$4,
         closure_state='legacy' WHERE route=$1 AND original=$2`,
      [sourceRoute, original, terminal, controlHome],
    );
    const group = (
      await db.admin.query(
        'SELECT generation FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2',
        [controlHome, terminal],
      )
    ).rows[0];
    if (!group) throw new Error('Expected the native terminal authority');
    const vote = (target: string, units: number | null, counted: string | null = target) => ({
      route: voterRoute,
      voter_id: actor.accountId,
      question_id: STANDARD_QUESTION_ID,
      target_id: target,
      units,
      revision: 1,
      counted_revision: 1,
      counted_target: counted,
      changed_at: at,
      transaction_id: transaction,
    });
    const storedSubject = (id: string) => ({
      route: sourceRoute,
      subject_id: id,
      type: 'schema:Book',
      recorded_transaction_id: transaction,
      current_facts: 0,
      current_release: bundledDigest,
    });
    await seed(
      db,
      {
        name: 'fixed counted slots',
        hotPartition: partitionOf(voterRoute),
        rows: () => ({ 'rating.vote': [vote(terminal!, 0), vote(clear!, null), vote(original!, 9, null)] }),
      },
      { from: 0, to: 1 },
    );
    // The native INSERT trigger initializes counting; retained losing slots are a later explicit state.
    await db.admin.query('UPDATE rating.vote SET counted_target=NULL WHERE route=$1 AND voter_id=$2 AND target_id=$3', [
      voterRoute,
      actor.accountId,
      original,
    ]);

    const measured = new AsyncLocalStorage<Record<string, number>>();
    const phase = new AsyncLocalStorage<'prepare' | 'read' | 'finish'>();
    const observed = new WeakSet<PoolClient>();
    const observeClient = (client: PoolClient) => {
      if (observed.has(client)) return;
      observed.add(client);
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((...args: unknown[]) => {
        const counters = measured.getStore();
        if (!counters) return query(...args);
        counters.poolQueries!++;
        counters[`${phase.getStore() ?? 'fixture'}Queries`]!++;
        const materialized = (result: QueryResult | QueryResult[]) => {
          // Include controls and empty/negative query results; the shared harness owns plans and wire bytes.
          for (const page of Array.isArray(result) ? result : [result]) {
            counters.materializedRows! += page.rows.length;
            counters.materializedBytes! += bytes(page.rows);
          }
          return result;
        };
        // pool.query uses a callback to release its checkout. Preserve that calling convention exactly.
        const last = args.length - 1;
        if (typeof args[last] === 'function') {
          const callback = args[last] as (error: Error | null, result: QueryResult) => unknown;
          args[last] = (error: Error | null, result: QueryResult) => {
            if (!error) materialized(result);
            return callback(error, result);
          };
          return query(...args);
        }
        return (query(...args) as Promise<QueryResult>).then(materialized);
      }) as PoolClient['query'];
    };
    db.pool.on('acquire', observeClient);
    const retain = (value: unknown) => {
      const counters = measured.getStore();
      if (counters) counters.retainedBytes! += bytes(value);
    };
    const prepare = access.prepare!.bind(access);
    const authorize = access.authorize.bind(access);
    const mappings = identityEpochStore.readMappings.bind(identityEpochStore);
    const commandPhase = commandTiming.commandPhase;
    const epoch = identityEpochStore.readEpoch.bind(identityEpochStore);
    const spies = [
      spyOn(JSON, 'stringify').mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
        const result = stringify(...args);
        const counters = measured.getStore();
        if (counters && result !== undefined) counters.serializedBytes! += Buffer.byteLength(result);
        return result;
      }) as typeof JSON.stringify),
      spyOn(commandTiming, 'commandPhase').mockImplementation((...args) => {
        const counters = measured.getStore();
        if (counters) counters.runnerPhases!++;
        return commandPhase(...args);
      }),
      spyOn(access, 'prepare').mockImplementation(async (...args) => {
        const counters = measured.getStore();
        if (counters) counters.accessPreparations!++;
        const result = await prepare(...args);
        retain(result);
        return result;
      }),
      spyOn(access, 'authorize').mockImplementation(async (...args) => {
        const counters = measured.getStore();
        if (counters) counters.accessEvaluations!++;
        const result = await authorize(...args);
        retain(result);
        return result;
      }),
      spyOn(identityEpochStore, 'readEpoch').mockImplementation(async (...args) => {
        const result = await epoch(...args);
        retain(result);
        return result;
      }),
      spyOn(identityEpochStore, 'readMappings').mockImplementation(async (...args) => {
        const counters = measured.getStore();
        if (counters) counters.mappingCollections!++;
        const result = await mappings(...args);
        retain(result);
        return result;
      }),
    ];
    const reader = createOwnCountedVoteReader({ pool: db.pool, access: access });

    async function journey() {
      const counters = measured.getStore()!;
      const deadline = Date.now() + 120_000;
      counters.preparePhases!++;
      const prepared = await phase.run('prepare', () => reader.prepare(request, deadline));
      retain(prepared);
      expect(bytes(prepared)).toBeLessThanOrEqual(byteCap);
      if (prepared.status !== 'prepared') throw new Error(`Unexpected preparation: ${JSON.stringify(prepared)}`);
      counters.readPhases!++;
      const read = await phase.run('read', () =>
        withReadTransaction(db.pool, (client) => reader.read(client, request, prepared.preparation), deadline),
      );
      retain(read);
      expect(bytes(read)).toBeLessThanOrEqual(byteCap);
      return { prepared, read, deadline };
    }
    async function finish(j: Awaited<ReturnType<typeof journey>>) {
      measured.getStore()!.finishPhases!++;
      const result = await phase.run('finish', () =>
        reader.finish(request, j.prepared.preparation, j.read, j.deadline),
      );
      retain(result);
      const size = bytes(result);
      expect(size).toBeLessThanOrEqual(byteCap);
      JSON.stringify(result);
      return result;
    }
    async function current() {
      const result = await finish(await journey());
      expect(result).toMatchObject({
        status: 'current',
        requestedTargetIds: [original, clear, absent, missing],
        observations: [
          {
            requestedTargetId: original,
            countingTargetId: terminal,
            originalTargetId: terminal,
            state: 'counted',
            units: 0,
          },
          { requestedTargetId: clear, state: 'clear', units: null },
          { requestedTargetId: absent, state: 'absent' },
          { requestedTargetId: missing, state: 'unavailable' },
        ],
      });
      if (result.status === 'current')
        for (const observation of result.observations)
          if ('review' in observation)
            expect(Buffer.byteLength(observation.review.ownVote.observation)).toBeLessThanOrEqual(4096);
    }

    return {
      database: db,
      async operation(): Promise<CountedValues> {
        const counters = Object.fromEntries(
          [
            'preparePhases',
            'readPhases',
            'finishPhases',
            'accessPreparations',
            'accessEvaluations',
            'mappingCollections',
            'poolQueries',
            'materializedRows',
            'materializedBytes',
            'retainedBytes',
            'serializedBytes',
            'cleanupStatements',
            'runnerPhases',
            'prepareQueries',
            'readQueries',
            'finishQueries',
            'fixtureQueries',
          ].map((key) => [key, 0]),
        );
        await measured.run(counters, async () => {
          await current();
          // Eventless losing-slot cleanup invalidates a read even though the effective zero stays unchanged.
          const stale = await journey();
          const removed = await db.pool.query(
            'DELETE FROM rating.vote WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND target_id=$4 AND counted_target IS NULL RETURNING target_id',
            [voterRoute, actor.accountId, STANDARD_QUESTION_ID, original],
          );
          expect(removed.rowCount).toBe(1);
          try {
            expect(await finish(stale)).toMatchObject({
              status: 'preparing',
              reason: 'vote-changed',
              retry: 'same-input',
            });
            await current();
          } finally {
            await db.pool.query(
              `INSERT INTO rating.vote(route,voter_id,question_id,target_id,units,revision,counted_revision,counted_target,changed_at,transaction_id)
              VALUES($1,$2,$3,$4,9,1,1,NULL,$5,$6)`,
              [voterRoute, actor.accountId, STANDARD_QUESTION_ID, original, at, transaction],
            );
            await db.pool.query(
              'UPDATE rating.vote SET counted_target=NULL WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND target_id=$4',
              [voterRoute, actor.accountId, STANDARD_QUESTION_ID, original],
            );
            counters.cleanupStatements! += 2;
          }
          // Relevant pending authority is a negative observation, then the identical request retries after cleanup.
          await db.pool.query(
            'UPDATE semantic.identity_epoch_group SET pending_job=$3,pending_epoch=published_epoch+1 WHERE partition_no=$1 AND terminal=$2',
            [controlHome, terminal, pendingJob],
          );
          try {
            counters.preparePhases!++;
            const pending = await phase.run('prepare', () => reader.prepare(request, Date.now() + 120_000));
            retain(pending);
            expect(pending).toMatchObject({ status: 'preparing', reason: 'identity-pending', retry: 'same-input' });
          } finally {
            await db.pool.query(
              'UPDATE semantic.identity_epoch_group SET pending_job=NULL,pending_epoch=NULL WHERE partition_no=$1 AND terminal=$2',
              [controlHome, terminal],
            );
            counters.cleanupStatements!++;
          }
          await current();
        });
        return counters;
      },
      async grow(axis: CountedAxis, scale: number, previous: number) {
        const sourceHome = partitionOf(sourceRoute);
        const originals = new Map<number, string>();
        if (axis === 'selected retained votes' || axis === 'identity/source/authority history') {
          // Complete the referenced subjects before dependent batches; a batch can split within an ordinal.
          await seed(
            db,
            {
              name: `counted ${axis} originals`,
              hotPartition: sourceHome,
              rows: ({ ordinal }) => {
                const id = newId(sourceRoute);
                originals.set(ordinal, id);
                return { 'semantic.subject': [storedSubject(id)] };
              },
            },
            { from: previous, to: scale },
          );
        }
        await seed(
          db,
          {
            name: `counted ${axis}`,
            hotPartition: axis.includes('votes') || axis === 'repair backlog' ? partitionOf(voterRoute) : sourceHome,
            rows: ({ ordinal }): Record<string, readonly Row[]> => {
              const id = originals.get(ordinal) ?? newId(sourceRoute);
              if (axis === 'unrelated votes')
                return {
                  'rating.vote': [
                    { ...vote(id, 11), voter_id: newId(voterRoute) },
                    { ...vote(id, 11), question_id: otherQuestion },
                    vote(id, 11),
                  ],
                };
              if (axis === 'selected retained votes')
                return {
                  'rating.vote': [vote(id, 7, null)],
                  // These are losing original slots of this selected destination, rather than arbitrary nulls.
                  // Their original identities grow, while the supplied source's own history stays fixed.
                  'semantic.redirect': [
                    {
                      route: sourceRoute,
                      subject_id: id,
                      sequence: 1,
                      target: terminal,
                      recorded_transaction_id: transaction,
                    },
                  ],
                  'semantic.identity_epoch_mapping': [
                    {
                      route: sourceRoute,
                      original: id,
                      terminal,
                      epoch: 1,
                      origin: 'published',
                      control_partition: controlHome,
                      control_group: terminal,
                      recorded_transaction_id: transaction,
                    },
                  ],
                };
              if (axis === 'repair backlog')
                return {
                  'rating.identity_repair_receipt': [
                    {
                      route: voterRoute,
                      voter_id: actor.accountId,
                      page_id: id,
                      work_id: pendingJob,
                      generation: 1,
                      digest: 'f'.repeat(64),
                      transaction_id: transaction,
                      terminal: false,
                      mode: 'repair',
                      obligation_id: pendingJob,
                      mapping_digest: 'e'.repeat(64),
                    },
                  ],
                  'rating.identity_work_frame': [
                    {
                      route: voterRoute,
                      voter_id: newId(voterRoute),
                      generation: 1,
                      work_id: pendingJob,
                      state: 'active',
                      mode: 'repair',
                    },
                  ],
                };
              return {
                'access.resource_role_grant': [
                  {
                    route: sourceRoute,
                    resource_id: original,
                    subject_kind: 'identity',
                    subject_id: actor.accountId,
                    subject_role: '',
                    grant_role: 'platform.governance',
                    valid: `[${new Date(Date.UTC(2000, 0, 1, ordinal)).toISOString()},${new Date(Date.UTC(2000, 0, 1, ordinal + 1)).toISOString()})`,
                    transaction_id: transaction,
                  },
                ],
                'semantic.redirect': [
                  {
                    route: sourceRoute,
                    subject_id: original,
                    sequence: ordinal + 1,
                    target: terminal,
                    recorded_transaction_id: transaction,
                  },
                ],
                'semantic.identity_epoch_mapping': [
                  {
                    route: sourceRoute,
                    original: id,
                    terminal,
                    epoch: 1,
                    origin: 'published',
                    control_partition: controlHome,
                    control_group: terminal,
                    recorded_transaction_id: transaction,
                  },
                ],
                'semantic.identity_epoch_group': [
                  {
                    partition_no: controlHome,
                    terminal: newId(routeOf(terminal!)!),
                    observed_count: 1,
                    owner_epoch: 1,
                  },
                ],
                'semantic.identity_epoch_original': [
                  {
                    partition_no: controlHome,
                    generation: group.generation,
                    original: id,
                    terminal,
                    source_partition: sourceHome,
                    source_generation: 1,
                    present: true,
                  },
                ],
              };
            },
          },
          { from: previous, to: scale },
        );
        if (axis === 'selected retained votes')
          await db.admin.query(
            `UPDATE rating.vote SET counted_target=NULL WHERE route=$1 AND voter_id=$2 AND question_id=$3
           AND target_id<>ALL($4::uuid[]) AND counted_target IS NOT NULL`,
            [voterRoute, actor.accountId, STANDARD_QUESTION_ID, [terminal, clear]],
          );
        // Count the exact physical prefix, not a global table size or returned DTO cardinality.
        const prefixes = {
          'unrelated votes': [
            'SELECT count(*)::int n FROM rating.vote WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND counted_target IS NOT NULL',
            [voterRoute, actor.accountId, STANDARD_QUESTION_ID],
            2,
          ],
          'selected retained votes': [
            'SELECT count(*)::int n FROM rating.vote WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND counted_target IS NULL',
            [voterRoute, actor.accountId, STANDARD_QUESTION_ID],
            1,
          ],
          'identity/source/authority history': [
            'SELECT count(*)::int n FROM semantic.redirect WHERE route=$1 AND subject_id=$2 AND sequence<1000000',
            [sourceRoute, original],
            0,
          ],
          'repair backlog': [
            'SELECT count(*)::int n FROM rating.identity_repair_receipt WHERE route=$1 AND voter_id=$2 AND work_id=$3',
            [voterRoute, actor.accountId, pendingJob],
            0,
          ],
        } as const;
        const [sql, values, fixed] = prefixes[axis];
        expect((await db.admin.query(sql, [...values])).rows).toEqual([{ n: scale + fixed }]);
      },
      async close() {
        for (const spy of spies) spy.mockRestore();
        db.pool.off('acquire', observeClient);
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
