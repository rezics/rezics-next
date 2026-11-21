import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { discardConnection, withBoundedReadConnection, withConnection } from '../database/pool.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { deadlineFor } from '../request/deadline.ts';
import { DBOS_SCHEMA, enqueueWorkIntent, WORK_APPLICATION, type WorkClient } from '../work/client.ts';
import { TERMINAL_WORKFLOW_STATUSES } from '../work/contract/index.ts';
import { SearchUnavailableError } from './opensearch.ts';
import type { PublicFilterConsumerJob } from './public-filter-consumer-contract.ts';

export const PUBLIC_PREPARATION_WORKFLOW = 'search.publicPreparation';
export type PopulationFrontier = {
  kind: 'population';
  key: string;
  generation: number;
  uuid: string;
  meaning: string;
  publication: string | null;
  partition: number;
  epoch: number | null;
  through: string | null;
  after: { route: number; id: string } | null;
  phase: 'scan' | 'replay' | 'native' | 'activate';
  pending: { keys: string[]; after: { route: number; id: string } | null; complete: boolean; position: string } | null;
};
export type PreparationLocator = PopulationFrontier | { kind: 'repair'; key: string; job: PublicFilterConsumerJob };
export type PreparationRecord = {
  id: string;
  revision: string;
  locator: PreparationLocator;
  expires_at: string;
};

export const PUBLIC_PREPARATION_BUDGET_MS = 30_000;
const lifetimeOptions = {
  deadlineError: () => new SearchUnavailableError('Public preparation database deadline expired'),
  isUncertainSettledQueryError: () => true,
};

