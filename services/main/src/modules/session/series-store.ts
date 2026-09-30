import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import type { SessionOwner } from './store.ts';
import { sessionState, type SessionState } from './contract.ts';
import { SERIES_COST } from './series-policy.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, type ReadPosition } from '../work/read-session.ts';

export class SeriesSessionReader {
  constructor(private readonly pool: Pool) {}
  /** Indexed seeks per Work/selection in one round trip. At most (W+R)*257
   * candidate IDs, O((W+R)*257 log history) work, independent of older history. */
  async batch(owner: SessionOwner, works: string[], releases: string[], position: ReadPosition,
    cursor?: string, limit: number = SERIES_COST.sessions) {
    if (!Number.isInteger(limit) || limit < 1 || limit > SERIES_COST.sessions) throw new WorkReadInvalid('Invalid session batch size');
    const identity = [owner.principal.issuer, owner.principal.subject, owner.agent];
    const binding = ['series-sessions-v1', ...identity, works, releases];
    const after = decodeReadCursor(cursor, binding, position)?.after;
    const rows = await this.pool.query<{ state: SessionState; attempt_order: string }>(`
      WITH matches AS (
        SELECT s.id FROM unnest($4::text[]) AS w(work)
        CROSS JOIN LATERAL (SELECT id FROM reader.consumption_session
          WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND work = w.work
            AND ($6::bigint IS NULL OR attempt_order < $6)
          ORDER BY attempt_order DESC LIMIT $7) s
        UNION
        SELECT t.session FROM unnest($5::text[]) AS r(resource)
        CROSS JOIN LATERAL (SELECT session FROM reader.consumption_session_target
          WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND resource = r.resource
            AND ($6::bigint IS NULL OR attempt_order < $6)
          ORDER BY attempt_order DESC LIMIT $7) t
      ) SELECT s.state, s.attempt_order::text FROM matches m
        JOIN reader.consumption_session s ON s.id = m.id
        ORDER BY s.attempt_order DESC LIMIT $7`,
    [...identity, works, releases, after ?? null, limit + 1]);
    const page = rows.rows.slice(0, limit);
    for (const row of page) if (!Value.Check(sessionState, row.state)) throw new Error('Consumption session is corrupt');
    return { items: page.map(row => row.state), next: rows.rows.length > limit
      ? encodeReadCursor(binding, position, page.at(-1)!.attempt_order) : null };
  }
}
