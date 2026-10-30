import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  checkMediaImportRequest,
  checkMediaImportStatus,
  type MediaImportRequest,
} from '@rezics/definitions/media-import';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { contentRoutes } from '../../src/content/routes.ts';
import { createApp } from '../../src/http/app.ts';
import { customMethod } from '../../src/http/custom-method.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { isProblemSchema, openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import type { definitionRoutes } from '../../src/semantic/http/definitions.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

import { tupleRoute } from '../../src/content/imported-contract.ts';
import {
  assertGrowthPointPlans,
  seedMediaCommandHistory,
  type GrowthGlobalGrantIndexDefinition,
} from './support/media-fixtures.ts';

const platformId = '00000000-0000-8000-8000-000000000000';
const route = 42000;
const accountId = newId(42016);
const otherId = newId(42032);
const containerId = newId(route);
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const actions = [
  'media:import_from_url',
  'source_fence:read',
  'media:read_reservation',
  'media:read',
  'media:complete',
  'media:erase',
];
const input: MediaImportRequest = {
  containerId,
  sourceUrl: 'https://images.example.test/cover.jpg',
  credit: {
    rightsHolder: 'Cover Artist',
    via: { name: 'Catalogue', url: 'https://catalogue.example.test/42' },
    license: 'LicenseRef-unknown',
    obligations: [],
  },
  provenance: {
    source: 'catalogue',
    external_id: '42',
    record_revision: '3',
    digest: 'b'.repeat(64),
    converter_revision: '2',
    field_group: 'cover',
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example.test/42' } },
        ],
      },
    ],
  },
};
let db: GrowthDatabase;
let globalGrantIndex: GrowthGlobalGrantIndexDefinition;
let app: ReturnType<typeof contentRoutes>;
let root: ReturnType<typeof createKernel>;
let bearer: string;
let otherBearer: string;
let limited: string;
let charges: { family: string; units: number }[] = [];

