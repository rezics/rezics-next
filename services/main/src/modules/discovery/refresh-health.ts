import { t } from 'elysia';
import type { Pool } from 'pg';
import { inAccess, requireRecoveryOpen } from '../recommendation/derived-generation.ts';

export const DISCOVERY_REFRESH_HEALTH_COST = { candidates: 20, accessStatements: 6, graphCalls: 0 } as const;
export const discoveryRefreshHealth = t.Object({
  items: t.Array(t.Object({
    scopeKey: t.String({ pattern: '^[a-f0-9]{64}$' }),
    status: t.Union([t.Literal('skipped'), t.Literal('blocked')]),
    reason: t.Union([t.Literal('basis-unavailable'), t.Literal('basis-invalid'), t.Literal('inactive'), t.Literal('retry')]),
    retryAt: t.String({ format: 'date-time' }),
  }), { maxItems: DISCOVERY_REFRESH_HEALTH_COST.candidates }),
  truncated: t.Boolean(),
});
type Reason = 'basis-unavailable' | 'basis-invalid' | 'inactive' | 'retry';
// STABLE statement time can be an index bound; volatile clock_timestamp cannot:
// https://www.postgresql.org/docs/18/xfunc-volatility.html (reviewed 2026-10-04).
export const discoveryRefreshHealthSql = `
  SELECT scope_key,last_outcome,due_at FROM access.discovery_refresh
  WHERE due_at > statement_timestamp() + interval '1 second'
  ORDER BY due_at DESC,scope_key DESC LIMIT $1`;

/** Diagnostic sample of the longest deferrals. The due index bounds work even
 * with many healthy bases; this is not a census. Opaque keys disclose neither
 * private Realm identities nor Mine's owner. Readiness remains public-ranking
 * availability, regardless of a standing projection's deferred population. */
export async function readDiscoveryRefreshHealth(pool: Pool) {
  return inAccess(pool, async client => {
    await requireRecoveryOpen(client);
    const rows = (await client.query<{ scope_key: string; last_outcome: string | null; due_at: Date }>(
      discoveryRefreshHealthSql, [DISCOVERY_REFRESH_HEALTH_COST.candidates + 1])).rows;
    const items = rows.slice(0, DISCOVERY_REFRESH_HEALTH_COST.candidates).flatMap(row => {
      if (!['basis-unavailable', 'basis-invalid', 'inactive', 'retry'].includes(row.last_outcome ?? '')) return [];
      const reason = row.last_outcome as Reason;
      return [{ scopeKey: row.scope_key, status: reason === 'retry' ? 'blocked' as const : 'skipped' as const,
        reason, retryAt: row.due_at.toISOString() }];
    });
    return { items, truncated: rows.length > DISCOVERY_REFRESH_HEALTH_COST.candidates };
  });
}
