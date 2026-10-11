import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { GovernanceStore } from '../src/modules/governance/store.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const parent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const components = ['publication', 'structure', 'record'] as const;

function fixture(restricted?: readonly [string, string]) {
  const events: Array<{ kind: string; value?: string }> = [];
  const client = {
    query: async (sql: string, args?: unknown[]) => {
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
        events.push({ kind: 'lock', value: String(args?.[0]) });
      } else if (sql.includes('recovery_fence')) {
        return { rows: [{ open: true }], rowCount: 1 };
      } else if (sql.includes('governance_enforcement')) {
        const blocked = args?.[1] === restricted?.[0] && args?.[2] === restricted?.[1];
        events.push({ kind: 'fence-read', value: `${String(args?.[1])}:${String(args?.[2])}` });
        return { rows: blocked ? [{ active: true }] : [], rowCount: blocked ? 1 : 0 };
      } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        events.push({ kind: sql.toLowerCase() });
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => events.push({ kind: 'release' }),
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { store: new GovernanceStore(pool, {} as never, {} as never, {} as never), events };
}

test('publication fence shares restriction-writer locks through the native CAS dispatch', async () => {
  const { store, events } = fixture([parent, 'structure']);
  const result = await store.withPublicationFence([parent, work, work], async allowed => {
    events.push({ kind: 'native-cas', value: String(allowed) });
    return allowed ? 'published' : 'denied';
  });

  const lockKeys = events.filter(event => event.kind === 'lock').map(event => event.value);
  const expectedLockKeys = [work, parent].flatMap(resource => components.map(component =>
    JSON.stringify(['graph', resource, component]))).sort();
  expect(lockKeys).toEqual(expectedLockKeys);
  expect(result).toBe('denied');
  expect(events.filter(event => event.kind === 'fence-read')).toHaveLength(6);
  expect(events.findIndex(event => event.kind === 'lock'))
    .toBeLessThan(events.findIndex(event => event.kind === 'fence-read'));
  expect(events.findIndex(event => event.kind === 'fence-read'))
    .toBeLessThan(events.findIndex(event => event.kind === 'native-cas'));
  expect(events.findIndex(event => event.kind === 'native-cas'))
    .toBeLessThan(events.findIndex(event => event.kind === 'commit'));
  expect(events.at(-1)?.kind).toBe('release');
});

test('publication fence preserves native dispatch failures and releases its locks by rollback', async () => {
  const { store, events } = fixture();
  const failure = new Error('native CAS unavailable');

  await expect(store.withPublicationFence([work], async () => { throw failure; }))
    .rejects.toBe(failure);

  expect(events.some(event => event.kind === 'native-cas')).toBe(false);
  expect(events.at(-2)?.kind).toBe('rollback');
  expect(events.at(-1)?.kind).toBe('release');
  expect(events.some(event => event.kind === 'commit')).toBe(false);
});
