import { afterEach, expect, test } from 'bun:test';
import { creationFixture } from './creation-page-fixture';
import {
  loadOrganizationDeletion,
  readCurrentOrganizationForDeletion,
  executeOrganizationDeletion,
  organizationDeleteConfirmed,
  organizationDeleteConfirmation,
} from '../src/organization-deletion';
import { accountOperationProfile } from '../src/account-operation-step-up';
import { readOrganizationDeleteUnknown } from '../src/organization-delete-step-up';
import {
  organizationDeletionReadTransport,
  ORGANIZATION_DELETION_READ_PATH,
  type OrganizationDeletionRead,
} from '../../../services/auth/src/organization-deletion-read-transport';
import type { AuthService } from '../../../services/auth/src/index';
import type { SessionProof } from '@rezics/auth-contract';
creationFixture();
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const human = '10000000-0000-7000-8000-000000000001';
const organizationId = '20000000-0000-7000-8000-000000000002';
const issuer = 'https://auth.test';
const proof: SessionProof = {
  account_id: human,
  ...accountOperationProfile('delete'),
  authn_epoch: 1,
  auth_time: 1,
  amr: ['pwd'],
};
const account = { id: organizationId, kind: 'organization' as const, handle: 'selected', displayName: null };
function fixture() {
  let current = proof;
  let result: OrganizationDeletionRead = { kind: 'ready', account };
  let invalidate = false;
  const events: string[] = [];
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (_: unknown, work: (proof: SessionProof) => Promise<unknown>) => work(current),
      accessTokenForProof: async (value: SessionProof) => {
        events.push('session');
        expect(value).toBe(current);
        if (invalidate && events.includes('native')) throw { status: 401 };
        return 'server-only';
      },
    },
  } as unknown as AuthService;
  const handler = organizationDeletionReadTransport(service, async () => new Response(null, { status: 404 }), {
    readOrganizationForDeletion: async (input) => {
      events.push('native');
      expect(input.human).toBe(current);
      expect(input.organizationId).toBe(organizationId);
      return result;
    },
  });
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (path, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: String(path), body });
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    if (String(path) === '/session') return Response.json(current);
    if (String(path) === ORGANIZATION_DELETION_READ_PATH) {
      const response = await handler(
        new Request(issuer + path, { ...init, headers: { ...init.headers, origin: issuer } }),
      );
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return response;
    }
    return Response.json(
      String(path).endsWith('/approve')
        ? { reference: 'original', expiresAt: new Date(Date.now() + 60000).toISOString() }
        : { error: 'unavailable' },
      { status: String(path).endsWith('/approve') ? 200 : 503 },
    );
  }) as typeof fetch;
  return {
    calls,
    events,
    handler,
    profile: (value: SessionProof) => {
      current = value;
    },
    read: (value: OrganizationDeletionRead) => {
      result = value;
    },
    revoke: () => {
      events.length = 0;
      invalidate = true;
    },
  };
}
test('default review uses the real server session and preserves original deletion uncertainty', async () => {
  const f = fixture();
  const loaded = await loadOrganizationDeletion(organizationId);
  expect(loaded.kind).toBe('ready');
  expect(f.events).toEqual(['session', 'native', 'session']);
  expect(f.calls[1]).toEqual({ path: ORGANIZATION_DELETION_READ_PATH, body: { organizationId } });
  expect(JSON.stringify(f.calls)).not.toContain('server-only');
  if (loaded.kind !== 'ready') throw new Error('review unavailable');
  expect(organizationDeleteConfirmed('@SELECTED', organizationDeleteConfirmation(loaded.target, 'fallback'))).toBe(
    true,
  );
  const key = 'a'.repeat(32);
  expect(await executeOrganizationDeletion(loaded.target, key)).toEqual({ ok: false, reason: 'unknown' });
  const approve = f.calls.find((call) => call.path.endsWith('/approve'))!;
  expect(approve.body).toEqual({ operationKey: key, operation: { kind: 'delete', accountId: organizationId } });
  const saved = readOrganizationDeleteUnknown(organizationId);
  expect(saved.kind).toBe('pending');
  const count = f.calls.length;
  expect(await executeOrganizationDeletion(loaded.target, key)).toEqual({ ok: false, reason: 'unknown' });
  expect(f.calls).toHaveLength(count);
  expect(readOrganizationDeleteUnknown(organizationId)).toEqual(saved);
});
test('default review distinguishes safe outcomes and refuses changed sessions, profiles and identities', async () => {
  const f = fixture();
  for (const kind of ['hidden', 'denied', 'missing', 'unavailable'] as const) {
    f.read({ kind });
    expect(await loadOrganizationDeletion(organizationId)).toEqual({ kind });
  }
  f.read({ kind: 'ready', account: { ...account, id: human } });
  expect(await loadOrganizationDeletion(organizationId)).toEqual({ kind: 'unavailable' });
  f.read({ kind: 'ready', account: { ...account, email: 'secret' } } as OrganizationDeletionRead);
  expect(await loadOrganizationDeletion(organizationId)).toMatchObject({
    kind: 'ready',
    target: { handle: 'selected' },
  });
  for (const profile of [
    { ...proof, scope: ['account:delete', 'account:read'] },
    { ...proof, client_id: 'website' },
  ]) {
    f.profile(profile);
    expect(await loadOrganizationDeletion(organizationId)).toEqual({ kind: 'denied' });
  }
  f.profile({ ...proof, account_id: '30000000-0000-7000-8000-000000000003' });
  expect(await readCurrentOrganizationForDeletion({ humanAccountId: human, organizationId })).toEqual({
    kind: 'denied',
  });
  f.profile(proof);
  f.revoke();
  expect(await loadOrganizationDeletion(organizationId)).toEqual({ kind: 'signed-out' });
  expect(f.events).toEqual(['session', 'native', 'session']);
});
test('review transport rejects browser identity, bearer and cross-origin inputs before native I/O', async () => {
  const f = fixture();
  for (const [body, headers] of [
    [{ organizationId, humanAccountId: human }, {}],
    [{ organizationId }, { authorization: 'Bearer browser' }],
    [{ organizationId }, { origin: 'https://foreign.test' }],
    [{ organizationId }, { 'sec-fetch-site': 'cross-site' }],
  ] as const) {
    const response = await f.handler(
      new Request(issuer + ORGANIZATION_DELETION_READ_PATH, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
  }
  expect(f.events).toEqual([]);
});
