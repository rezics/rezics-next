import { afterEach, expect, spyOn, test } from 'bun:test';
import { grantPlatformResource, type PlatformGrantSession } from '../fixtures/platform-grant.ts';

const session: PlatformGrantSession = {
  mainOrigin: 'https://main.example', token: 'administrator-token',
  actingSubject: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  principalId: '00000000-0000-4000-8000-000000000002',
};
const recipient = '00000000-0000-4000-8000-000000000003';
const scopeId = 'semantic:read:https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const validUntil = '2026-10-08T12:00:00.000Z';
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
afterEach(() => { fetchMock?.mockRestore(); fetchMock = undefined; });

test('resource grants read fresh authority and issue only the exact requested capability', async () => {
  const writes: { key: string | null; body: Record<string, unknown> }[] = [];
  let reads = 0;
  fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer administrator-token');
    if (url.pathname === '/v1/access/grants') {
      expect(url.searchParams.get('issuerSubject')).toBe(session.actingSubject);
      expect(url.searchParams.get('profile')).toBe('platform-grants-v1');
      return Response.json({ authorityEpoch: String(++reads) });
    }
    expect(url.pathname).toBe('/v1/access/grant-changes');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    writes.push({ key: new Headers(init?.headers).get('idempotency-key'), body });
    return Response.json({ authorityEpoch: String(reads + 1), grant: { id: body.grantId, generation: '1' } });
  });
  const first = await grantPlatformResource(session, recipient, 'semantic.read', scopeId, validUntil);
  const second = await grantPlatformResource(session, recipient, 'semantic.read', scopeId, validUntil);
  expect(reads).toBe(2);
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toEqual({
    profile: 'platform-grant-change-v1', issuerSubject: session.actingSubject,
    expectedAuthorityEpoch: '1', action: 'create', grantId: first.grantId,
    permission: 'platform:resource:semantic.read', scopeId, recipient: { principalId: recipient }, validUntil,
  });
  expect(writes[1]!.body.expectedAuthorityEpoch).toBe('2');
  expect(first).toEqual({ grantId: writes[0]!.body.grantId, generation: '1', authorityEpoch: '2',
    permission: 'platform:resource:semantic.read', principalId: recipient, scopeId });
  expect(first.grantId).not.toBe(second.grantId);
  expect(writes[0]!.key).toBeString();
  expect(writes[0]!.key).not.toBe(writes[1]!.key);
});

test('invalid recipients and wildcard scopes never reach the grant API', async () => {
  fetchMock = spyOn(globalThis, 'fetch');
  await expect(grantPlatformResource(session, 'bad-id', 'semantic.read', scopeId)).rejects.toThrow('principal id');
  await expect(grantPlatformResource(session, recipient, 'semantic.read', 'semantic:read:*')).rejects.toThrow('exact scope');
  await expect(grantPlatformResource(session, recipient, 'platform:grant', scopeId)).rejects.toThrow('action is invalid');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a denied authority read does not issue a grant', async () => {
  fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ code: 'grant_denied' }, { status: 403 }));
  await expect(grantPlatformResource(session, recipient, 'semantic.read', scopeId)).rejects.toThrow('HTTP 403');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a stale grant fails with its native code so the caller can reread before reapplying', async () => {
  fetchMock = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ authorityEpoch: '1' }))
    .mockResolvedValueOnce(Response.json({ code: 'grant_stale' }, { status: 409 }));
  await expect(grantPlatformResource(session, recipient, 'semantic.read', scopeId)).rejects.toThrow('grant_stale');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('an unconfirmed grant result fails rather than claiming resource authority', async () => {
  fetchMock = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ authorityEpoch: '1' }))
    .mockResolvedValueOnce(Response.json({ authorityEpoch: '2', grant: { id: recipient, generation: '1' } }));
  await expect(grantPlatformResource(session, recipient, 'semantic.read', scopeId)).rejects.toThrow('did not confirm');
});
