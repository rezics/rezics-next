import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FIRST_PUBLIC_JOURNEYS } from '../scripts/semantic-first-public-inventory.ts';
import {
  kernelDeadlineTimings,
  nativeWalkCall,
  summarizeBoundaryRequest,
  type NativeObservation,
} from '../scripts/semantic-first-public-request.ts';
import {
  createAndReadNativeBook,
  handleCall,
  readActiveDefinitions,
  resolveEditorAgent,
  searchType,
  walkReadinessUrls,
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

const fixtureSubjectId = 'abea4570-a90c-8fd8-a148-3ada6997936e';
const fixtureAccountId = '50a1a364-ba10-82b1-be1c-8d868d243da6';

test('native Definitions and Book boundaries perform anonymous reads and keep the editor write receipt key', async () => {
  const trace: NativeObservation[] = [];
  const digest = `sha256:${'a'.repeat(64)}`;
  const subject = { id: fixtureSubjectId, revision: 1, type: 'schema:Book', labels: { en: 'Native Book' } };
  const path = `/v1/subjects/${subject.id}`;
  const call = nativeWalkCall(stack.kernel, trace, (async (url, init) => {
    const request = new Request(url, init);
    const pathname = new URL(request.url).pathname;
    if (request.method === 'POST') {
      expect(pathname).toBe('/v1/subjects');
      expect(request.headers.get('authorization')).toBe('Bearer editor-secret');
      expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(trace.at(-1)?.key));
      expect(await request.json()).toEqual({ type: subject.type, labels: subject.labels });
      return Response.json(
        { subject },
        { status: 201, headers: { location: path, 'rezics-session-token': 'write-session' } },
      );
    }
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('rezics-session-token')).toBe(false);
    expect(request.redirect).toBe('manual');
    if (pathname === '/v1/definitions/active') return Response.json({ digest, head: 1 });
    expect(pathname).toBe(path);
    return Response.json({ subject });
  }) as typeof fetch);
  expect(await readActiveDefinitions(call)).toEqual({ digest, head: 1 });
  expect(await createAndReadNativeBook(call, 'editor-secret', 'Native Book')).toMatchObject({
    id: subject.id,
    revision: '1',
    location: path,
  });
  expect(trace.map(({ method, status }) => [method, status])).toEqual([
    ['GET', 200],
    ['POST', 201],
    ['GET', 200],
  ]);
});

test('consent waits for the current seeded editor Agent and rejects a divergent inverse account', async () => {
  const account = { id: fixtureAccountId, kind: 'actor', state: 'active', handle: 'current-editor', automated: false };
  const subject = { id: fixtureSubjectId, type: 'schema:Person', revision: 1 };
  let waitForLink = true;
  let wrongInverse = false;
  const requests: string[] = [];
  const call = handleCall(
    async (request) => {
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);
      expect(request.method).toBe('GET');
      if (url.pathname === `/v1/subjects/${subject.id}`) {
        expect(request.headers.get('authorization')).toBe('Bearer editor');
        return Response.json({ subject, account: { id: account.id } });
      }
      expect(url.pathname).toBe('/v1/accounts');
      expect(request.headers.has('authorization')).toBe(false);
      if (url.searchParams.has('ids')) return Response.json({ accounts: [account] });
      if (url.searchParams.has('handle') && waitForLink) {
        waitForLink = false;
        return Response.json({ accounts: [{ ...account, subject: null }] });
      }
      return Response.json({
        accounts: [
          { ...account, id: url.searchParams.has('agent') && wrongInverse ? subject.id : account.id, subject },
        ],
      });
    },
    (token) => token,
  );
  expect(await resolveEditorAgent(call, 'editor', account.id)).toMatchObject({ accountId: account.id, id: subject.id });
  expect(requests).toEqual([
    `/v1/accounts?ids=${account.id}`,
    '/v1/accounts?handle=current-editor',
    '/v1/accounts?handle=current-editor',
    `/v1/accounts?agent=${subject.id}`,
    `/v1/subjects/${subject.id}`,
  ]);
  wrongInverse = true;
  await expect(resolveEditorAgent(call, 'editor', account.id)).rejects.toThrow('editor inverse Agent link');
  expect(requests.at(-1)).toBe(`/v1/accounts?agent=${subject.id}`);
});

test('deadline evidence joins only the observed native request ID and retains timing fields', async () => {
  const trace: NativeObservation[] = [];
  const problem = { code: 'deadline_exceeded', effect_status: 'not_applied', request_id: fixtureSubjectId };
  const call = nativeWalkCall(stack.kernel, trace, (async () =>
    Response.json(problem, { status: 503 })) as typeof fetch);
  await call('POST', '/v1/subjects', { bearer: 'editor-secret' });
  expect(summarizeBoundaryRequest(trace[0]!)).toMatchObject({
    status: 503,
    requestId: fixtureSubjectId,
    effect: 'not_applied',
    code: 'deadline_exceeded',
  });
  const record = {
    event: 'deadline_exceeded',
    request_id: fixtureSubjectId,
    method: 'POST',
    elapsed_ms: 2001,
    phases_ms: {
      before_command: 2001,
      command_overhead: 0,
      time_mint: 0,
      access_prepare: 0,
      gate_wait: 0,
      transaction_pool_wait: 0,
      transaction_body: 0,
      commit: 0,
      writable_wait: 0,
      contention_pause: 0,
      request_completion: 0,
    },
    contention_retries: 0,
    dominant_phase: 'before_command',
  };
  const temp = resolve(import.meta.dir, '../../../.temp');
  await mkdir(temp, { recursive: true });
  const directory = await mkdtemp(join(temp, 'semantic-deadlines-'));
  try {
    const log = join(directory, 'stack.log');
    expect(await kernelDeadlineTimings(log, trace)).toEqual([]);
    await Bun.write(
      log,
      [
        { ...record, request_id: fixtureAccountId },
        { ...record, method: 'GET' },
        { ...record, extra: 'raw-log-secret', phases_ms: { ...record.phases_ms, sql: 42 } },
        record,
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    expect(await kernelDeadlineTimings(log, trace)).toEqual([record]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the authored catalogue fixture waits for Book Search readiness and returns a gate denial immediately', async () => {
  const headers = new Headers();
  let calls = 0;
  const ready = await searchType(async (method, path, options) => {
    expect([method, path]).toEqual(['POST', '/v1/subjects:search']);
    expect(options?.body).toEqual({ filter: { type: { in: ['schema:Book'] } }, sort: 'id', limit: 8 });
    calls += 1;
    return calls === 1
      ? { status: 503, headers, body: { code: 'index_not_ready' } }
      : { status: 200, headers, body: { subjects: [{ id: 'fixture-book' }] } };
  }, 'schema:Book');
  expect(calls).toBe(2);
  expect(ready.body).toEqual({ subjects: [{ id: 'fixture-book' }] });

  calls = 0;
  const denied = await searchType(async () => {
    calls += 1;
    return { status: 403, headers, body: { code: 'platform_closed' } };
  }, 'schema:Book');
  expect(calls).toBe(1);
  expect(denied.body.code).toBe('platform_closed');
});

test('editor website credentials POST the issuer Origin and keep native JWKS and definition readiness', async () => {
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
