import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../src/database/pool.ts';
import { createKernel, type Kernel } from '../src/http/kernel.ts';

const pool = createPool('postgres://kernel.invalid/routes');
afterAll(() => pool.end());

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Name<Key extends string, Path extends string> = `${Uppercase<Key>} ${Path extends '' ? '/' : Path}`;
/** Every `METHOD /path` in the route tree Eden builds its client from. */
type TypedRoutes<Tree, Path extends string = ''> = {
  [Key in keyof Tree & string]: Key extends Method ? Name<Key, Path> : TypedRoutes<Tree[Key], `${Path}/${Key}`>;
}[keyof Tree & string];
type Success<Route> = Route extends { response: infer Responses }
  ? Responses[Extract<keyof Responses, 200 | 201 | 202 | 204>]
  : never;
/** Routes whose success response type is an open record: its schema was lost on the way into the route. */
type LooseRoutes<Tree, Path extends string = ''> = {
  [Key in keyof Tree & string]: Key extends Method
    ? string extends keyof Success<Tree[Key]>
      ? Name<Key, Path>
      : never
    : LooseRoutes<Tree[Key], `${Path}/${Key}`>;
}[keyof Tree & string];
type Routes = TypedRoutes<Kernel['~Routes']>;

// Type-checking proves that each entry is a typed route, that no typed route is missing, and that every success
// response keeps its schema's type. An error names the offending routes.
const typed = [
  'GET /health',
  'POST /v1/subjects',
  'GET /v1/subjects/:id',
  'POST /v1/contexts',
  'GET /v1/contexts/:id',
  'GET /v1/offers/:offerId',
  'POST /v1/offers',
  'POST /v1/offers/:offerId/$delist',
  'POST /v1/orders',
  'GET /v1/orders/:orderId',
  'GET /v1/entitlements',
  'GET /v1/entitlements/:entitlementId',
  'POST /v1/webhooks/stripe',
  'POST /v1/definitions/releases',
  'GET /v1/definitions/releases/:digest',
  'GET /v1/definitions/active',
  'POST /v1/definitions/releases/:digest/$activate',
] as const satisfies readonly Routes[];
type Missing = Exclude<Routes, (typeof typed)[number]>;
const complete: [Missing] extends [never] ? true : Missing = true;
type Loose = LooseRoutes<Kernel['~Routes']>;
const precise: [Loose] extends [never] ? true : Loose = true;

test("the kernel app's type, which is the Eden contract, carries exactly the routes it serves and their responses", () => {
  const served = createKernel({ pool, routeKey: new Uint8Array(32) }).routes.map(
    ({ method, path }) => `${method} ${path}`,
  );
  expect([complete, precise]).toEqual([true, true]);
  expect(served.sort()).toEqual([...typed].sort());
});

test('subject HTTP rejects document and media values before attempting storage', async () => {
  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    access: {
      async authenticate() {
        return {
          kind: 'account',
          accountId: '019a1b2c-3d4e-7f00-8a00-5b0000000061',
          clientId: 'web',
          scopes: ['subject:create'],
          requestedBy: null,
          authnEpoch: 1,
        };
      },
      async authorize() {
        throw new Error('Invalid contents must be refused before a command runs');
      },
    },
  });
  for (const [property, content] of [
    [
      'schema:abstract',
      {
        language: 'en',
        document: {
          version: 'rezics-document-v1',
          profile: 'text',
          doc: { type: 'doc', content: [{ type: 'paragraph' }] },
        },
      },
    ],
    ['schema:image', '019a1b2c-3d4e-7f00-8a00-3ed1a0000062'],
  ] as const) {
    const response = await kernel.handle(
      new Request('http://kernel.test/v1/subjects', {
        method: 'POST',
        headers: {
          authorization: 'Bearer writer',
          'idempotency-key': '"content-refused"',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          labels: { en: 'Example' },
          statements: {
            [property]: [{ property: { id: property }, value: { type: 'value', content } }],
          },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'invalid_request',
      errors: [{ pointer: `/statements/${property}/0/value/content`, code: 'unsupported' }],
    });
  }
});
