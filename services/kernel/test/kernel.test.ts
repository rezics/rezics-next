import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../src/database/pool.ts';
import { createKernel, type Kernel } from '../src/http/kernel.ts';
import { openApiDocument } from '../src/http/openapi.ts';
import { bootstrapRelease } from '../src/semantic/definitions.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
beforeAll(() => bootstrapRelease(pool, bundledRelease));
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
    ? [Success<Tree[Key]>] extends [never]
      ? never
      : string extends keyof Success<Tree[Key]>
        ? Name<Key, Path>
        : never
    : LooseRoutes<Tree[Key], `${Path}/${Key}`>;
}[keyof Tree & string];
type Routes = TypedRoutes<Kernel['~Routes']>;

// Type-checking proves that each entry is a typed route, that no typed route is missing, and that every success
// response keeps its schema's type. An error names the offending routes.
const typed = [
  'GET /health',
  'POST /v1/webhooks/stripe',
  'GET /v1/offers/:offerId',
  'POST /v1/offers',
  'POST /v1/offers/:offerId/$delist',
  'POST /v1/orders',
  'GET /v1/orders/:orderId',
  'GET /v1/entitlements',
  'GET /v1/entitlements/:entitlementId',
  'POST /v1/progressSessions',
  'GET /v1/progressSessions',
  'GET /v1/progressSessions/:sessionId',
  'POST /v1/progressSessions/:sessionId/$record',
  'POST /v1/progressSessions/:sessionId/$complete',
  'POST /v1/progressSessions/:sessionId/$abandon',
  'GET /v1/progressSessions/:sessionId/completedUnits',
  'GET /v1/progressSessions/:sessionId/changes',
  'POST /v1/publishedLogs',
  'GET /v1/publishedLogs/:logId',
  'GET /v1/publishedLogs',
  'DELETE /v1/publishedLogs/:logId',
  'POST /v1/subjects',
  'POST /v1/subjects/$batchWrite',
  'PUT /v1/realms/:realmId/boardScheme',
  'POST /v1/subjects/$facets',
  'POST /v1/spaces',
  'POST /v1/realms/:realmId/publications/:subjectId/$withdraw',
  'POST /v1/realms/:realmId/publications/:subjectId/$reject',
  'POST /v1/realms/:realmId/publications',
  'POST /v1/realms',
  'POST /v1/presentation/profiles/:digest/$activate',
  'POST /v1/presentation/profiles',
  'POST /v1/pages/$read',
  'POST /v1/accounts/:accountId/$suspend',
  'POST /v1/accounts/:accountId/$reinstate',
  'POST /v1/accounts/:accountId/$setRateTier',
  'POST /v1/accounts/:accountId/$requestVerification',
  'GET /v1/accounts/:accountId/verification',
  'POST /v1/accounts/:accountId/$withdrawVerification',
  'POST /v1/accounts/:accountId/$revokeVerification',
  'POST /v1/accounts/:accountId/$releaseVerification',
  'GET /v1/verification-requests',
  'POST /v1/verification-requests/:requestId/$approve',
  'POST /v1/verification-requests/:requestId/$reject',
  'GET /v1/agent-pages',
  'GET /v1/accounts',
  'GET /v1/accounts/:accountId/speakers',
  'GET /v1/accounts/:accountId/preferences',
  'PATCH /v1/accounts/:accountId/preferences',
  'GET /v1/me/realms',
  'GET /v1/platform/exposure',
  'POST /v1/platform/exposure/:group/$close',
  'POST /v1/platform/exposure/:group/$open',
  'PATCH /v1/spaces/:spaceId',
  'PATCH /v1/realms/:realmId',
  'GET /v1/spaces/:spaceId',
  'GET /v1/realms/:realmId/publications/:subjectId',
  'GET /v1/realms/:realmId/publications',
  'GET /v1/realms/:realmId',
  'GET /v1/realms/:realmId/participation',
  'POST /v1/realms/:realmId/membership',
  'DELETE /v1/realms/:realmId/membership',
  'POST /v1/realms/:realmId/members',
  'GET /v1/realms/:realmId/members/me',
  'PUT /v1/realms/:realmId/bans/:accountId',
  'DELETE /v1/realms/:realmId/bans/:accountId',
  'GET /v1/realms/:realmId/bans',
  'GET /v1/presentation/profiles/:digest',
  'GET /v1/presentation/active',
  'DELETE /v1/posts/:id',
  'POST /v1/subjects/$merge',
  'GET /v1/subjects/:id',
  'GET /v1/subject-pages',
  'POST /v1/subjects/:id/$hide',
  'POST /v1/subjects/:id/$takedown',
  'POST /v1/subjects/:id/$restore',
  'POST /v1/contexts',
  'GET /v1/contexts/:id',
  'POST /v1/subjects/$search',
  'GET /v1/subjects/$suggest',
  'GET /v1/payoutStatements',
  'GET /v1/payoutStatements/:statementId',
  'GET /v1/payoutStatements/:statementId/lines',
  'POST /v1/payoutStatements/:statementId/$markPaid',
  'POST /v1/subjects/:id/candidates',
  'POST /v1/subjects/:id/candidates/:candidate/$accept',
  'POST /v1/subjects/:id/candidates/:candidate/$reject',
  'POST /v1/subjects/:id/candidates/:candidate/$hide',
  'POST /v1/subjects/:id/candidates/:candidate/$takedown',
  'POST /v1/subjects/:id/candidates/:candidate/$restore',
  'POST /v1/subjects/:id/$adopt',
  'GET /v1/subjects/:id/candidates',
  'GET /v1/subjects/:id/revisions',
  'GET /v1/subjects/:id/links',
  'GET /v1/subjects/:id/relations',
  'GET /v1/subjects/graph',
  'GET /v1/subjects/:id/graph',
  'POST /v1/definitions/releases',
  'GET /v1/definitions/releases/:digest',
  'GET /v1/definitions/active',
  'POST /v1/definitions/releases/:digest/$activate',
  'POST /v1/contexts/:id/definitions/extensions',
  'POST /v1/contexts/:id/definitions/extensions/:digest/$activate',
  'GET /v1/contexts/:id/definitions',
  'GET /v1/sourceFences/$check',
  'POST /v1/sourceFences/$takedown',
  'POST /v1/media/:id/$takeDown',
  'POST /v1/media/$importFromUrl',
  'GET /v1/media/:id/$importStatus',
  'GET /v1/documents/:id',
  'DELETE /v1/documents/:id',
  'POST /v1/reports',
  'GET /v1/reports/:id',
  'POST /v1/threads',
  'GET /v1/threads/:id',
  'POST /v1/threads/:id/posts',
  'GET /v1/threads/:id/posts',
  'GET /v1/posts/:id',
  'POST /v1/posts/:id/revisions',
  'GET /v1/posts/:id/revisions',
  'GET /v1/posts/:id/revisions/:revisionId',
  'GET /v1/boards/:id/threads',
  'GET /v1/sitemap/boards',
  'GET /v1/sitemap/threads',
  'GET /v1/sitemap/realms',
  'GET /v1/sitemap/spaces',
  'GET /v1/sitemap/collections',
  'GET /v1/boards/:id',
  'GET /v1/boards/:id/reports',
  'GET /v1/moderation-decisions/:id',
  'GET /v1/threads/:id/reports',
  'GET /v1/posts/:id/reports',
  'POST /v1/boards/:id/$takeDown',
  'POST /v1/threads/:id/$takeDown',
  'POST /v1/posts/:id/$takeDown',
  'POST /v1/posts/:id/$erase',
  'POST /v1/threads/:id/$erase',
  'GET /v1/openapi.json',
  'GET /v1/operations/:id',
  'POST /v1/media',
  'GET /v1/media/:id',
  'POST /v1/media/:id/$complete',
  'DELETE /v1/media/:id',
  'GET /v1/media/:id/$authorizeDownload',
  'POST /v1/grants',
  'POST /v1/grants/$change',
  'POST /v1/grants/$revoke',
  'POST /v1/roleGrants',
  'POST /v1/roleGrants/$change',
  'POST /v1/roleGrants/$revoke',
  'POST /v1/realms/:realmId/boards',
  'GET /v1/realms/:realmId/boards',
  'PUT /v1/threads/:id/reaction',
  'DELETE /v1/threads/:id/reaction',
  'PUT /v1/posts/:id/reaction',
  'DELETE /v1/posts/:id/reaction',
  'PUT /v1/spaces/:spaceId/address',
  'GET /v1/spaceAddresses/:address',
  'GET /v1/libraryEntries',
  'GET /v1/libraryShelfSummary',
  'GET /v1/libraryShelfTypes',
  'GET /v1/libraryEntries/:subjectId',
  'PUT /v1/libraryEntries/:subjectId',
  'DELETE /v1/libraryEntries/:subjectId',
  'POST /v1/copies',
  'GET /v1/copies',
  'GET /v1/copies/:copyId',
  'PATCH /v1/copies/:copyId',
  'DELETE /v1/copies/:copyId',
  'PUT /v1/follows/:targetId',
  'DELETE /v1/follows/:targetId',
  'GET /v1/follows/:targetId',
  'GET /v1/follows',
  'POST /v1/collections',
  'GET /v1/collections',
  'GET /v1/accounts/:accountId/collections',
  'GET /v1/collections/:collectionId',
  'PATCH /v1/collections/:collectionId',
  'DELETE /v1/collections/:collectionId',
  'GET /v1/collections/:collectionId/members',
  'POST /v1/collections/:collectionId/members',
  'PATCH /v1/collections/:collectionId/members/:memberId',
  'DELETE /v1/collections/:collectionId/members/:memberId',
  'POST /v1/collections/:collectionId/members/:memberId/$move',
  'GET /v1/subjects/:id/collections',
  'POST /v1/statements/:id/disclose',
  'POST /v1/statements/:id/retract',
  'GET /v1/subjects/:id/reactions',
  'GET /v1/subjects/:id/reaction',
  'PUT /v1/subjects/:id/reaction',
  'DELETE /v1/subjects/:id/reaction',
  'GET /v1/rating-questions/:questionId',
  'GET /v1/subjects/:id/ratings',
  'GET /v1/subjects/:id/ratings/populations',
  'PUT /v1/subjects/:id/ratings/:questionId/vote',
  'DELETE /v1/subjects/:id/ratings/:questionId/vote',
  'GET /v1/subjects/:id/ratings/:questionId/vote',
  'GET /v1/subjects/:id/threads',
  'GET /v1/accounts/:accountId/threads',
  'GET /v1/accounts/:accountId/posts',
  'GET /v1/accounts/:accountId/realms',
  'GET /v1/subjects/:id/source-statistics',
  'PUT /v1/subjects/:id/source-statistics/:source',
  'POST /v1/zones',
  'GET /v1/zones',
  'GET /v1/zones/:id',
  'GET /v1/zones/:id/configuration',
  'PUT /v1/zones/:id/configuration',
  'POST /v1/zones/:id/$publish',
  'DELETE /v1/zones/:id',
  'POST /v1/zones/:id/$restore',
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

test('semantic editorial listings document their default page size', () => {
  const paths = openApiDocument(createKernel({ pool, routeKey: new Uint8Array(32) })).paths;
  for (const path of ['/v1/subjects/{id}/candidates', '/v1/subjects/{id}/revisions', '/v1/subjects/{id}/links']) {
    expect(paths[path]!.get!.parameters).toContainEqual(
      expect.objectContaining({ name: 'limit', in: 'query', schema: expect.objectContaining({ default: 20 }) }),
    );
  }
  expect(paths['/v1/subjects/{id}/relations']!.get!.parameters).toContainEqual(
    expect.objectContaining({ name: 'limit', in: 'query', schema: expect.objectContaining({ default: 25 }) }),
  );
});

test('subject HTTP refuses an unlicensed document and any media value before attempting storage', async () => {
  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
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
  for (const [property, content, expectedError] of [
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
      { pointer: '/statements/schema:abstract/0/value/content/licence', code: 'required' },
    ],
    [
      'schema:image',
      '019a1b2c-3d4e-7f00-8a00-3ed1a0000062',
      { pointer: '/statements/schema:image/0/value/content', code: 'unsupported' },
    ],
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
          type: 'schema:Book',
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
      errors: [expectedError],
    });
  }
});