/** One scalar operational frontier. It never stores public rows, permissions, cuts or coverage. */
export function createPublicPreparationStore(pool: Pool, work: WorkClient, prefix: string) {
  // The sweep position is a scheduling hint. The native lease, revision and workflow remain authoritative.
  let sweep: Readonly<{ through: number; due: string; id: string }> | undefined;
  const schedule = (locator: PreparationLocator) =>
    locator.kind === 'repair' && locator.job.consumer.physicalTarget.startsWith(`${prefix}discovery-g`)
      ? 'discovery'
      : locator.kind;
  const intent = (id: string, revision: string, kind: ReturnType<typeof schedule>, notBefore = 0) => {
    const maintenance = kind === 'repair';
    return {
      queue: maintenance ? ('maintenance' as const) : ('workflows' as const),
      workflowName: PUBLIC_PREPARATION_WORKFLOW,
      workflowId: `${PUBLIC_PREPARATION_WORKFLOW}:${id}:${revision}${maintenance ? '' : ':' + kind}`,
      input: { accounts: [], id, prefix, revision, notBefore },
    };
  };
  async function transaction<T>(deadline: number, run: (client: PoolClient) => Promise<T>) {
    let closed = true;
    return withBoundedReadLifetime(
      (bounded) =>
        withConnection(pool, async (raw) => {
          try {
            return await bounded(raw);
          } finally {
            // The callback can outlive its deadline while enqueueing an intent. An
            // unfinished write transaction must never return to the reusable pool.
            if (!closed) discardConnection(raw, new Error('Public preparation transaction did not finish'));
          }
        }),
      discardConnection,
      deadline,
      async (client) => {
        closed = false;
        await client.query('BEGIN');
        try {
          const value = await run(client);
          await client.query('COMMIT');
          closed = true;
          return value;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
            closed = true;
          } catch {
            // Keep the original failure; checkout cleanup retires the client.
          }
          throw error;
        }
      },
      lifetimeOptions,
    );
  }
  return {
    async retain(
      locator: PreparationLocator,
      expiresAt: number,
      deadline = deadlineFor(PUBLIC_PREPARATION_BUDGET_MS),
    ): Promise<string> {
      const kind = schedule(locator);
      // Consumer JSON key order changes on a database round trip. The native
      // bootstrap or observation locator is stable across the read and worker.
      if (locator.kind === 'repair' && kind === 'discovery')
        locator = { ...locator, key: JSON.stringify([locator.job.consumer.physicalTarget, locator.job.job]) };
      return transaction(deadline, async (client) => {
        const result = await client.query<{ id: string; revision: string; lease_until: string }>(
          `
          INSERT INTO search.public_preparation AS stored
            (partition_no, prefix, id, kind, locator, due_at, expires_at)
          VALUES (0, $1, $2, $3, $4, $5, $6)
          ON CONFLICT (partition_no, prefix, kind, (locator ->> 'key')) DO UPDATE
            SET locator = CASE
                  WHEN stored.kind = 'population'
                    AND EXCLUDED.kind = 'population'
                    AND stored.locator ->> 'publication' IS NULL
                    AND (stored.locator ->> 'meaning') IS DISTINCT FROM (EXCLUDED.locator ->> 'meaning')
                  THEN EXCLUDED.locator
                  ELSE stored.locator
                END,
                revision = stored.revision + CASE
                  WHEN stored.kind = 'population'
                    AND EXCLUDED.kind = 'population'
                    AND stored.locator ->> 'publication' IS NULL
                    AND (stored.locator ->> 'meaning') IS DISTINCT FROM (EXCLUDED.locator ->> 'meaning')
                  THEN 1 ELSE 0
                END,
                lease_until = CASE
                  WHEN stored.kind = 'population'
                    AND EXCLUDED.kind = 'population'
                    AND stored.locator ->> 'publication' IS NULL
                    AND (stored.locator ->> 'meaning') IS DISTINCT FROM (EXCLUDED.locator ->> 'meaning')
                  THEN 0
                  ELSE stored.lease_until
                END,
                due_at = CASE
                  WHEN stored.kind = 'population'
                    AND EXCLUDED.kind = 'population'
                    AND stored.locator ->> 'publication' IS NULL
                    AND (stored.locator ->> 'meaning') IS DISTINCT FROM (EXCLUDED.locator ->> 'meaning')
                  THEN EXCLUDED.due_at
                  ELSE LEAST(stored.due_at, EXCLUDED.due_at)
                END
          RETURNING id, revision::text, lease_until::text`,
          [prefix, randomUUID(), locator.kind, JSON.stringify(locator), Date.now(), expiresAt],
        );
        const row = result.rows[0]!;
        // Claim already advanced the revision. Enqueuing that revision while a
        // delivery holds the lease creates a stale workflow when the holder saves.
        if (row.lease_until === '0') await enqueueWorkIntent(work, client, intent(row.id, row.revision, kind));
        return row.id;
      });
    },
    async claim(id: string, revision: string, deadline: number): Promise<PreparationRecord | null> {
      const result = await withBoundedReadConnection(
        pool,
        deadline,
        (client) =>
          client.query<PreparationRecord>(
            `
        UPDATE search.public_preparation SET lease_until = $5, revision = revision + 1
        WHERE partition_no = 0 AND prefix = $1 AND id = $2 AND revision = $3
          AND lease_until <= $4 AND due_at <= $4
        RETURNING id, revision::text, locator, expires_at::text`,
            [prefix, id, revision, Date.now(), deadline],
          ),
        lifetimeOptions,
      );
      return result.rows[0] ?? null;
    },
    async advance(
      record: PreparationRecord,
      locator: PreparationLocator | null,
      delayMs = 0,
      deadline = deadlineFor(PUBLIC_PREPARATION_BUDGET_MS),
      readySuccessor = false,
    ): Promise<string | null> {
      return transaction(deadline, async (client) => {
        if (locator === null) {
          await client.query(
            `DELETE FROM search.public_preparation WHERE partition_no = 0 AND prefix = $1 AND id = $2 AND revision = $3`,
            [prefix, record.id, record.revision],
          );
          return null;
        }
        const result = await client.query<{ revision: string }>(
          `
          UPDATE search.public_preparation SET locator = $4, revision = revision + 1, lease_until = 0, due_at = $5
          WHERE partition_no = 0 AND prefix = $1 AND id = $2 AND revision = $3
          RETURNING revision::text`,
          [prefix, record.id, record.revision, JSON.stringify(locator), Date.now() + delayMs],
        );
        const next = result.rows[0];
        if (next && (!readySuccessor || delayMs !== 0))
          await enqueueWorkIntent(
            work,
            client,
            intent(record.id, next.revision, schedule(locator), delayMs > 0 ? Date.now() + delayMs : 0),
          );
        // If the caller or a competing delivery cannot claim this ready
        // successor, due() can still discover the committed revision.
        return next?.revision ?? null;
      });
    },
    async due(deadline = deadlineFor(PUBLIC_PREPARATION_BUDGET_MS)): Promise<void> {
      const previous = sweep;
      const now = Date.now();
      const through = previous?.through ?? now;
      const next = await transaction(deadline, async (client) => {
        const rows = await client.query<{
          id: string;
          due: string;
          revision: string;
          kind: ReturnType<typeof schedule>;
        }>(
          `WITH candidates AS MATERIALIZED (
             SELECT partition_no,id,due_at,revision,lease_until,CASE WHEN kind='repair' AND
               starts_with(locator #>> '{job,consumer,physicalTarget}', $1 || 'discovery-g')
               THEN 'discovery' ELSE kind END AS kind
             FROM search.public_preparation
             WHERE partition_no=0 AND prefix=$1 AND due_at<=$2 AND lease_until<=$3
               ${previous ? 'AND (due_at,id)>($4::bigint,$5::uuid)' : ''}
             ORDER BY due_at,id LIMIT 16 FOR UPDATE SKIP LOCKED
           ), expired AS (
             UPDATE search.public_preparation p SET revision=p.revision+1,lease_until=0
             FROM candidates c WHERE (p.partition_no,p.id)=(c.partition_no,c.id) AND c.lease_until>0
             RETURNING p.id,p.revision
           ) SELECT c.id,c.due_at::text AS due,COALESCE(e.revision,c.revision)::text AS revision,c.kind
             FROM candidates c LEFT JOIN expired e USING(id) ORDER BY c.due_at,c.id`,
          previous ? [prefix, through, now, previous.due, previous.id] : [prefix, through, now],
        );
        if (!rows.rows.length) return;
        const deliveries = rows.rows.map((row) => ({ row, delivery: intent(row.id, row.revision, row.kind) }));
        const existing = await client.query<{ workflow_uuid: string; terminal: boolean }>(
          `SELECT workflow_uuid, status = ANY($4::text[]) AS terminal
           FROM ${DBOS_SCHEMA}.workflow_status
           WHERE workflow_uuid = ANY($1::text[]) AND name = $2 AND application_name = $3
           ORDER BY workflow_uuid FOR SHARE`,
          [
            deliveries.map(({ delivery }) => delivery.workflowId),
            PUBLIC_PREPARATION_WORKFLOW,
            WORK_APPLICATION,
            TERMINAL_WORKFLOW_STATUSES,
          ],
        );
        const terminalById = new Map(existing.rows.map((workflow) => [workflow.workflow_uuid, workflow.terminal]));
        for (const { row, delivery } of deliveries) {
          const terminal = terminalById.get(delivery.workflowId);
          if (terminal === undefined) {
            await enqueueWorkIntent(work, client, delivery);
          } else if (terminal) {
            // A workflow can finish before claiming (for example, during shutdown).
            // Fence that delivery and enqueue its replacement with the same locator in one commit.
            const next = await client.query<{ revision: string }>(
              `UPDATE search.public_preparation SET revision = revision + 1
               WHERE partition_no = 0 AND prefix = $1 AND id = $2 AND revision = $3
               RETURNING revision::text`,
              [prefix, row.id, row.revision],
            );
            await enqueueWorkIntent(work, client, intent(row.id, next.rows[0]!.revision, row.kind));
          }
        }
        // A fixed due time keeps new arrivals from extending the sweep indefinitely.
        // Commit the sealed page before advancing; another discoverer can safely replay it.
        const tail = rows.rows.at(-1)!;
        return rows.rows.length === 16 ? { through, due: tail.due, id: tail.id } : undefined;
      });
      if (sweep === previous) sweep = next;
    },
  };
}
