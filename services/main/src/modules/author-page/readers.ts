import type { Pool } from 'pg';
import { AUTHOR_PAGE_COST } from './contract.ts';

const WORK = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/**
 * Counts an author's readers from reader-owned shelf status. One read-only
 * statement over the partial `(work, agent)` index (Content migration 410)
 * stops after 10,001 distinct people, so the count is exact up to 10,000 and a
 * lower bound beyond. Only the number leaves this owner.
 */
export class AuthorReaders {
  constructor(private readonly pool: Pool) {}

  async count(works: readonly string[]): Promise<{ value: number; kind: 'exact' | 'lower-bound' }> {
    if (works.length > AUTHOR_PAGE_COST.works || works.some(work => !WORK.test(work))) {
      throw new RangeError('Author reader batch is out of bounds');
    }
    if (!works.length) return { value: 0, kind: 'exact' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${AUTHOR_PAGE_COST.sqlStatementMs}ms'`);
      const value = Number((await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM (
        SELECT DISTINCT agent FROM reader.library_status
        WHERE work = ANY($1::text[]) AND status IN ('reading', 'read')
        LIMIT ${AUTHOR_PAGE_COST.readerProbe + 1}) readers`, [[...new Set(works)]])).rows[0]!.count);
      await client.query('COMMIT');
      return value > AUTHOR_PAGE_COST.readerProbe ? { value: AUTHOR_PAGE_COST.readerProbe, kind: 'lower-bound' }
        : { value, kind: 'exact' };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
