import { expect, test } from 'bun:test';
import { createFollowFixtureFetch } from './outcome-driver.ts';

test('the Follow child routes only its configured JWKS URL to fixture Auth', async () => {
  const jwksUrl = 'https://ordinary.auth.test/.well-known/jwks.json';
  const handlerUrl = 'http://127.0.0.1:41000/.well-known/jwks.json';
  const otherInit = { method: 'POST' };
  const otherRequests = [new URL(`${jwksUrl}?cache=1`), new URL('https://ordinary.auth.test/profile')];
  const calls: { input: Parameters<typeof fetch>[0] | URL; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('ok');
  };
  const fetch = createFollowFixtureFetch(jwksUrl, handlerUrl, transport);

  await fetch(new Request(jwksUrl, { headers: { accept: 'application/jwk-set+json' } }));
  for (const input of otherRequests) await fetch(input, otherInit);

  expect(calls[0]?.input).toBeInstanceOf(Request);
  expect((calls[0]?.input as Request).url).toBe(handlerUrl);
  expect((calls[0]?.input as Request).headers.get('accept')).toBe('application/jwk-set+json');
  expect(calls.slice(1)).toEqual(otherRequests.map((input) => ({ input, init: otherInit })));
});
