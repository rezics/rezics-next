import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export class FactsConflict extends Error {}
export class FactsTooLarge extends Error {}

/** One indexed read per public Work; writes lock one Work and one receipt key.
 * A single record is at most 16 KiB, so there is no unbounded release or
 * alternative history hiding in this read. */
export const FACTS_COST = { maxBytes: 16_384, maxRows: 1, maxStatementsPerWrite: 5 } as const;
export interface SavedFacts<T> { work: string; revision: number; facts: T }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The table name is a closed constructor choice, never caller input. */
export class RevisionedFactsStore<T extends object> {
  private readonly table: string;
  private readonly receipts: string;
  constructor(private readonly pool: Pool, kind: 'game' | 'software') {
    this.table = `access.${kind}_facts`;
    this.receipts = `access.${kind}_facts_receipt`;
  }

  async read(work: string): Promise<SavedFacts<T> | null> {
    const result = await this.pool.query<SavedFacts<T>>(
      `SELECT work, revision, facts FROM ${this.table} WHERE work = $1`, [work]);
    return result.rows[0] ?? null;
  }

  /** The receipt reserves the key before the Work lock, so concurrent retries
   * return the first result and an older key can replay after later edits. */
  async write(principalId: string, key: string, work: string, expectedRevision: number | null,
    facts: T, actor: string): Promise<SavedFacts<T>> {
    const bytes = Buffer.byteLength(JSON.stringify(facts));
    if (bytes > FACTS_COST.maxBytes) throw new FactsTooLarge('facts exceed the 16 KiB budget');
    const digest = createHash('sha256').update(canonical({ work, expectedRevision, facts, actor })).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const reserved = await client.query(
        `INSERT INTO ${this.receipts} (principal_id, idempotency_key, request_digest)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING idempotency_key`, [principalId, key, digest]);
      if (!reserved.rowCount) {
        const prior = (await client.query<{ request_digest: string; result: SavedFacts<T> | null }>(
          `SELECT request_digest, result FROM ${this.receipts}
           WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
        if (!prior || prior.request_digest !== digest || !prior.result) throw new FactsConflict('idempotency key differs');
        await client.query('COMMIT');
        return prior.result;
      }
      const current = (await client.query<{ revision: number }>(
        `SELECT revision FROM ${this.table} WHERE work = $1 FOR UPDATE`, [work])).rows[0];
      if ((current?.revision ?? null) !== expectedRevision) throw new FactsConflict('facts revision moved');
      const revision = (current?.revision ?? 0) + 1;
      if (current) await client.query(
        `UPDATE ${this.table} SET revision = $2, facts = $3, updated_at = clock_timestamp() WHERE work = $1`,
        [work, revision, JSON.stringify(facts)]);
      else await client.query(`INSERT INTO ${this.table} (work, revision, facts) VALUES ($1,$2,$3)`,
        [work, revision, JSON.stringify(facts)]);
      const result = { work, revision, facts };
      await client.query(`UPDATE ${this.receipts} SET result = $3 WHERE principal_id = $1 AND idempotency_key = $2`,
        [principalId, key, JSON.stringify(result)]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new FactsConflict('facts revision moved');
      throw error;
    } finally { client.release(); }
  }
}
