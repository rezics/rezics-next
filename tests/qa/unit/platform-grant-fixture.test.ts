import { expect, test } from 'bun:test';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

const principal = '00000000-0000-4000-8000-000000001329';
const issuer = 'https://rezics.com/id/00000000-0000-4000-8000-000000001328';

function recordedGrant(existing = false) {
  const writes: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    writes,
    db: { async query(sql: string, values: readonly unknown[] = []) {
      if (/\b(?:UPDATE|DELETE)\b/.test(sql)) throw new Error('Platform episodes are immutable');
      if (sql.includes('SELECT id FROM access.principal_permission_grant')) {
        return { rows: existing ? [{ id: 'existing-live-grant' }] : [] };
      }
      writes.push({ sql, values });
      return { rows: [] };
    } },
  };
}

test('recorded platform fixture sets finite expiry before its immutable episode is recorded', async () => {
  const fixture = recordedGrant();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  await grantRecordedPlatformUse(fixture.db, principal, ['catalogue-import'], issuer, expiresAt);
  const grant = fixture.writes.find(row => row.sql.includes('INSERT INTO access.principal_permission_grant'))!;
  const episode = fixture.writes.find(row => row.sql.includes('INSERT INTO access.platform_grant_episode'))!;
  expect(grant.values[4]).toBe(expiresAt);
  expect(grant.values.slice(1, 4)).toEqual([issuer, principal, 'platform:use:catalogue-import']);
  expect(episode.values[0]).toBe(grant.values[0]);
  expect(episode.values.slice(1, 4)).toEqual([issuer, 'platform:use:catalogue-import', principal]);
  expect(fixture.writes.indexOf(episode)).toBeGreaterThan(fixture.writes.indexOf(grant));
});

test('recorded platform fixture preserves a live grant and its original expiry', async () => {
  const fixture = recordedGrant(true);
  await grantRecordedPlatformUse(fixture.db, principal, ['catalogue-import'], issuer,
    new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString());
  expect(fixture.writes.some(row => row.sql.includes('permission_grant') || row.sql.includes('platform_grant_episode'))).toBe(false);
});

test('recorded platform fixture retains the permanent default for existing callers', async () => {
  const fixture = recordedGrant();
  await grantRecordedPlatformUse(fixture.db, principal, ['catalogue-import']);
  expect(fixture.writes.find(row => row.sql.includes('INSERT INTO access.principal_permission_grant'))!.values[4]).toBe('infinity');
});

test('invalid and expired platform fixture lifetimes fail before any authority write', async () => {
  const fixture = recordedGrant();
  for (const expiry of ['', 'infinity', 'invalid', new Date(Date.now() - 1000).toISOString()]) {
    await expect(grantRecordedPlatformUse(fixture.db, principal, ['catalogue-import'], issuer, expiry))
      .rejects.toThrow('Platform use expiry must be a future timestamp');
  }
  expect(fixture.writes).toHaveLength(0);
});
