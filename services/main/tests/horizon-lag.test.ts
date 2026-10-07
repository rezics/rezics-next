import { expect, test } from 'bun:test';
import { lagAgeSeconds, reviewRankWaitingAge } from '../src/modules/horizon/lag.ts';

test('pending and writer ages distinguish empty sources and clamp future timestamps', () => {
  const now = new Date('2026-01-01T00:01:00Z');
  expect(lagAgeSeconds(now, null)).toBeNull();
  expect(lagAgeSeconds(now, new Date('2026-01-01T00:00:00Z'))).toBe(60);
  expect(lagAgeSeconds(now, new Date('2026-01-01T00:00:59.500Z'))).toBe(0.5);
  expect(lagAgeSeconds(now, new Date('2026-01-01T00:02:00Z'))).toBe(0);
});

test('review queue waiting age uses the enqueue clock and leaves an unstamped head unknown', () => {
  const now = new Date('2026-01-01T00:01:00Z');
  const enqueuedNow = new Date(now.getTime() - 2_000);
  expect(reviewRankWaitingAge(now, enqueuedNow, true)).toEqual({
    oldestPendingRowAgeSeconds: 2, oldestPendingRowAgeBasis: 'enqueue' });
  expect(reviewRankWaitingAge(now, null, true)).toEqual({
    oldestPendingRowAgeSeconds: null, oldestPendingRowAgeBasis: 'unknown' });
  expect(reviewRankWaitingAge(now, enqueuedNow, null)).toEqual({
    oldestPendingRowAgeSeconds: null, oldestPendingRowAgeBasis: 'none' });
});

test('operator readiness exposes the same lag sample and its observation time', async () => {
  const { observeHorizonLag } = await import('../src/modules/horizon/lag.ts');
  const { healthRoutes } = await import('../src/routes/health.ts');
  const { FusekiClient } = await import('../src/infrastructure/fuseki.ts');
  const now = new Date('2026-01-01T00:01:00Z');
  await observeHorizonLag({ query: async () => ({ rows: [{ now, writerVisibility: 'all-sessions',
    notification: new Date(now.getTime() - 5_000), reviewRank: null, reviewRankPending: null,
    editorial: new Date(now.getTime() - 10_000), writer: new Date(now.getTime() - 20_000) }] }) } as never);
  const fuseki = new FusekiClient('http://unused.invalid/');
  fuseki.query = async () => ({ boolean: true });
  const response = await healthRoutes(fuseki).handle(new Request('http://localhost/health/ready'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ready', horizons: {
    sampledAt: now.toISOString(), writerVisibility: 'all-sessions',
    notification: { oldestPendingRowAgeSeconds: 5, oldestWriterAgeSeconds: 20 },
    reviewRank: { oldestPendingRowAgeSeconds: null, oldestPendingRowAgeBasis: 'none', oldestWriterAgeSeconds: 20 },
    editorial: { oldestPendingRowAgeSeconds: 10, oldestWriterAgeSeconds: 20 },
  } });
});
