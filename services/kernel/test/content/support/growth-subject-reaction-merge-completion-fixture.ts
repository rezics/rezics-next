import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import readSubjectReactionMergePage from '../../../src/content/subject-reaction-merge-page.sql';
import { registerContent } from '../../../src/content/register.ts';
import { effectsRelay, type Effect } from '../../../src/events/effects.ts';
import { startRelays } from '../../../src/events/relays.ts';
import { newId } from '../../../src/route/route.ts';
import { composeWork, type WorkModule } from '../../../src/work/registry.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { observeSql } from './sql-observer.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import type { Population } from '../../support/growth.ts';

export type RegisteredMergeRuntime = Readonly<{
  pause(): Promise<void>;
  resume(): void;
  failSecondPageOnce(): void;
  pageReads(targetId: string): number;
  waitForWorkflow(workflowId: string): Promise<void>;
  close(): Promise<void>;
}>;

export function unrelatedMergePopulation(options: {
  axis: 'subjects' | 'actors' | 'history';
  unrelatedSubjectId: string;
  unrelatedSubjectRoute: number;
  historyActorId: string;
}): Population {
  const { axis, unrelatedSubjectId, unrelatedSubjectRoute, historyActorId } = options;
  return {
    name: `subject-reaction-merge-${axis}-${randomUUID().replaceAll('-', '')}`,
    hotPartition: axis === 'subjects' ? 3300 : axis === 'actors' ? 3400 : 3500,
    hotShare: 1,
    rows({ ordinal, route, partition }) {
      if (axis === 'subjects') {
        const subjectId = newId(route);
        return {
          'semantic.subject': [
            {
              route,
              subject_id: subjectId,
              type: 'schema:Book',
              recorded_transaction_id: subjectId,
            },
          ],
        };
      }
      if (axis === 'actors') {
        const actorId = newId(route);
        return {
          'content.reaction': [
            {
              route,
              actor_account_id: actorId,
              target_kind: 'subject',
              target_route: unrelatedSubjectRoute,
              target_id: unrelatedSubjectId,
              kind: 'like',
              updated_at: '2026-10-27T00:00:00Z',
            },
          ],
          'content.subject_reactor': [
            { route: unrelatedSubjectRoute, subject_id: unrelatedSubjectId, actor_account_id: actorId, kind: 'like' },
          ],
        };
      }
      return {
        'core.receipt': [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: historyActorId,
            command_kind: ordinal % 2 === 0 ? 'subject.merge' : 'content.reaction.set',
            idempotency_key: `retained-merge-${ordinal}-${randomUUID()}`,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position: 1_000_000 + ordinal,
            transaction_id: randomUUID(),
            response: { survivor: newId(0), redirected: newId(0) },
          },
        ],
      };
    },
  };
}

export async function primeEffectRelayAtCurrentHead(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO core.consumer_checkpoint (partition_no,consumer,epoch,position)
     SELECT partition_no,'effects',epoch,position FROM core.partition
     ON CONFLICT (partition_no,consumer) DO UPDATE
       SET epoch=EXCLUDED.epoch,position=EXCLUDED.position,updated_at=now()`,
  );
}

export async function startRegisteredMergeRuntime(options: {
  pool: Pool;
  databaseUrl: string;
  routeKey: Uint8Array;
  executorId: string;
}): Promise<RegisteredMergeRuntime> {
  const { pool, databaseUrl, routeKey, executorId } = options;
  // Native Auth owns DBOS during fixture setup. All identities are established before
  // this registered Content runtime takes the process-global executor.
  await DBOS.shutdown({ deregister: true });
  const client = await createWorkClient(databaseUrl, pool);
  const observer = observeSql(pool);
  const registered: Effect[] = [];
  const contentModule: WorkModule = {
    name: registerContent.name,
    register(context) {
      return registerContent.register({
        ...context,
        addEffects(effects) {
          registered.push(...effects);
          context.addEffects(effects);
        },
      });
    },
  };
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let relay: ReturnType<typeof startRelays> | undefined;
  try {
    work = await composeWork([contentModule], {
      databaseUrl,
      pool,
      client,
      executorId,
      env: workerTestEnv({
        CONTENT_TEST_COLLECTION_PARTITIONS: '0',
        KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
      }),
    });
    const projectionEffects = registered.filter((effect) => effect.name === 'content_reaction_count');
    const mergeEffects = registered.filter((effect) => effect.name === 'content_subject_reaction_merge');
    if (projectionEffects.length !== 1 || mergeEffects.length !== 1)
      throw new Error('Registered production Content did not install the reaction projection and merge effects');
    await work.launch();
    relay = startRelays(pool, [effectsRelay(pool, work.effects)], {
      intervalMs: 5,
      concurrency: Math.max(1, Math.min(2, (pool.options.max ?? 10) - 1)),
      paused: true,
    });
    return {
      async pause() {
        await relay!.pause();
      },
      resume() {
        relay!.resume();
      },
      failSecondPageOnce() {
        observer.armFault({
          match: { statement: readSubjectReactionMergePage.sql, occurrence: 2 },
          boundary: 'before',
          error: new Error('native subject reaction merge page retry after saved cursor'),
        });
      },
      pageReads(targetId) {
        return observer.records.filter(
          (record) =>
            record.statement === readSubjectReactionMergePage.sql &&
            record.parameters.some((value) => (Buffer.isBuffer(value) ? value.toString() : value) === targetId),
        ).length;
      },
      async waitForWorkflow(workflowId) {
        await client.retrieveWorkflow(workflowId).getResult({ pollingIntervalMs: 10 });
      },
      async close() {
        try {
          await relay!.stop();
        } finally {
          try {
            await work!.shutdown();
          } finally {
            try {
              await observer.close();
            } finally {
              await client.close();
            }
          }
        }
      },
    };
  } catch (error) {
    try {
      await relay?.stop();
    } finally {
      try {
        await work?.shutdown();
      } finally {
        try {
          await observer.close();
        } finally {
          await client.close();
        }
      }
    }
    throw error;
  }
}
