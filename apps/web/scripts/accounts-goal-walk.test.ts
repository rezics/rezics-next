import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { collectApiCapture, originalJ10, revokeWebsiteRefresh } from './accounts-goal-walk.ts';

const stack = {
  issuer: 'https://issuer.example.test',
  native: 'http://127.0.0.1:4400',
  web: 'http://127.0.0.1:3000',
  kernel: 'http://127.0.0.1:4100',
};
const fetchCalls: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis;
const request = spyOn(fetchCalls, 'fetch');
afterEach(() => request.mockReset());
afterAll(() => request.mockRestore());

test('J10 sends the exact confidential form to the discovered issuer endpoint without browser authority', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(privateKey)), kid: 'website' };
  const endpoint = `${stack.issuer}/oauth/refresh-family/revoke`;
  request.mockResolvedValueOnce(Response.json({ issuer: stack.issuer, revocation_endpoint: endpoint }));
  request.mockResolvedValueOnce(new Response(null, { status: 200 }));
  expect(
    (await revokeWebsiteRefresh(stack, { API_RESOURCE: 'https://api.example.test/exact/' }, key, 'refresh+&=')).status,
  ).toBe(200);
  expect(request.mock.calls[0]![0]).toBe(`${stack.issuer}/.well-known/openid-configuration`);
  const [url, init] = request.mock.calls[1]!;
  expect(url).toBe(endpoint);
  expect(init?.method).toBe('POST');
  expect([...new Headers(init?.headers)]).toEqual([['content-type', 'application/x-www-form-urlencoded']]);
  const fields = Object.fromEntries(new URLSearchParams(String(init?.body)));
  const proof = await jwtVerify(fields.client_assertion!, publicKey, {
    issuer: 'rezics-website',
    subject: 'rezics-website',
    audience: stack.issuer,
    algorithms: ['ES256'],
  });
  expect(proof.payload.aud).toBe(stack.issuer);
  expect([proof.protectedHeader.kid, proof.payload.exp! - proof.payload.iat!, typeof proof.payload.jti]).toEqual([
    'website',
    120,
    'string',
  ]);
  expect(fields).toEqual({
    client_id: 'rezics-website',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: fields.client_assertion!,
    resource: 'https://api.example.test/exact/',
    token: 'refresh+&=',
    token_type_hint: 'refresh_token',
  });
});

test.each([
  [{ issuer: 'https://foreign.example.test', revocation_endpoint: `${stack.issuer}/revoke` }, 'issuer does not match'],
  [{ issuer: stack.issuer }, 'omitted revocation_endpoint'],
  [{ issuer: stack.issuer, revocation_endpoint: 'https://foreign.example.test/revoke' }, 'endpoint does not match'],
] as const)('J10 refuses unusable issuer metadata before sending the refresh token: %j', async (metadata, error) => {
  request.mockResolvedValueOnce(Response.json(metadata));
  await expect(revokeWebsiteRefresh(stack, {}, {}, 'refresh')).rejects.toThrow(error);
  expect(request).toHaveBeenCalledTimes(1);
});

test('J10 retains the revoke refusal and reads with its original bearer again', async () => {
  const accountId = '00000000-0000-8000-8000-000000000001';
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(privateKey)), kid: 'website' };
  const endpoint = `${stack.issuer}/revoke`;
  request.mockResolvedValueOnce(Response.json({ accountId }, { status: 201 }));
  request.mockResolvedValueOnce(
    Response.json(
      { account_id: accountId, client_id: 'login', scope: [] },
      { headers: { 'set-cookie': 'fixture=opaque; Path=/' } },
    ),
  );
  request.mockImplementationOnce(async (url) => {
    const callback = new URL('/auth/callback', stack.web);
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('state', new URL(String(url)).searchParams.get('state')!);
    return Response.redirect(callback, 302);
  });
  request.mockResolvedValueOnce(Response.json({ access_token: 'fixture-bearer', refresh_token: 'fixture-refresh' }));
  request.mockResolvedValueOnce(Response.json({ accountId }));
  request.mockResolvedValueOnce(Response.json({ issuer: stack.issuer, revocation_endpoint: endpoint }));
  request.mockResolvedValueOnce(Response.json({ error: 'invalid_request' }, { status: 400 }));
  request.mockResolvedValueOnce(Response.json({ accountId }));

  const unused = async () => {
    throw new Error('Only J10 should run');
  };
  const [result] = await collectApiCapture(
    { J03: unused, J04: unused, J10: () => originalJ10(stack, {}, key) },
    async () => {},
    ['J10'],
  );
  expect(result).toMatchObject({
    id: 'J10',
    result: 'FAIL',
    firstFailingOperation: 'website refresh-family revoke: POST /revoke',
  });
  expect(result?.phases.slice(-2)).toMatchObject([
    { phase: 'website refresh-family revoke', status: 400 },
    { phase: 'original Kernel bearer read after revoke refusal', status: 200, bearerPresent: true },
  ]);
  const originalRead = request.mock.calls[4]!;
  const readAfterRefusal = request.mock.calls[7]!;
  expect(readAfterRefusal[0]).toBe(originalRead[0]);
  expect(new Headers(readAfterRefusal[1]?.headers).get('authorization')).toBe('Bearer fixture-bearer');
  expect(new Headers(originalRead[1]?.headers).get('authorization')).toBe('Bearer fixture-bearer');
  expect(JSON.stringify(result)).not.toContain('fixture-bearer');
});
