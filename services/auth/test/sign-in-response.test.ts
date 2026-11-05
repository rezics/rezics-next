import { expect, test } from 'bun:test';
import { signInResponseBytes } from '@rezics/auth-contract';
import { receiveAuthenticationOptions } from '../src/passkeys';

const options = {
  rpId: 'rezics.com',
  challenge: 'A'.repeat(43),
  timeout: 60000,
  userVerification: 'preferred',
} as const;
test('pinned plugin output is projected to required UV without losing the challenge cookie', async () => {
  const response = Response.json(options, { headers: { 'set-cookie': 'challenge=opaque; HttpOnly' } });
  expect(await receiveAuthenticationOptions(response)).toEqual({ ...options, userVerification: 'required' });
  expect(response.headers.getSetCookie()).toEqual(['challenge=opaque; HttpOnly']);
  expect(JSON.stringify(options).length).toBe(signInResponseBytes.pluginOptions);
});
test('plugin malformed or excess output is refused before publication, even with lying length', async () => {
  for (const body of [
    JSON.stringify({ ...options, extra: true }),
    JSON.stringify({ ...options, allowCredentials: [] }),
    JSON.stringify({ ...options, rpId: 'wrong.test' }),
    '{',
    'x'.repeat(signInResponseBytes.pluginOptions + 1),
  ]) {
    await expect(
      receiveAuthenticationOptions(new Response(body, { headers: { 'content-length': '1' } })),
    ).rejects.toThrow();
  }
});
