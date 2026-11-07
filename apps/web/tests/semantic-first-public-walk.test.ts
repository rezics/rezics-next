import { expect, test } from 'bun:test';
import { FIRST_PUBLIC_JOURNEYS } from '../scripts/semantic-first-public-inventory.ts';
import { nativeWalkCall, type NativeObservation } from '../scripts/semantic-first-public-request.ts';
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

test('walk records exact native operands and readback while keeping sessions isolated by credential', async () => {
  const trace: NativeObservation[] = [];
  const requests: Request[] = [];
  const call = nativeWalkCall(stack.kernel, trace, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return Response.json(
      { revision: requests.length },
      { headers: { etag: '"revision"', 'rezics-session-token': 'causal-session', 'x-request-id': 'correlation' } },
    );
  }) as typeof fetch);
  const body = { labels: { en: 'Corrected' } };
  await call('PATCH', '/v1/subjects/id/terms', { bearer: 'editor-secret', ifMatch: '1', body });
  const answer = await call('GET', '/v1/subjects/id', { bearer: 'editor-secret', query: { language: 'ja' } });
  await call('GET', '/v1/subjects/id');
  expect(requests[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(trace[0]!.key));
  expect(requests[0]!.headers.get('if-match')).toBe('"1"');
  expect(await requests[0]!.json()).toEqual(body);
  expect(requests[1]!.headers.get('rezics-session-token')).toBe('causal-session');
  expect(requests[2]!.headers.get('rezics-session-token')).toBeNull();
  expect(requests[2]!.headers.get('authorization')).toBeNull();
  expect(trace[0]).toMatchObject({ method: 'PATCH', body, ifMatch: '1', status: 200, correlation: 'correlation' });
  expect(trace[1]).toMatchObject({ url: `${stack.kernel}/v1/subjects/id?language=ja`, response: { revision: 2 } });
  expect(trace[2]!.credential).toBe('anonymous');
  expect(JSON.stringify(trace)).not.toContain('editor-secret');
  expect(answer.etag).toBe('"revision"');
});

test('walk keeps a refused native response and an attempted transport failure in its trace', async () => {
  const trace: NativeObservation[] = [];
  const failure = new Error('connection closed');
  const call = nativeWalkCall(stack.kernel, trace, (async () => {
    if (trace.length === 1) return Response.json({ code: 'forbidden' }, { status: 403 });
    throw failure;
  }) as typeof fetch);
  expect((await call('POST', '/v1/statements/id/disclose', { bearer: 'outsider' })).status).toBe(403);
  expect(trace[0]).toMatchObject({ status: 403, response: { code: 'forbidden' } });
  await expect(call('GET', '/v1/subjects/id')).rejects.toBe(failure);
  expect(trace[1]).toEqual({ method: 'GET', url: `${stack.kernel}/v1/subjects/id`, credential: 'anonymous' });
});

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

test('native walk credentials use the first-party scope array and issuer identity over native transport', async () => {
  const { nativeWalkAccessToken } = await import('../scripts/semantic-first-public-native.ts');
  const requests: Request[] = [];
  const issue = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return requests.length === 1
      ? new Response('{}', { headers: { 'set-cookie': 'session=native; Path=/' } })
      : Response.json({ access_token: 'native-token' });
  }) as typeof fetch;
  expect(
    await nativeWalkAccessToken(
      stack,
      {
        email: 'developer@rezics.test',
        password: 'secret',
        clientId: 'rezics-dev-semantic-walk',
        scopes: ['subject:create', 'zone:configure'],
      },
      issue,
    ),
  ).toBe('native-token');
  expect(requests.map((request) => [request.method, request.url, request.headers.get('origin')])).toEqual([
    ['POST', `${stack.native}/signin`, stack.issuer],
    ['POST', `${stack.native}/token`, stack.issuer],
  ]);
  expect(await requests[0]!.json()).toEqual({
    email: 'developer@rezics.test',
    password: 'secret',
    client_id: 'rezics-dev-semantic-walk',
    scope: ['subject:create', 'zone:configure'],
  });
  expect(requests[1]!.headers.get('cookie')).toBe('session=native');
  let calls = 0;
  await expect(
    nativeWalkAccessToken(
      stack,
      {
        email: 'developer@rezics.test',
        password: 'wrong',
        clientId: 'rezics-dev-semantic-walk',
        scopes: [],
      },
      (async () => {
        calls++;
        return new Response('{}', { status: 401 });
      }) as typeof fetch,
    ),
  ).rejects.toThrow('native persona sign-in failed: HTTP 401');
  expect(calls).toBe(1);
});

test('inventory replaces multiline failures and binds both outcomes without changing authored paths', async () => {
  const { updateFirstPublicInventory } = await import('../scripts/semantic-first-public-evidence.ts');
  const source =
    '# Inventory\n\n| Journey | User-visible path | Dev result |\n| --- | --- | --- |\n' +
    '| Released definitions | `/ja/catalogue/definitions` → released Type | Failing timeout\nCall log:\n html[data-hydrated]\n |\n' +
    '| Zone publication and navigation | `/en/zones/id` → about | Pending |\n\nKeep the owner contract.\n';
  const results = [
    { name: 'Released definitions', status: 'Passing' as const, persona: 'anonymous' },
    {
      name: 'Zone publication and navigation',
      status: 'Failing' as const,
      persona: 'editor+anonymous',
      failure: { owner: 'web', actual: 'HTTP 404\nroute | missing <html>' },
    },
  ];
  const actual = updateFirstPublicInventory(source, '123456789012abcdef', '2026-11-07T09:00:00.000Z', results);
  expect(actual).toContain(
    '| Released definitions | `/ja/catalogue/definitions` → released Type | Passing 123456789012 2026-11-07T09:00:00.000Z anonymous |',
  );
  expect(actual).toContain(
    'Failing 123456789012 2026-11-07T09:00:00.000Z editor+anonymous; web: HTTP 404 route / missing &lt;html>',
  );
  expect(actual.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(4);
  expect(actual).not.toContain('Call log:');
  expect(actual).toContain('Keep the owner contract.');
  expect(updateFirstPublicInventory(actual, '123456789012abcdef', '2026-11-07T09:00:00.000Z', results)).toBe(actual);
});
