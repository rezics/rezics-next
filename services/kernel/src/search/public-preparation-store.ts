import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { discardConnection, withBoundedReadConnection, withConnection } from '../database/pool.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { deadlineFor } from '../request/deadline.ts';
import { enqueueWorkIntent, type WorkClient } from '../work/client.ts';
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
  const intent = (id: string, revision: string, notBefore = Date.now()) => ({
    queue: 'maintenance' as const,
    workflowName: PUBLIC_PREPARATION_WORKFLOW,
    workflowId: `search.publicPreparation:${id}:${revision}`,
    input: { accounts: [], id, prefix, revision, notBefore },
  });
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
      return transaction(deadline, async (client) => {
        const result = await client.query<{ id: string; revision: string }>(
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
          RETURNING id, revision::text`,
          [prefix, randomUUID(), locator.kind, JSON.stringify(locator), Date.now(), expiresAt],
        );
        const row = result.rows[0]!;
        await enqueueWorkIntent(work, client, intent(row.id, row.revision));
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
          await enqueueWorkIntent(work, client, intent(record.id, next.revision, Date.now() + delayMs));
        // If the caller or a competing delivery cannot claim this ready
        // successor, due() can still discover the committed revision.
        return next?.revision ?? null;
      });
    },
    async due(deadline = deadlineFor(PUBLIC_PREPARATION_BUDGET_MS)): Promise<void> {
      await transaction(deadline, async (client) => {
        // CASE reads the uncleared lease; later SET assignments see earlier ones.
        const rows = await client.query<{ id: string; revision: string }>(
          `
          UPDATE search.public_preparation
          SET revision = CASE WHEN lease_until > 0 THEN revision + 1 ELSE revision END,
            lease_until = 0
          WHERE (partition_no, id) IN (SELECT partition_no, id FROM search.public_preparation
          WHERE partition_no = 0 AND prefix = $1 AND due_at <= $2 AND lease_until <= $2
          ORDER BY due_at, id LIMIT 16 FOR UPDATE SKIP LOCKED)
          RETURNING id, revision::text`,
          [prefix, Date.now()],
        );
        for (const row of rows.rows) await enqueueWorkIntent(work, client, intent(row.id, row.revision));
      });
    },
  };
}
