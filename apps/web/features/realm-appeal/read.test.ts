import { afterAll, expect, test } from 'bun:test';
import { replaceModule } from '../../tests/support/module-replacement.ts';

const originalHeaders = { ...(await import('next/headers')) };
const originalServerRead = { ...(await import('../api/server-read.ts')) };

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const actingSubject = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000dd';
const moderator = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000cc';
const realmId = realm.slice(-36);
const receiptId = '00000000-0000-4000-8000-0000000000aa';

let groups: readonly string[] = [];
const requested: string[] = [];

const banBody = {
  realm, receiptId, action: 'ban', reason: 'Posted the same chapter five times.',
  bannedUntil: null, permanent: true, happenedAt: '2026-10-01T12:00:00.000Z',
  decider: moderator, appeal: { state: 'none' },
};

const restoreHeaders = replaceModule(import.meta.resolve('next/headers'), originalHeaders, {
  cookies: async () => ({ get: () => ({ value: 'session-token' }) }),
  headers: async () => new Headers(),
});
const restoreServerRead = replaceModule(import.meta.resolve('../api/server-read.ts'), originalServerRead, {
  serverRead: async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/platform-access')) {
      return Response.json({ groups, operations: [], generation: '1' });
    }
    return Response.json(banBody);
  },
});
afterAll(() => {
  restoreHeaders();
  restoreServerRead();
});

const { readOwnRealmBan } = await import('./read.ts');

const memberBan = `/v1/realms/${realmId}/member-ban?actingSubject=${encodeURIComponent(actingSubject)}`;

test('a closed member-ban read stays quiet and does not call the operation', async () => {
  groups = [];
  requested.length = 0;
  await expect(readOwnRealmBan(realm, actingSubject)).resolves.toBeNull();
  expect(requested.some(path => path.startsWith(`/v1/realms/${realmId}/member-ban`))).toBe(false);
});

test('an open member-ban read returns the ban without the decider', async () => {
  groups = ['realm-appeals'];
  requested.length = 0;
  const reading = await readOwnRealmBan(realm, actingSubject);
  expect(requested).toContain(memberBan);
  expect(reading).toMatchObject({
    realm, receiptId, action: 'ban', reason: banBody.reason, appeal: { state: 'none' },
  });
  expect(JSON.stringify(reading)).not.toContain(moderator);
});
