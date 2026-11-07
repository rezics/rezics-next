import { expect, test } from 'bun:test';
import { FIRST_PUBLIC_JOURNEYS } from '../scripts/semantic-first-public-inventory.ts';
import {
  handleCall,
  walkReadinessUrls,
  walkSeedProcessEnv,
  websiteAccessToken,
  websiteCredentialHeaders,
  websiteCredentialUrls,
} from '../scripts/semantic-first-public-native.ts';

const stack = {
  web: 'http://127.0.0.1:20020',
  issuer: 'http://127.0.0.1:20021',
  native: 'http://127.0.0.1:20022',
  kernel: 'http://127.0.0.1:20023',
};

test('the first-public walk names each of the 31 catalogue and Zone journeys once', () => {
  expect(FIRST_PUBLIC_JOURNEYS).toHaveLength(31);
  expect(new Set(FIRST_PUBLIC_JOURNEYS.map((row) => row.id)).size).toBe(31);
  expect(new Set(FIRST_PUBLIC_JOURNEYS.map((row) => row.name)).size).toBe(31);
});

test('editor website credentials POST the issuer Origin and keep native JWKS plus seed transport', async () => {
  const seen: { url: string; origin: string; cookie?: string }[] = [];
  const token = await websiteAccessToken(
    stack.issuer,
    { email: 'developer@rezics.test', password: 'secret', clientId: 'rezics-website', scope: 'openid' },
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const cookie = request.headers.get('cookie');
      seen.push({
        url: request.url,
        origin: request.headers.get('origin') ?? '',
        ...(cookie === null ? {} : { cookie }),
      });
      if (new URL(request.url).pathname === '/signin')
        return new Response('{}', { status: 200, headers: { 'set-cookie': 'session=walk; Path=/' } });
      return Response.json({ access_token: 'website-token' });
    }) as typeof fetch,
  );
  expect(token).toBe('website-token');
  expect(websiteCredentialUrls(stack.issuer)).toEqual({
    signin: `${stack.issuer}/signin`,
    token: `${stack.issuer}/token`,
  });
  expect(websiteCredentialHeaders(stack.issuer)).toEqual({
    origin: stack.issuer,
    'content-type': 'application/json',
  });
  expect(seen).toEqual([
    { url: `${stack.issuer}/signin`, origin: stack.issuer },
    { url: `${stack.issuer}/token`, origin: stack.issuer, cookie: 'session=walk' },
  ]);
  expect(seen.some((entry) => entry.url.startsWith(stack.native))).toBe(false);
  expect(walkReadinessUrls(stack)).toEqual({
    jwks: `${stack.native}/.well-known/jwks.json`,
    definitions: `${stack.kernel}/v1/definitions`,
    active: `${stack.kernel}/v1/definitions/active`,
  });
  const seed = walkSeedProcessEnv(stack, { REZICS_DEV_PERSONA_ACCOUNT: 'persona' }, { PATH: '/bin' });
  expect(seed.AUTH_ORIGIN).toBe(stack.native);
  expect(seed.REZICS_LOCAL_STACK_ISSUER_ORIGIN).toBe(stack.issuer);
  expect(seed.KERNEL_ORIGIN).toBe(stack.kernel);
  expect(seed.REZICS_DEV_PERSONA_ACCOUNT).toBe('persona');
});

test('native handleCall forwards bearer, If-Match and JSON bodies', async () => {
  const call = handleCall(
    async (request) => {
      expect(request.method).toBe('PATCH');
      expect(new URL(request.url).pathname).toBe('/v1/subjects/subject/terms');
      expect(request.headers.get('authorization')).toBe('Bearer editor-token');
      expect(request.headers.get('if-match')).toBe('"rev-1"');
      expect(await request.json()).toEqual({ labels: { en: 'Walk' } });
      return Response.json({ subject: { id: 'subject' } }, { headers: { etag: '"rev-2"' } });
    },
    (token) => token,
  );
  const answer = await call('PATCH', '/v1/subjects/subject/terms', {
    bearer: 'editor-token',
    ifMatch: 'rev-1',
    body: { labels: { en: 'Walk' } },
  });
  expect(answer.status).toBe(200);
  expect(answer.etag).toBe('"rev-2"');
  expect(answer.body).toEqual({ subject: { id: 'subject' } });
});
