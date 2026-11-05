import { expect, test } from 'bun:test';
import { AUTH_MANAGEMENT_CLIENT_ID, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from '../src/index.ts';
import {
  accountManagementMembershipTransport,
  type MembershipCommandState,
} from '../src/account-management-membership-transport.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const memberAccountId = '00000000-0000-4000-8000-000000000002';
const reservationId = '00000000-0000-4000-8000-000000000003';
const selection = { organizationId, memberAccountId };
const human: SessionProof = {
  account_id: memberAccountId,
  client_id: AUTH_MANAGEMENT_CLIENT_ID,
  scope: ['organization:membership'],
  authn_epoch: 1,
  auth_time: 1,
  amr: ['pwd'],
};
const issuer = 'https://membership.auth.test';
// Transport boundary fixture only; the kernel test uses actual Auth proof and Access.
function fixture(proof = human, result: unknown = { ...selection, membership: { role: 'member', reservationId } }) {
  const calls: unknown[] = [];
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (_: unknown, work: (proof: SessionProof) => Promise<unknown>) => work(proof),
    },
  } as unknown as AuthService;
  const access = {
    async readOrganizationMembershipCommandState(input: unknown): Promise<MembershipCommandState> {
      calls.push(input);
      return result as MembershipCommandState;
    },
  };
  return {
    calls,
    service,
    access,
    handler: accountManagementMembershipTransport(service, async () => new Response(null, { status: 404 }), access),
  };
}
function request(body: unknown = selection, headers: Record<string, string> = {}) {
  return new Request(`${issuer}/account-management/organizations/member`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
test('selected membership transport forwards only selection and live exact-profile proof with closed no-store output', async () => {
  const f = fixture();
  const response = await f.handler(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ...selection, membership: { role: 'member', reservationId } });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ ...selection, human });
  expect(await (await fixture(human, { ...selection, membership: null }).handler(request())).json()).toEqual({
    ...selection,
    membership: null,
  });
});
test('selected membership transport denies extra fields, cross-site requests, wrong profiles, unavailable bindings and unknown sources', async () => {
  const f = fixture();
  expect((await f.handler(request({ ...selection, principal: organizationId }))).status).toBe(400);
  expect((await f.handler(request(selection, { origin: 'https://foreign.test' }))).status).toBe(400);
  expect((await f.handler(request(selection, { 'sec-fetch-site': 'cross-site' }))).status).toBe(400);
  expect(f.calls).toHaveLength(0);
  expect(
    (await fixture({ ...human, scope: ['organization:membership', 'account:read'] }).handler(request())).status,
  ).toBe(403);
  expect((await fixture({ ...human, client_id: 'login' }).handler(request())).status).toBe(403);
  const missing = accountManagementMembershipTransport(f.service, async () => new Response(), undefined);
  expect((await missing(request())).status).toBe(503);
  expect((await fixture(human, { ...selection, membership: null, holders: [] }).handler(request())).status).toBe(503);
  expect((await fixture(human, { ...selection, membership: { role: 'member' } }).handler(request())).status).toBe(503);
});

test('selected response fits its own ceiling and invalid reservations never become absence', async () => {
  const { membershipResponseBytes } = await import('@rezics/auth-contract');
  const response = await fixture().handler(request());
  expect(new TextEncoder().encode(await response.text()).length).toBe(membershipResponseBytes.selected);
  for (const membership of [{ role: 'admin', reservationId }, { role: 'member', reservationId: 'opaque' }, {}]) {
    expect((await fixture(human, { ...selection, membership }).handler(request())).status).toBe(503);
  }
});
