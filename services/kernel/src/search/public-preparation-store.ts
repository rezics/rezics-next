import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { withConnection } from '../database/pool.ts';
import { enqueueWorkIntent, type WorkClient } from '../work/client.ts';
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

/** One scalar operational frontier. It never stores public rows, permissions, cuts or coverage. */
export function createPublicPreparationStore(pool: Pool, work: WorkClient, prefix: string) {
  const intent = (id: string, revision: string, notBefore = Date.now()) => ({
    queue: 'maintenance' as const,
    workflowName: PUBLIC_PREPARATION_WORKFLOW,
    workflowId: `search.publicPreparation:${id}:${revision}`,
    input: { accounts: [], id, prefix, revision, notBefore },
  });
  async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
    return withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        const value = await run(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  return {
    async retain(locator: PreparationLocator, expiresAt: number): Promise<string> {
      return transaction(async (client) => {
        const result = await client.query<{ id: string; revision: string }>(
          `
          INSERT INTO search.public_preparation(partition_no, prefix, id, kind, locator, due_at, expires_at)
          VALUES (0, $1, $2, $3, $4, $5, $6)
          ON CONFLICT (partition_no, prefix, kind, (locator ->> 'key')) DO UPDATE
            SET due_at = LEAST(search.public_preparation.due_at, EXCLUDED.due_at)
          RETURNING id, revision::text`,
          [prefix, randomUUID(), locator.kind, JSON.stringify(locator), Date.now(), expiresAt],
        );
        const row = result.rows[0]!;
        await enqueueWorkIntent(work, client, intent(row.id, row.revision));
        return row.id;
      });
    },
    async claim(id: string, revision: string, deadline: number): Promise<PreparationRecord | null> {
      const result = await pool.query<PreparationRecord>(
        `
        UPDATE search.public_preparation SET lease_until = $5, revision = revision + 1
        WHERE partition_no = 0 AND prefix = $1 AND id = $2 AND revision = $3
          AND lease_until <= $4 AND due_at <= $4
        RETURNING id, revision::text, locator, expires_at::text`,
        [prefix, id, revision, Date.now(), deadline],
      );
      return result.rows[0] ?? null;
    },
    async advance(record: PreparationRecord, locator: PreparationLocator | null, delayMs = 0): Promise<void> {
      await transaction(async (client) => {
        if (locator === null) {
          await client.query(
            `DELETE FROM search.public_preparation WHERE partition_no = 0 AND prefix = $1 AND id = $2 AND revision = $3`,
            [prefix, record.id, record.revision],
          );
          return;
        }
        const result = await client.query<{ revision: string }>(
          `
          UPDATE search.public_preparation SET locator = $4, revision = revision + 1, lease_until = 0, due_at = $5
          WHERE partition_no = 0 AND prefix = $1 AND id = $2 AND revision = $3
          RETURNING revision::text`,
          [prefix, record.id, record.revision, JSON.stringify(locator), Date.now() + delayMs],
        );
        const next = result.rows[0];
        if (next) await enqueueWorkIntent(work, client, intent(record.id, next.revision, Date.now() + delayMs));
      });
    },
    async due(): Promise<void> {
      await transaction(async (client) => {
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
