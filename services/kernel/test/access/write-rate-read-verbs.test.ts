import { afterAll, expect, spyOn, test } from 'bun:test';
import { t } from 'elysia';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { customMethod } from '../../src/http/custom-method.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import { MountedRouteCatalogue, mountedRouteCatalogue, type MountedRoute } from '../../src/http/request.ts';
import { createWriteRateStage } from '../../src/access/write-rate-stage.ts';
import type { WriteRateFamily, WriteRateLimiter } from '../../src/access/write-rate.ts';

const pool = new Pool();
afterAll(() => pool.end());
const actor = {
  kind: 'account' as const,
  accountId: 'fixture-account',
  clientId: 'fixture',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const detail = (action: unknown, family?: WriteRateFamily) => ({
  operationId: 'probe.inspect',
  'x-action': action,
  security: [{ bearerAuth: [] }],
  ...(family ? { 'x-rate-limit': defineRateLimit({ family, units: 1 }) } : {}),
});
const send = (path: string, method = 'GET', body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: 'Bearer fixture',
      'content-type': 'application/json',
      'x-action': 'probe:read',
      'x-rate-limit': 'read',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
function fixture() {
  const actions: unknown[] = [];
  const writeRate: WriteRateLimiter = {
    async spend() {
      return { allowed: true };
    },
  };
  const spend = spyOn(writeRate, 'spend');
  const app = createApp({
    pool,
    writeRate,
    access: {
      async authenticate() {
        return actor;
      },
      async authorize(_client, actor, action, resource) {
        actions.push([actor, action, resource]);
        return resource.id === 'allowed';
      },
    },
  });
  return { app, actions, spend };
}

for (const action of ['media:read_reservation', 'moderation:read_reports']) {
  test(`trusted mounted ${action} GET reaches normal authorization without spending write capacity`, async () => {
    const { app, actions, spend } = fixture();
    let effects = 0;
    app.get('/protected/:id', { detail: detail(action) }, async ({ authorize, params }) => {
      if (!(await (await authorize({ route: 0, id: params.id }))(pool))) throw new ProblemError('forbidden');
      return ++effects;
    });
    const lookup = spyOn(MountedRouteCatalogue.prototype, 'find');
    try {
      expect((await app.handle(send('/protected/allowed'))).status).toBe(200);
      const denied = await app.handle(send('/protected/denied'));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'forbidden' });
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      lookup.mockRestore();
    }
    expect(actions).toEqual([
      [actor, action, { route: 0, id: 'allowed' }],
      [actor, action, { route: 0, id: 'denied' }],
    ]);
    expect(effects).toBe(1);
    expect(spend).not.toHaveBeenCalled();
  });
}

test('validated read and list families include bounded suffixes and exact custom POST methods', async () => {
  const { app, spend } = fixture();
  const actions = ['probe:read', 'probe:list', 'probe:read_one_more', 'probe:list_reports'];
  for (const [index, action] of actions.entries()) {
    app.post(customMethod(`/probes/${index}/:id`, 'inspect'), { detail: detail(action) }, () => action);
  }
  for (const [index, action] of actions.entries()) {
    const response = await app.handle(send(`/probes/${index}/one:inspect`, 'POST', {}));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(action);
  }
  expect(spend).not.toHaveBeenCalled();
});

