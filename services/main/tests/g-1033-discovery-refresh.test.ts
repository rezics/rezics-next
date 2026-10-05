import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { discoveryRetryDelay, DISCOVERY_REFRESH_COST } from '../src/modules/discovery/refresh-store.ts';
import { discoveryRankingHealth, readDiscoveryRankingHealth } from '../src/modules/discovery/public-ranking.ts';
import { readDiscoveryRefreshHealth, DISCOVERY_REFRESH_HEALTH_COST } from '../src/modules/discovery/refresh-health.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { Pool } from 'pg';

test('G1033: transient backoff is bounded even after a long outage', () => {
  expect(['1', '2', '3', '4', '5', '999999999999999999'].map(discoveryRetryDelay))
    .toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  expect(discoveryRetryDelay('1')).toBe(DISCOVERY_REFRESH_COST.retryMs);
});

test('G1033: a bounded deferred-basis sample hides private identities and marks truncation', async () => {
  let statements = 0;
  const client = { release: () => {}, query: async (sql: string, parameters?: unknown[]) => {
    statements++;
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }] };
    if (!sql.includes('discovery_refresh')) return { rows: [] };
    expect(parameters).toEqual([DISCOVERY_REFRESH_HEALTH_COST.candidates + 1]);
    expect(sql).toContain('ORDER BY due_at DESC,scope_key DESC LIMIT $1');
    return { rows: Array.from({ length: DISCOVERY_REFRESH_HEALTH_COST.candidates + 1 }, (_, index) => ({
      scope_key: index.toString(16).padStart(64, '0'),
      last_outcome: index === 0 ? 'retry' : index === 1 ? 'current' : 'basis-unavailable',
      due_at: new Date('2026-10-04T00:00:00Z'),
      basis: { realm: 'private Realm', owner: 'private owner' },
    })) };
  } };
  const pool = { connect: async () => client } as unknown as Pool;
  const sample = await readDiscoveryRefreshHealth(pool);
  expect(sample.truncated).toBe(true);
  expect(sample.items).toHaveLength(DISCOVERY_REFRESH_HEALTH_COST.candidates - 1);
  expect(sample.items[0]).toMatchObject({ status: 'blocked', reason: 'retry' });
  expect(sample.items[1]).toMatchObject({ status: 'skipped', reason: 'basis-unavailable' });
  expect(JSON.stringify(sample)).not.toContain('private');
  expect(statements).toBeLessThanOrEqual(DISCOVERY_REFRESH_HEALTH_COST.accessStatements);
});

test('G1033: deferred bases and unavailable diagnostics never downgrade a serving public ranking', async () => {
  const position = { dataEpoch: 'epoch', sequence: '42' };
  const sample = { items: [{ scopeKey: 'a'.repeat(64), status: 'skipped', reason: 'basis-unavailable',
    retryAt: '2026-10-04T00:00:00Z' }], truncated: false };
  const session = { position, deps: {
    recommendations: { publicRankingBuildFailure: async () => null, publicRankingStatus: async () => ({ ...position, generation: '00000000-0000-4000-8000-000000001033' }) },
    discovery: { refreshHealth: async () => sample },
  } } as unknown as WorkReadSession;
  const health = await readDiscoveryRankingHealth(session);
  expect(Value.Check(discoveryRankingHealth, health)).toBe(true);
  expect(health).toMatchObject({ status: 'ready', refresh: sample });
  session.deps.discovery!.refreshHealth = async () => { throw new Error('diagnostic store unavailable'); };
  expect(await readDiscoveryRankingHealth(session)).toMatchObject({ status: 'ready', refresh: null });
});
