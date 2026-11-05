import { expect, test } from 'bun:test';
import {
  AUTH_PAGE_OPERATION_CLIENT_ID,
  AUTH_PAGE_OPERATION_SCOPES,
  ORGANIZATION_DELETION_MAX_RESPONSE_BYTES,
  type SessionProof,
} from '@rezics/auth-contract';
import {
  organizationDeletionReadTransport,
  organizationDeletionCaller,
  type OrganizationDeletionRead,
} from '../src/organization-deletion-read-transport.ts';
import type { AuthService } from '../src/index.ts';

const issuer = 'https://auth.test';
const human = '10000000-0000-7000-8000-000000000001';
const organizationId = '20000000-0000-7000-8000-000000000002';
const proof = {
  account_id: human,
  client_id: AUTH_PAGE_OPERATION_CLIENT_ID,
  scope: [...AUTH_PAGE_OPERATION_SCOPES.delete],
  amr: ['pwd'],
} as SessionProof;
const request = () =>
  new Request(issuer + '/account-management/organizations/deletion-review', {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  });

test('missing binding, native failure and a misbound private result never request privilege or disclose a target', async () => {
  let current = proof;
  let revoked = false;
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (_: unknown, work: (value: SessionProof) => unknown) => work(current),
      accessTokenForProof: async () => {
        if (revoked) throw { status: 401 };
        return 'secret';
      },
    },
  } as unknown as AuthService;
  const fallback = async () => new Response(null, { status: 418 });
  const read = async () => ({
    kind: 'ready' as const,
    account: { id: organizationId, kind: 'organization' as const, handle: 'private', displayName: null },
  });
  expect(await (await organizationDeletionReadTransport(service, fallback, undefined)(request())).json()).toEqual({
    kind: 'unavailable',
  });
  for (const fail of [true, false]) {
    const route = organizationDeletionReadTransport(service, fallback, {
      readOrganizationForDeletion: read,
      readOrganizationDeletionPage: async () => {
        if (fail) throw new Error('offline');
        return read();
      },
    });
    current = { ...proof, client_id: 'ordinary', scope: [] };
    expect(await (await route(request())).json()).toEqual({ kind: 'unavailable' });
  }
  current = proof;
  const route = organizationDeletionReadTransport(service, fallback, {
    readOrganizationForDeletion: read,
    readOrganizationDeletionPage: async () => {
      revoked = true;
      return read();
    },
  });
  expect(await (await route(request())).json()).toEqual({ kind: 'signed-out' });
  expect((await route(new Request(issuer + '/adjacent'))).status).toBe(418);
});

test('closed advice variants fit the derived response bound and oversized producer labels are unavailable', async () => {
  expect(ORGANIZATION_DELETION_MAX_RESPONSE_BYTES).toBe(30946);
  let current: SessionProof = proof;
  let readValue: OrganizationDeletionRead | { kind: 'authentication-required' } = { kind: 'hidden' };
  let failSession = false;
  let nativeReads = 0;
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (_: unknown, work: (value: SessionProof) => unknown) => work(current),
      accessTokenForProof: async () => {
        if (failSession) throw { status: 401 };
        return 'server-only';
      },
    },
  } as unknown as AuthService;
  const route = organizationDeletionReadTransport(service, async () => new Response(null, { status: 404 }), {
    readOrganizationForDeletion: async () => ({ kind: 'unavailable' }),
    readOrganizationDeletionPage: async ({ human: viewer }) => {
      if (!organizationDeletionCaller(viewer)) return { kind: 'authentication-required' };
      nativeReads++;
      return readValue;
    },
  });

  for (const kind of ['hidden', 'denied', 'missing', 'changed', 'unavailable'] as const) {
    readValue = { kind };
    expect(await (await route(request())).json()).toEqual({ kind });
  }

  const opaqueHumanId = '\u0001'.repeat(1024);
  current = { ...proof, account_id: opaqueHumanId };
  readValue = {
    kind: 'ready',
    account: {
      id: organizationId,
      kind: 'organization',
      handle: 'a'.repeat(64),
      displayName: '\u0001'.repeat(4096),
    },
  };
  const maximal = await route(request());
  const raw = await maximal.text();
  expect(new TextEncoder().encode(raw).byteLength).toBe(ORGANIZATION_DELETION_MAX_RESPONSE_BYTES);
  expect(JSON.parse(raw)).toMatchObject({
    kind: 'ready',
    humanAccountId: opaqueHumanId,
    account: { id: organizationId, handle: 'a'.repeat(64), displayName: '\u0001'.repeat(4096) },
  });

  readValue = {
    kind: 'ready',
    account: { id: organizationId, kind: 'organization', handle: 'private', displayName: '\u0001'.repeat(4097) },
  };
  expect(await (await route(request())).json()).toEqual({ kind: 'unavailable' });

  current = { ...proof, client_id: 'website', scope: [] };
  readValue = { kind: 'authentication-required' };
  expect(await (await route(request())).json()).toEqual({
    kind: 'authentication-required',
    humanAccountId: human,
    action: 'authenticate',
  });
  expect(nativeReads).toBe(7);

  failSession = true;
  expect(await (await route(request())).json()).toEqual({ kind: 'signed-out' });
});
