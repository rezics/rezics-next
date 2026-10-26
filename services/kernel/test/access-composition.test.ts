import { afterAll, expect, test } from 'bun:test';
import { createAccess } from '../src/access/index.ts';
import { createPool } from '../src/database/pool.ts';
import { createApp } from '../src/http/app.ts';
import { actionCatalogue } from '../src/http/request.ts';
import type { Access, AccessConfig, AccessFactory, Resource } from '../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

const thing: Resource = { route: 0x1234, id: '019a1b2c-3d4e-7f00-8a00-123400000001' };
const read = {
  operationId: 'thing.get',
  'x-action': 'thing:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};
const create = {
  operationId: 'thing.create',
  'x-action': 'thing:create',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }],
};
const list = {
  operationId: 'thing.list',
  'x-action': 'thing:list',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};

/** Routes that answer whether access allowed the request; `listed` adds a third action. */
function thingApp(access: Access | AccessFactory, listed = false) {
  const allowed = async ({
    authorize,
  }: {
    authorize: (resource: Resource) => Promise<(client: typeof pool) => Promise<boolean>>;
  }) => ({
    allowed: await (await authorize(thing))(pool),
  });
  const app = createApp({ pool, access })
    .get('/v1/things/:id', { detail: read }, allowed)
    .post('/v1/things', { detail: create }, allowed);
  return listed ? app.get('/v1/things', { detail: list }, allowed) : app;
}
const get = (app: { handle(request: Request): Promise<Response> }, path: string) =>
  app.handle(new Request(`http://kernel.test${path}`)).then((response) => response.json());

test('an app builds its access once, on first use, from the action catalogue of its own routes', async () => {
  const configs: AccessConfig[] = [];
  const reads: Access = {
    async authenticate() {
      throw new Error('no request carries a token');
    },
    async authorize(_client, _actor, action) {
      return action === 'thing:read';
    },
  };
  const factory: AccessFactory = (config) => {
    configs.push(config);
    return reads;
  };
  const app = thingApp(factory);
  const other = thingApp(factory, true);
  expect(configs).toEqual([]);

  expect([await get(app, '/v1/things/a'), await get(app, '/v1/things/b')]).toEqual([
    { allowed: true },
    { allowed: true },
  ]);
  expect(configs).toHaveLength(1);
  expect(configs[0]!.actions).toEqual(actionCatalogue(app));
  expect(configs[0]!.actions).toEqual(
    new Map([
      ['thing:read', { anonymous: true }],
      ['thing:create', { anonymous: false }],
    ]),
  );

  expect(await get(other, '/v1/things')).toEqual({ allowed: false });
  expect(configs).toHaveLength(2);
  expect(configs[1]!.actions).toEqual(actionCatalogue(other));
  expect(configs[1]!.actions.get('thing:list')).toEqual({ anonymous: true });
});

test('the installed access module composes through createAccess and denies actions outside its catalogue', async () => {
  const installed = createAccess({ actions: new Map([['thing:read', { anonymous: true }]]) });
  expect(await installed.authorize(pool, { kind: 'anonymous' }, 'thing:list', thing)).toBe(false);
  expect(await installed.authorize(pool, { kind: 'anonymous' }, 'subject:read', thing)).toBe(false);
});
