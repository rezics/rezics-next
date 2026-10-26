import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createRealAccess } from '../semantic/real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001' };
const realAccess = await createRealAccess(admin, accounts, ['subject:create']);
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(7),
  access: realAccess.access,
  writeRate: realAccess.writeRate,
});

async function call(method: string, path: string, body?: unknown, editor = false) {
  const headers: Record<string, string> = {};
  if (editor) {
    headers.authorization = `Bearer ${realAccess.bearer('editor')}`;
    headers['idempotency-key'] = `"${randomUUID()}"`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

const pageRead = (subject: string) => call('POST', '/v1/pages:read', { target: { subject } });
async function create(type: string, label: string): Promise<string> {
  const created = await call('POST', '/v1/subjects', { type, labels: { en: label } }, true);
  expect(created.response.status).toBe(201);
  return created.body.subject.id;
}
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const document = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });

let subject: string;
let profile: PresentationProfile;

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  subject = await create('schema:Book', 'Page read kinds');
  profile = {
    format: PROFILE_FORMAT,
    generic: document(node('SubjectHeader', 'header'), node('MoreStatements', 'more')),
    bases: [],
    types: [
      {
        type: 'schema:Book',
        document: document(
          node('SubjectHeader', 'header'),
          node('RelationGroups', 'links', {
            property: 'wdt:P725',
            filter: subject,
            type: 'schema:Person',
            limit: 12,
          }),
          node('CollectionList', 'collections', { title: 'Collections', limit: 6 }),
          node('ReactionSummary', 'reactions'),
        ),
      },
    ],
    routes: [],
  };
  await bootstrapProfile(pool, profile);
});

test('a page read plans and answers an inverse links read by property, filter and type, with its exact or at-least count', async () => {
  const answer = await pageRead(subject);
  expect(answer.response.status).toBe(200);
  expect(answer.body.profile).toBe(profileDigest(profile));
  expect(Object.keys(answer.body.reads).sort()).toEqual(['r0', 'r1', 'r2', 'r3']);

  const standalone = await call(
    'GET',
    `/v1/subjects/${subject}/links?property=wdt%3AP725&filter=${subject}&type=schema%3APerson&limit=12`,
  );
  expect(answer.body.reads.r1).toEqual({ status: standalone.response.status, body: standalone.body });
  expect(answer.body.reads.r1.body.count).toMatchObject({ value: expect.any(Number), exact: expect.any(Boolean) });
  expect(answer.body.reads.r1.body.links).toEqual([]);
});

test("a page read plans and answers the subject's public collections read with its count", async () => {
  const answer = await pageRead(subject);
  expect(answer.response.status).toBe(200);
  const standalone = await call('GET', `/v1/subjects/${subject}/collections?limit=6`);
  expect(answer.body.reads.r2).toEqual({ status: standalone.response.status, body: standalone.body });
  expect(answer.body.reads.r2.body.collections).toEqual([]);
  expect(answer.body.reads.r2.body.count).toEqual({ value: 0, exact: true });
});

test("a page read plans and answers the subject's reaction counts without a viewer's own reaction", async () => {
  const answer = await pageRead(subject);
  expect(answer.response.status).toBe(200);
  const standalone = await call('GET', `/v1/subjects/${subject}/reactions`);
  expect(answer.body.reads.r3).toEqual({ status: standalone.response.status, body: standalone.body });
  expect(answer.body.reads.r3.body).not.toHaveProperty('viewerReaction');
  expect(answer.body.reads.r3.body.counts).toEqual([]);
});
