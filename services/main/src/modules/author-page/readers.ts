import type { Pool } from 'pg';
import { AUTHOR_PAGE_COST } from './contract.ts';

const WORK = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/**
 * Counts only public Person libraries. The Content probe uses the partial
 * `(work, agent)` index; Access verifies the bounded candidate set against
 * live provision, principal, authority and visibility state. An incomplete
 * probe yields a lower bound. Only the number leaves this owner.
 */
export class AuthorReaders {
  constructor(private readonly pool: Pool, private readonly access: Pool) {}

  async count(works: readonly string[]): Promise<{ value: number; kind: 'exact' | 'lower-bound' }> {
    if (works.length > AUTHOR_PAGE_COST.works || works.some(work => !WORK.test(work))) {
      throw new RangeError('Author reader batch is out of bounds');
    }
    if (!works.length) return { value: 0, kind: 'exact' };
    const client = await this.pool.connect();
    let contentCommitted = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = '${AUTHOR_PAGE_COST.sqlStatementMs}ms'`);
      const candidates = (await client.query<{ agent: string }>(`
        SELECT DISTINCT agent FROM reader.library_status
        WHERE work = ANY($1::text[]) AND status IN ('reading', 'read')
        ORDER BY agent LIMIT ${AUTHOR_PAGE_COST.readerProbe + 1}`, [[...new Set(works)]])).rows;
      await client.query('COMMIT');
      contentCommitted = true;
      const agents = candidates.slice(0, AUTHOR_PAGE_COST.readerProbe).map(row => row.agent);
      if (!agents.length) return { value: 0, kind: 'exact' };
      const access = await this.access.connect();
      try {
        await access.query('BEGIN READ ONLY');
        await access.query(`SET LOCAL statement_timeout = '${AUTHOR_PAGE_COST.sqlStatementMs}ms'`);
        const visible = await access.query<{ count: string }>(`SELECT count(DISTINCT provision.agent_id)::text AS count
          FROM access.agent_provision provision
          JOIN access.principal p ON p.id = provision.principal_id AND p.active
          JOIN access.authority_subject s ON s.id = provision.agent_id AND s.active
          JOIN access.agent_library_visibility v ON v.agent_id = provision.agent_id AND v.visibility = 'public'
          WHERE provision.agent_id = ANY($1::text[]) AND provision.state = 'active'
            AND provision.agent_kind = 'person'`, [agents]);
        await access.query('COMMIT');
        return { value: Number(visible.rows[0]!.count),
          kind: candidates.length > AUTHOR_PAGE_COST.readerProbe ? 'lower-bound' : 'exact' };
      } catch (error) { await access.query('ROLLBACK'); throw error; }
      finally { access.release(); }
    } catch (error) { if (!contentCommitted) await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