beforeAll(async () => {
  db = await openGrowthDatabase();
  const nativeIndex = await db.admin.query<GrowthGlobalGrantIndexDefinition>(
    `SELECT n.nspname AS schema,t.relname AS relation,c.relname AS "index",
            pg_get_expr(i.indpred,i.indrelid) AS predicate
       FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
       JOIN pg_namespace n ON n.oid=t.relnamespace
       JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indexrelid='access.resource_grant_pkey_lookup'::regclass`,
  );
  expect(nativeIndex.rows).toEqual([
    {
      schema: 'access',
      relation: 'resource_grant',
      index: 'resource_grant_pkey_lookup',
      predicate: "((route = 0) AND (resource_id = '00000000-0000-8000-8000-000000000000'::uuid))",
    },
  ]);
  globalGrantIndex = nativeIndex.rows[0]!;
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'media-import-http' };
  const issuer = 'https://auth.example.test';
  const audience = 'https://api.example.test';
  const access = createAccess({
    actions: new Map(
      actions.map((action) => [
        action,
        {
          anonymous: false,
          ...(action === 'media:import_from_url' ? { 'x-resource-types': ['content.media'] } : {}),
        },
      ]),
    ),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  for (const id of [accountId, otherId])
    await db.admin.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)`,
      [routeOf(id), id],
    );
  await db.admin.query(
    `INSERT INTO semantic.subject (route,subject_id,type,recorded_transaction_id) VALUES ($1,$2,'schema:Book',$2)`,
    [route, containerId],
  );
  for (const action of ['media:import_from_url', 'source_fence:read'])
    await db.admin.query(
      `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,$3,'(,)'::tstzrange,$2)`,
      [platformId, accountId, action],
    );
  const issue = async (id: string, scopes = actions) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      client_id: 'bulk-importer',
      scope: scopes.join(' '),
      authn_epoch: 1,
      auth_time: now,
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(id)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
  };
  bearer = await issue(accountId);
  otherBearer = await issue(otherId);
  limited = await issue(accountId, ['media:read_reservation']);
  const limiter = createWriteRateLimiter({
    secret: 'media-import-http-secret-at-least-32-bytes',
    overrides: '{"new-account":{"upload":{"maximum":1000,"seconds":60}}}',
  });
  const dependencies = {
    pool: db.pool,
    access,
    routeKey,
    tokens,
    clock: () => new Date(),
    fetchConfig: { allowedHosts: ['images.example.test'] },
    ratePeer: () => '127.0.0.1',
    writeRate: {
      async spend(...args: Parameters<typeof limiter.spend>) {
        charges.push({ family: args[1], units: args[2] ?? 1 });
        return limiter.spend(...args);
      },
    },
  };
  app = contentRoutes(createApp(dependencies) as unknown as ReturnType<typeof definitionRoutes>, dependencies);
  root = createKernel({ ...dependencies, content: { fetchConfig: dependencies.fetchConfig } });
  expect(checkMediaImportRequest(input)).toEqual([]);
});
afterAll(async () => {
  await db?.close();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  key = Bun.randomUUIDv7(),
  token: string | null = bearer,
  target = app,
) {
  const response = await target.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: await response.json() };
}
const post = (body: unknown = input, key?: string, token?: string | null) =>
  call('POST', '/v1/media:importFromUrl', body, key, token);
const poll = (id: string, token?: string | null) =>
  call('GET', `/v1/media/${id}:importStatus`, undefined, undefined, token);

function safe(body: unknown) {
  const text = JSON.stringify(body);
  for (const secret of [input.sourceUrl, bearer, 'original', 'source_url', 'uploader_id', 'transaction_id'])
    expect(text).not.toContain(secret);
}
async function accepted(key = Bun.randomUUIDv7()) {
  const result = await post(input, key);
  expect(result.response.status).toBe(202);
  expect(result.body).toEqual({ media: { id: expect.any(String), containerId, purpose: 'cover', state: 'reserved' } });
  safe(result.body);
  return result;
}

test('literal custom methods mount once with closed portable OpenAPI and generated client spelling', async () => {
  for (const target of [app, root]) {
    const document = openApiDocument(target);
    for (const [method, internal, publicPath, action, operation, status] of [
      [
        'POST',
        customMethod('/v1/media', 'importFromUrl'),
        '/v1/media:importFromUrl',
        'media:import_from_url',
        'media.import_from_url',
        202,
      ],
      [
        'GET',
        customMethod('/v1/media/:id', 'importStatus'),
        '/v1/media/{id}:importStatus',
        'media:read_reservation',
        'media.import_status',
        200,
      ],
    ] as const) {
      expect(target.routes.filter((r) => r.method === method && r.path === internal)).toHaveLength(1);
      const op = document.paths[publicPath]?.[method.toLowerCase()];
      expect(op?.operationId).toBe(operation);
      expect(op?.['x-action']).toBe(action);
      expect(op?.security).toEqual([{ bearerAuth: [] }]);
      expect(op?.responses?.[status]).toBeDefined();
      expect(op?.['x-rate-limit']).toEqual(method === 'POST' ? { family: 'upload', units: 1 } : undefined);
      for (const code of [400, 401, 404, 500, 503])
        expect(
          isProblemSchema(
            op?.responses?.[code]?.content?.['application/problem+json']?.schema,
            document.components.schemas,
          ),
        ).toBe(true);
      expect(actionCatalogue(target).get(action)?.anonymous).toBe(false);
    }
    expect(Object.keys(document.paths).some((path) => path.includes('/$'))).toBe(false);
  }
  const contract = await Bun.file('../../contracts/openapi.json').text();
  expect(contract).toContain('"/v1/media:importFromUrl"');
  expect((await call('POST', '/v1/media/$importFromUrl', input)).response.status).toBe(404);
});

test('malformed provenance rights and unknown fields reject before charging or reserving', async () => {
  for (const body of [
    { ...input, allowlist: ['attacker.test'] },
    { ...input, sourceUrl: 'x'.repeat(2049) },
    { ...input, provenance: { ...input.provenance, references: [] } },
    { ...input, provenance: { ...input.provenance, token: 'secret' } },
    { ...input, credit: { ...input.credit, license: 'invented-license' } },
    { ...input, credit: { ...input.credit, license: 'CC-BY-4.0', obligations: ['cc:Notice', 'cc:Notice'] } },
  ]) {
    const before = charges.length;
    const result = await post(body);
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get('content-type')).toContain('application/problem+json');
    expect(result.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    expect(charges).toHaveLength(before);
    expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
  }
});

test('authored crop and focal point requests return problem responses when malformed', async () => {
  const valid = await post({ ...input, crop: 'xywh=10,20,300,400', focalPoint: { x: 0.3, y: 1 } });
  expect(valid.response.status).toBe(202);
  for (const body of [
    { ...input, crop: 'xywh=percent:10,20,30,40' },
    { ...input, crop: 'xywh=0,0,0,40' },
    { ...input, focalPoint: { x: -0.1, y: 0.5 } },
    { ...input, focalPoint: { x: 0.5, y: 1.1 } },
  ]) {
    const before = charges.length;
    const result = await post(body);
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get('content-type')).toContain('application/problem+json');
    expect(result.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    expect(charges).toHaveLength(before);
    expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
  }
});

test('real ordinary bearer keeps grant and scope intersection and concealed unknown reads', async () => {
  expect((await post(input, undefined, null)).response.status).toBe(401);
  expect((await post(input, undefined, limited)).response.status).toBe(403);
  expect((await post(input, undefined, otherBearer)).response.status).toBe(403);
  const before = charges.length;
  const unknown = await poll(newId(route));
  expect(unknown.response.status).toBe(404);
  expect(unknown.body).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
  expect(charges).toHaveLength(before);
  expect((await poll(newId(route), null)).response.status).toBe(401);
});

test('focused native outcomes preserve current authorization and partition bounds', async () => {
  const key = Bun.randomUUIDv7();
  const before = charges.length;
  const result = await accepted(key);
  expect(charges.slice(before)).toEqual([{ family: 'upload', units: 1 }]);
  const id = result.body.media.id;
  expect(routeOf(id)).toBe(route);
  const row = (await db.admin.query('SELECT media_id FROM content.media WHERE route=$1 AND media_id=$2', [route, id]))
    .rows;
  expect(row).toEqual([{ media_id: id }]);
  const session = decodeSession(tokens, `account:${accountId}`, result.response.headers.get(SESSION_HEADER)!);
  expect(session).toHaveLength(1);
  expect(session?.[0]?.partition).toBe(partitionOf(route));
  const status = await poll(id);
  expect(status.response.status).toBe(200);
  expect(status.body).toEqual({
    media: {
      ...result.body.media,
      byteCount: null,
      mediaType: null,
      sha256: null,
      credit: input.credit,
      provenance: input.provenance,
    },
  });
  expect(checkMediaImportStatus(status.body)).toEqual([]);
  expect(charges.slice(before)).toEqual([{ family: 'upload', units: 1 }]);
  expect(status.response.headers.get(SESSION_HEADER)).toBeNull();
  safe(status.body);
  expect((await poll(id, otherBearer)).response.status).toBe(404);
  const replay = await accepted(key);
  expect(replay.body).toEqual(result.body);
  expect(
    (
      await call(
        'POST',
        '/v1/media:importFromUrl',
        { ...input, sourceUrl: 'https://images.example.test/changed.jpg' },
        key,
      )
    ).response.status,
  ).toBe(422);
  await db.admin.query(
    'DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
    [platformId, accountId, 'media:import_from_url'],
  );
  try {
    expect((await post(input, key)).response.status).toBe(403);
  } finally {
    await db.admin.query(
      `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'media:import_from_url','(,)'::tstzrange,$2)`,
      [platformId, accountId],
    );
  }
  await db.admin.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [route, id]);
  expect((await poll(id)).response.status).toBe(404);
  const revoked = await post(input, key);
  expect(revoked.response.status).toBe(404);
  expect(revoked.response.headers.get(SESSION_HEADER)).toBeNull();
});

test('production root forwards trusted import configuration to the actual native API', async () => {
  const result = await call('POST', '/v1/media:importFromUrl', input, undefined, undefined, root as typeof app);
  expect(result.response.status).toBe(202);
  expect(result.body.media.containerId).toBe(containerId);
});

test('point probe proof accepts only the verified Global predicate and retains every variable index key', () => {
  const variableKeys = ['subject_kind', 'subject_id', 'subject_role', 'action', 'valid'];
  const keys = { 'access.resource_grant': ['route', 'resource_id', ...variableKeys] };
  const condition =
    "ROW(g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid) >= ROW(k.subject_kind, k.subject_id, k.subject_role, 'source_fence:read', 'empty'::tstzrange)";
  const node = {
    Schema: 'access',
    'Relation Name': 'resource_grant',
    'Node Type': 'Index Only Scan',
    'Index Name': 'resource_grant_pkey_lookup',
    'Actual Loops': 2,
    'Actual Rows': 0.5,
    'Shared Hit Blocks': 5,
    'Index Cond': condition,
  };
  const captured = { statements: [], plans: [node] };
  expect(() => assertGrowthPointPlans(captured, keys, globalGrantIndex)).not.toThrow();
  expect(() => assertGrowthPointPlans(captured, keys)).toThrow('Expected exact');
  for (const invalid of [
    { ...globalGrantIndex, predicate: null },
    { ...globalGrantIndex, predicate: '(route = 0)' },
    { ...globalGrantIndex, predicate: `(resource_id = '${platformId}'::uuid)` },
    { ...globalGrantIndex, predicate: `((route = 1) AND (resource_id = '${platformId}'::uuid))` },
    {
      ...globalGrantIndex,
      predicate: "((route = 0) AND (resource_id = '00000000-0000-8000-8000-000000000001'::uuid))",
    },
    { ...globalGrantIndex, schema: 'content' },
    { ...globalGrantIndex, relation: 'resource_role_grant' },
    { ...globalGrantIndex, index: 'another_index' },
  ])
    expect(() => assertGrowthPointPlans(captured, keys, invalid)).toThrow('Expected exact');
  for (const column of variableKeys) {
    const missing = { ...node, 'Index Cond': condition.replaceAll(column, 'omitted'), Filter: condition };
    expect(() => assertGrowthPointPlans({ ...captured, plans: [missing] }, keys, globalGrantIndex)).toThrow(
      'Expected exact',
    );
  }
  for (const invalid of [
    { ...node, 'Index Name': 'another_index' },
    { ...node, 'Node Type': 'Seq Scan' },
    { ...node, 'Index Cond': undefined, Filter: condition },
  ])
    expect(() => assertGrowthPointPlans({ ...captured, plans: [node, invalid] }, keys, globalGrantIndex)).toThrow(
      'Expected exact',
    );
  expect(() =>
    assertGrowthPointPlans(
      { ...captured, plans: [{ ...node, Schema: 'other' }] },
      { 'other.resource_grant': keys['access.resource_grant'] },
      globalGrantIndex,
    ),
  ).toThrow('Expected exact');
  expect(() =>
    assertGrowthPointPlans({ ...captured, plans: [{ ...node, 'Actual Loops': 0 }] }, keys, globalGrantIndex),
  ).toThrow('Missing executed point probe');
});

test('checkGrowth proves rows statements and buffers match declared cost', async () => {
  const sourceRoute = tupleRoute(routeKey, input.provenance.source, input.provenance.external_id);
  const operation = async () => {
    const result = await accepted();
    const status = await poll(result.body.media.id);
    expect(status.response.status).toBe(200);
    expect(checkMediaImportStatus(status.body)).toEqual([]);
  };
  const report = await checkGrowth(db, {
    name: 'HTTP native media import and protected point poll',
    rule: 'series',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    warmups: 1,
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'unrelated and same-partition media',
          hotPartition: partitionOf(route),
          rows(placement) {
            const actor = newId(placement.route);
            const id = newId(placement.route);
            return {
              'access.account': [
                { route: placement.route, account_id: actor, kind: 'actor', state: 'active', transaction_id: actor },
              ],
              'access.resource_grant': [
                {
                  route: 0,
                  resource_id: platformId,
                  subject_id: actor,
                  action: 'media:import_from_url',
                  valid: '(,)',
                  transaction_id: actor,
                },
              ],
              'access.resource_role_grant': [
                {
                  route: placement.route,
                  resource_id: id,
                  subject_id: accountId,
                  grant_role: 'creator',
                  valid: '(,)',
                  transaction_id: actor,
                },
              ],
              'access.resource_initialization': [
                {
                  route: placement.route,
                  resource_id: id,
                  resource_type: 'content.media',
                  creator_id: accountId,
                  initialized_at: '2026-01-01T00:00:00Z',
                },
              ],
              'semantic.subject': [
                { route: placement.route, subject_id: id, type: 'schema:Book', recorded_transaction_id: id },
              ],
              'semantic.context': [
                { route: placement.route, context_id: id, kind: 'community', labels: {}, recorded_transaction_id: id },
              ],
              'content.source_fences': [placement.route, sourceRoute].map((home, index) => ({
                route: home,
                source: input.provenance.source,
                external_id: `growth-${index}-${placement.ordinal}`,
                field_group: 'cover',
                taken_down: false,
                security_revision: 1,
              })),
              'content.media': [
                {
                  route: placement.route,
                  media_id: id,
                  container_id: newId(placement.route),
                  uploader_id: accountId,
                  reservation_request_id: id,
                  purpose: 'post-image',
                  media_type: 'image/jpeg',
                  byte_count: 128,
                  state: 'reserved',
                  key: `m/${id}/original`,
                  transaction_id: id,
                },
              ],
              'content.media_variant': [
                {
                  route: placement.route,
                  media_id: id,
                  format: 'webp',
                  width: 320,
                  height: 200,
                  media_type: 'image/webp',
                  byte_count: 64,
                  sha256: 'b'.repeat(64),
                  key: `m/${id}/webp-320`,
                  transaction_id: id,
                },
              ],
            };
          },
        },
        { from: previous * 32, to: scale * 32 },
      );
      await seedMediaCommandHistory(
        database,
        route,
        accountId,
        'content.media.importFromUrl',
        previous * 32,
        scale * 32,
      );
    },
    operation,
    async warmup(database) {
      const measured = await capture(database, operation);
      assertGrowthPointPlans(
        measured.capture,
        {
          'content.media': ['route', 'media_id'],
          'content.media_variant': ['route', 'media_id'],
          'content.source_fences': ['route', 'source', 'external_id', 'field_group'],
          'access.resource_role_grant': [
            'route',
            'resource_id',
            'subject_id',
            'subject_kind',
            'subject_role',
            'grant_role',
            'valid',
          ],
          'semantic.subject': ['route', 'subject_id'],
          'semantic.context': ['route', 'context_id'],
          'access.resource_grant': [
            'route',
            'resource_id',
            'subject_id',
            'subject_kind',
            'subject_role',
            'action',
            'valid',
          ],
        },
        globalGrantIndex,
      );
    },
  });
  expect(report.samples).toHaveLength(3);
  expect(report.samples.every((sample) => sample.cost.statements > 0 && sample.cost.blocks > 0)).toBe(true);
});
