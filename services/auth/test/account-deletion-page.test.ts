import { expect, test } from 'bun:test';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES, type SessionProof } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { AuthService } from '../src/index.ts';
import { accountDeletionPageTransport, ACCOUNT_DELETION_PAGE_PATH } from '../src/account-deletion-page.ts';

const issuer = 'https://deletion.auth.test';
const proof = {
  account_id: '00000000-0000-8000-8000-123400000001',
  ...{ client_id: AUTH_PAGE_OPERATION_CLIENT_ID, scope: [...AUTH_PAGE_OPERATION_SCOPES.delete] },
  amr: ['pwd'],
  authn_epoch: 1,
} as SessionProof;
function fixture(human = proof, advice: 'available' | 'refused' | 'changed' | 'unavailable' = 'available') {
  const calls: string[] = [];
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (_: unknown, work: (human: SessionProof) => unknown) => work(human),
      accessTokenForProof: async () => {
        calls.push('proof');
        return 'private-token';
      },
    },
  } as unknown as AuthService;
  const database = {
    query: async () => {
      calls.push('identity');
      return { rows: [{ id: human.account_id, email: 'person@example.test' }] };
    },
  } as unknown as Pool;
  const access = {
    readAccountDeletionAdvice: async () => {
      calls.push('advice');
      return { kind: advice };
    },
  };
  return {
    calls,
    handler: accountDeletionPageTransport(service, async () => new Response(null, { status: 418 }), database, access),
    missing: accountDeletionPageTransport(service, async () => new Response(null), database, undefined),
  };
}
const request = (body = '{}', headers = {}, query = '') =>
  new Request(issuer + ACCOUNT_DELETION_PAGE_PATH + query, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', ...headers },
    body,
  });

test('closed page transport never accepts caller authority or discloses private data before the exact profile', async () => {
  const { calls, handler } = fixture({ ...proof, client_id: 'ordinary', scope: [] });
  for (const input of [
    request('{"accountId":"other"}'),
    request('{}', { authorization: 'Bearer forged' }),
    request('{}', { origin: 'https://foreign.test' }),
    request('{}', {}, '?scope=account:delete'),
    request('[]'),
  ])
    expect((await handler(input)).status).toBe(400);
  const response = await handler(request());
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ kind: 'authentication-required', accountId: proof.account_id });
  expect(calls).toEqual(['proof']);
});

test.each(['available', 'refused', 'changed', 'unavailable'] as const)(
  'native %s is a read observation with closed display',
  async (kind) => {
    const { handler, calls } = fixture(proof, kind);
    const body = await (await handler(request())).json();
    if (kind === 'available' || kind === 'refused') {
      expect(body).toEqual({
        kind: 'review',
        accountId: proof.account_id,
        email: 'person@example.test',
        action: kind,
        policy: 'personal-deletion',
      });
      expect(calls).toEqual(['proof', 'advice', 'proof', 'identity', 'proof']);
    } else {
      expect(body).toEqual({ kind });
      expect(calls).not.toContain('identity');
    }
    expect(JSON.stringify(body)).not.toContain('private-token');
  },
);

test('missing binding stays unavailable and adjacent routes retain their handler', async () => {
  const { missing, handler, calls } = fixture();
  expect(await (await missing(request())).json()).toEqual({ kind: 'unavailable' });
  expect(calls).toEqual(['proof']);
  expect((await handler(new Request(issuer + ACCOUNT_DELETION_PAGE_PATH + '/'))).status).toBe(418);
});
