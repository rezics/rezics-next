import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { revokeWebsiteRefresh } from './accounts-goal-walk.ts';

const stack = {
  issuer: 'https://issuer.example.test',
  native: 'http://127.0.0.1:4400',
  web: 'http://127.0.0.1:3000',
  kernel: 'http://127.0.0.1:4100',
};
const request = spyOn(globalThis, 'fetch');
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
] as const)('J10 refuses unusable issuer metadata before sending the refresh token: %j', async (metadata, error) => {
  request.mockResolvedValueOnce(Response.json(metadata));
  await expect(revokeWebsiteRefresh(stack, {}, {}, 'refresh')).rejects.toThrow(error);
  expect(request).toHaveBeenCalledTimes(1);
});
