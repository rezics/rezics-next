import { expect, test } from 'bun:test';
import type { AuthService } from '../src/index.ts';
import { operatorOpeningPageTransport, OPERATOR_OPENING_PAGE_PATH } from '../src/operator-opening-page.ts';

const issuer = 'https://opening.auth.test';
const service = { verifier: { issuer } } as AuthService;
const subjectAccountId = '00000000-0000-8000-8000-123400000001';
const operatorAccountId = '00000000-0000-8000-8000-123400000002';
const handler = operatorOpeningPageTransport(service, async () => new Response(null, { status: 418 }));
const request = (body: unknown, origin = issuer) =>
  new Request(`${issuer}${OPERATOR_OPENING_PAGE_PATH}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
test('opening advice rejects browser authority and treats absent composition as unavailable', async () => {
  for (const body of [
    { subjectAccountId },
    { subjectAccountId, operatorAccountId, kind: 'actor' },
    { subjectAccountId, operatorAccountId, human: {} },
  ]) {
    expect((await handler(request(body))).status).toBe(400);
  }
  expect((await handler(request({ subjectAccountId, operatorAccountId }, 'https://foreign.test'))).status).toBe(400);
  const response = await handler(request({ subjectAccountId, operatorAccountId }));
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ stage: 'unavailable' });
  expect((await handler(new Request(`${issuer}/adjacent`))).status).toBe(418);
});

test('opening projects opaque native ID maxima and closed selected fields before serialization', async () => {
  const { managementOperationProfile, OPERATOR_OPENING_PAGE_MAX_RESPONSE_BYTES: cap } =
    await import('@rezics/auth-contract');
  const profile = managementOperationProfile('opening');
  const human = {
    account_id: '\u0001'.repeat(1024),
    client_id: profile.client_id,
    scope: profile.scope,
    amr: ['pwd'],
    auth_time: 0,
    authn_epoch: 0,
  };
  let page = {
    stage: 'current',
    viewer: { accountId: 'ignored' },
    subject: { id: subjectAccountId, kind: 'actor' },
    operator: { id: operatorAccountId, kind: 'organization' },
    relation: { reservationId: subjectAccountId, version: '9223372036854775807' },
    disclosure: 'unavailable',
    allowedActions: ['opening'],
    privateLabel: 'never emitted',
  };
  const composed = operatorOpeningPageTransport(
    {
      verifier: { issuer },
      internal: {
        withFreshHuman: async (_: unknown, read: (proof: unknown) => unknown) => read(human),
        accessTokenForProof: async () => 'private-token',
      },
    } as unknown as AuthService,
    async () => new Response(),
    {
      readOperatorOpeningPage: async () => page as never,
    },
  );
  const read = () => composed(request({ subjectAccountId, operatorAccountId }));
  const response = await read();
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(new TextEncoder().encode(text).byteLength).toBe(cap);
  expect(JSON.parse(text).viewer.accountId).toBe(human.account_id);
  expect(text).not.toContain('privateLabel');
  for (const version of ['9223372036854775808', '01', '1'.repeat(10000)]) {
    page = { ...page, relation: { ...page.relation, version } };
    expect(await (await read()).json()).toEqual({ stage: 'unavailable' });
  }
  page.relation.version = '0';
  human.account_id += 'x';
  expect((await read()).status).toBe(503);
});