test('missing, malformed and unknown mutation metadata fail closed despite spoofed request metadata', async () => {
  const { app, spend } = fixture();
  let effects = 0;
  const invalid = [
    'probe:mutate',
    'probe:readwrite',
    'probe:reader',
    'probe:readdress',
    'probe:lister',
    'probe:read_',
    'probe:list_',
    'probe:read_123',
    'probe:list_reports!',
    'Probe:read_reports',
    'probe:read:read_reports',
    'probe:read_reports\n',
    '',
    null,
    1,
  ];
  for (const [index, action] of invalid.entries()) {
    app.all(`/invalid/${index}/:id`, { detail: detail(action) }, () => ++effects);
  }
  app.post('/missing/:id', {}, () => ++effects);
  for (const index of invalid.keys()) {
    for (const method of ['GET', 'POST']) {
      const response = await app.handle(
        send(
          `/invalid/${index}/read_reports?x-action=probe:read`,
          method,
          method === 'POST' ? { 'x-action': 'probe:list_reports', 'x-rate-limit': { family: 'read' } } : undefined,
        ),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ code: 'rate_limit_unavailable', retryable: true });
    }
  }
  expect((await app.handle(send('/missing/read', 'POST', { 'x-action': 'probe:read' }))).status).toBe(503);
  expect(effects).toBe(0);
  expect(spend).not.toHaveBeenCalled();
});

test('ordinary GET, HEAD and OPTIONS without action metadata retain their health behavior', async () => {
  const { app, spend } = fixture();
  app.all('/health-probe', {}, () => 'ok');
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    expect((await app.handle(send('/health-probe', method))).status).toBe(200);
  }
  expect(spend).not.toHaveBeenCalled();
});

test('declared writes and read-named rate expenditure each spend once after body validation', async () => {
  const { app, spend } = fixture();
  let effects = 0;
  app
    .get('/mutation', { detail: detail('probe:mutate', 'write') }, () => ++effects)
    .get('/provider', { detail: detail('media:read_reservation', 'provider') }, () => ++effects)
    .post(
      customMethod('/probes/:id', 'search'),
      {
        body: t.Object({ text: t.String() }),
        detail: detail('probe:read', 'search'),
      },
      () => ++effects,
    );
  expect((await app.handle(send('/probes/one:search', 'POST', { text: 1 }))).status).toBe(400);
  expect(effects).toBe(0);
  expect(spend).not.toHaveBeenCalled();
  expect((await app.handle(send('/mutation'))).status).toBe(200);
  expect((await app.handle(send('/provider'))).status).toBe(200);
  expect((await app.handle(send('/probes/one:search', 'POST', { text: 'book' }))).status).toBe(200);
  expect(spend.mock.calls.map(([, family, units]) => [family, units])).toEqual([
    ['write', 1],
    ['provider', 1],
    ['search', 1],
  ]);
  expect(effects).toBe(3);
});

test('read classification retains constant indexed catalogue lookups and zero counter calls as mounts grow', async () => {
  for (const scale of [1, 8, 64]) {
    const routes: MountedRoute[] = Array.from({ length: scale * 500 }, (_, index) => ({
      method: 'POST',
      path: `/unrelated/${index}`,
      hooks: { detail: detail('probe:mutate') },
    }));
    routes.push(
      { method: 'GET', path: '/matched/:id', hooks: { detail: detail('media:read_reservation') } },
      {
        method: 'POST',
        path: '/matched/:id',
        hooks: {
          detail: {
            ...detail('probe:mutate'),
            'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          },
        },
      },
    );
    const catalogue = mountedRouteCatalogue(routes);
    const lookup = spyOn(catalogue, 'find');
    const counter = spyOn(pool, 'query');
    const limiter: WriteRateLimiter = {
      async spend() {
        return { allowed: true };
      },
    };
    const spend = spyOn(limiter, 'spend');
    const stage = createWriteRateStage(limiter);
    const context = { pool, actor: { kind: 'anonymous' as const }, deadline: Date.now() + 5000 };
    try {
      for (const method of ['GET', 'POST']) {
        const request = send('/matched/one', method);
        await stage({ request, routes, route: '/matched/:id', body: {}, context });
        expect(lookup).toHaveBeenCalledTimes(method === 'GET' ? 1 : 2);
        expect(spend).toHaveBeenCalledTimes(method === 'GET' ? 0 : 1);
        expect(counter).not.toHaveBeenCalled();
      }
      expect(spend.mock.calls.map(([, family, units]) => [family, units])).toEqual([['write', 1]]);
    } finally {
      lookup.mockRestore();
      counter.mockRestore();
    }
  }
});
