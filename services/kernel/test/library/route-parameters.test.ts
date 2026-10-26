import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import type { CollectionView } from '../../src/library/collection-reads.ts';
import { syncSubjectListing } from '../../src/library/listing.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const owner = newId(0x6c32);
const routeKey = new Uint8Array(32).fill(73);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(74)]]) };
const scopes = ['collection:create', 'collection:read', 'collection:update', 'subject:read', 'exposure:open'];
const LIBRARY_EXPOSURES = new Set(['gate:collections', 'gate:personal_library', 'gate:reading_progress']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

type Parameter = { in?: string; name?: string };
type Operation = { parameters?: Parameter[]; 'x-exposure'?: string };
type PathItem = Record<string, Operation>;

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let subjectId: string;
let shelf: CollectionView;
let credential: string;

function documentOf() {
  return openApiDocument(app) as { paths: Record<string, PathItem> };
}

function isLibraryPath(item: PathItem): boolean {
  return Object.entries(item).some(
    ([method, operation]) => HTTP_METHODS.has(method) && LIBRARY_EXPOSURES.has(operation?.['x-exposure'] ?? ''),
  );
}

function pathParameters(path: string): { name: string; prefix: string }[] {
  const found: { name: string; prefix: string }[] = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    found.push({ name: match[1]!, prefix: path.slice(0, match.index) });
  }
  return found;
}

async function request(method: string, path: string, body?: unknown, anonymous = false) {
  return app.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers: {
        ...(anonymous ? {} : { authorization: `Bearer ${credential}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'route-parameters', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.route-parameters.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.route-parameters.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
  });
  await db.admin.query(
    `INSERT INTO access.account
    (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
    VALUES ($1,$2,'actor','active',$2,false,1,true)`,
    [routeOf(owner), owner],
  );
  credential = await new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'route-parameters', typ: 'at+jwt' })
    .setIssuer('https://auth.route-parameters.test')
    .setAudience('https://api.rezics.test')
    .setSubject(owner)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  await bootstrapGovernance(db.pool, owner);
  const opened = await request('POST', '/v1/platform/exposure/collections:open');
  expect(opened.status).toBe(200);
  const requestKey = randomUUID();
  const actor: AccountActor = {
    kind: 'account',
    accountId: owner,
    clientId: 'web',
    scopes,
    requestedBy: null,
    authnEpoch: 1,
  };
  const subject = await createSubject(db.pool, {
    actor,
    target: subjectTarget(routeKey, owner, requestKey),
    idempotencyKey: requestKey,
    digest: createHash('sha256').update(requestKey).digest(),
    item: { type: 'schema:Book', labels: { en: 'Route parameter subject' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  subjectId = subject.subject.id;
  const created = await request('POST', '/v1/collections', {
    title: 'Shelf',
    description: 'Curated books',
    visibility: 'public',
  });
  expect(created.status).toBe(201);
  shelf = ((await created.json()) as { collection: CollectionView }).collection;
  const member = await request('POST', `/v1/collections/${shelf.id}/members`, { subjectId });
  expect(member.status).toBe(201);
  await syncSubjectListing({ pool: db.pool }, { subjectId, collectionId: shelf.id });
});

afterAll(async () => {
  await db?.close();
});

test("a subject's public Collections are served under the subjects path with the path parameter named id", async () => {
  const document = documentOf();
  const paths = Object.keys(document.paths);
  const route = document.paths['/v1/subjects/{id}/collections']?.get;
  expect(route).toBeDefined();
  expect(route?.parameters ?? []).toContainEqual(expect.objectContaining({ in: 'path', name: 'id' }));
  expect(paths.filter((path) => path.startsWith('/v1/subjects/') && path.includes('{subjectId}'))).toEqual([]);

  const response = await request('GET', `/v1/subjects/${subjectId}/collections`, undefined, true);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    collections: { id: string }[];
    count: { value: number; exact: true };
    next: string | null;
  };
  expect(Object.keys(body).sort()).toEqual(['collections', 'count', 'next']);
  expect(body.count).toEqual({ value: 0, exact: true });
  expect(body.collections.map((collection) => collection.id)).toContain(shelf.id);
});

test('no library route names a path parameter differently from another kernel route at the same position', () => {
  const document = documentOf();
  const paths = Object.keys(document.paths);
  const conflicts: string[] = [];
  for (const path of paths) {
    const item = document.paths[path]!;
    if (!isLibraryPath(item)) continue;
    for (const parameter of pathParameters(path)) {
      for (const other of paths) {
        if (other === path) continue;
        for (const candidate of pathParameters(other)) {
          if (candidate.prefix !== parameter.prefix || candidate.name === parameter.name) continue;
          conflicts.push(`${path} uses {${parameter.name}} but ${other} uses {${candidate.name}}`);
        }
      }
    }
  }
  expect(conflicts).toEqual([]);
});
