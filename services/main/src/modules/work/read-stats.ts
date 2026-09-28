import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Pool, PoolClient } from 'pg';
import { reviewTarget } from '../review/read.ts';
import { reviewVisibleSql } from '../review/store.ts';
import { iri } from './activate.ts';
import { readId, readPosition } from './read-contract.ts';
import { publicWork, WorkReadMissing, type WorkReadSession } from './read-session.ts';

/**
 * One stats read asks the graph once (the review Context's target check, or
 * the Work's public check without one), probes Content's `(work, agent)`
 * shelf index for at most 10,001 rows, checks at most 10,000 of those Agents
 * in one Access eligibility query and probes Access's `(context, work)`
 * review index for at most 10,001 rows. Every SQL statement runs read-only
 * under a one-second timeout. Larger populations are reported as lower bounds.
 */
export const WORK_STATS_COST = { graphQueries: 1, readerProbe: 10_000, reviewProbe: 10_000,
  sqlStatements: { readerCounts: 8, reviews: 4 }, sqlStatementMs: 1_000 } as const;

export const statCount = t.Object({ value: t.Integer({ minimum: 0 }),
  kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) });
export type StatCount = Static<typeof statCount>;
export const workStatsQuery = t.Object({ actingSubject: t.Optional(readId),
  /** The rating question whose reviews are counted, as the Work page shows them; none counts no reviews. */
  context: t.Optional(readId) }, { additionalProperties: false });
export const workStats = t.Object({ profile: t.Literal('work-reader-stats-v1'), work: readId,
  /** People whose public Person library has the Work on its Currently reading shelf. */
  reading: statCount,
  /** People whose public Person library has the Work on Want to read. */
  wantToRead: statCount,
  /** Visible reviews answering `context`; null when the read named none. */
  reviews: t.Nullable(statCount), sourcePosition: readPosition });

const WORK = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const bounded = (found: number, probe: number): StatCount =>
  ({ value: Math.min(found, probe), kind: found > probe ? 'lower-bound' : 'exact' });

async function readOnly<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${WORK_STATS_COST.sqlStatementMs}ms'`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/**
 * A Work's reader numbers for its page. Only public Person libraries count,
 * as they do for author pages and "Readers also enjoyed": a private or
 * followers-only shelf never feeds a public number, and only the number
 * leaves this owner. Reviews count as the Work's reviews list shows them.
 */
export class WorkReaderStats {
  constructor(private readonly content: Pool, private readonly access: Pool) {}

  async readers(work: string, status: 'reading' | 'want-to-read'): Promise<StatCount> {
    if (!WORK.test(work)) throw new RangeError('Work is not a REZICS id');
    // Literal status queries use their respective partial (work, agent) indexes.
    const source = status === 'reading' ? 'reading' : 'want-to-read';
    const candidates = await readOnly(this.content, async client => (await client.query<{ agent: string }>(`
      SELECT agent FROM reader.library_status WHERE work = $1 AND status = '${source}'
      ORDER BY agent LIMIT ${WORK_STATS_COST.readerProbe + 1}`, [work])).rows);
    const agents = candidates.slice(0, WORK_STATS_COST.readerProbe).map(row => row.agent);
    if (!agents.length) return bounded(0, WORK_STATS_COST.readerProbe);
    const visible = await readOnly(this.access, async client => Number((await client.query<{ count: string }>(`
      SELECT count(DISTINCT provision.agent_id)::text AS count
      FROM access.agent_provision provision
      JOIN access.principal p ON p.id = provision.principal_id AND p.active
      JOIN access.authority_subject s ON s.id = provision.agent_id AND s.active
      JOIN access.agent_library_visibility v ON v.agent_id = provision.agent_id AND v.visibility = 'public'
      WHERE provision.agent_id = ANY($1::text[]) AND provision.state = 'active'
        AND provision.agent_kind = 'person'`, [agents])).rows[0]!.count));
    // Past the probe some public readers were never checked: the count is at least what was found.
    return { value: visible, kind: candidates.length > WORK_STATS_COST.readerProbe ? 'lower-bound' : 'exact' };
  }

  async reviews(context: string, work: string): Promise<StatCount> {
    if (!WORK.test(context) || !WORK.test(work)) throw new RangeError('Review target is not a REZICS id');
    const found = await readOnly(this.access, async client => Number((await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM (SELECT 1 FROM access.reader_review r
        JOIN access.authority_subject s ON s.id = r.acting_subject AND s.active
        WHERE r.context = $1 AND r.work = $2 AND NOT r.deleted AND ${reviewVisibleSql}
        LIMIT ${WORK_STATS_COST.reviewProbe + 1}) visible`, [context, work])).rows[0]!.count));
    return bounded(found, WORK_STATS_COST.reviewProbe);
  }
}

/**
 * The numbers under a public Work's rating: people currently reading it and,
 * for the rating question the page shows, its reviews. A Work that is not
 * public has no public readers to count and answers as missing.
 */
export async function readWorkStats(session: WorkReadSession, work: string, context: string | undefined,
  store: WorkReaderStats): Promise<Static<typeof workStats>> {
  // The review target check proves the Work public too; without a Context one query proves it alone.
  if (context) await reviewTarget(session, context, work);
  else if (!(await session.query(`SELECT ?main WHERE { ${publicWork(iri(work), '?main')} } LIMIT 2`, 2)).length) {
    throw new WorkReadMissing('Work is unavailable');
  }
  const [reading, wantToRead, reviews] = await Promise.all([store.readers(work, 'reading'),
    store.readers(work, 'want-to-read'), context ? store.reviews(context, work) : null]);
  return { profile: 'work-reader-stats-v1', work, reading, wantToRead, reviews, sourcePosition: session.position };
}
