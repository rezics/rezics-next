import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { AuthenticationError, type Access, type AccountActor } from '../../src/request/access.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const release: Release = {
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://rezics.com/catalogue/targets-test', version: '1.0.0' },
  generator: { name: 'test', version: '1' },
  prefixes: { ex: 'https://example.test/' },
  types: {
    'ex:Leaf': {
      iri: 'https://example.test/Leaf',
      labels: { en: 'leaf' },
      mappings: [],
      bases: ['ex:Base'],
      properties: ['ex:related'],
      facets: [],
    },
    'ex:Other': {
      iri: 'https://example.test/Other',
      labels: { en: 'other' },
      mappings: [],
      bases: [],
      properties: [],
      facets: [],
    },
  },
  properties: {
    'ex:related': {
      iri: 'https://example.test/related',
      labels: { en: 'related item' },
      mappings: [],
      datatype: 'wikibase-item',
      multivalued: false,
      targets: ['ex:Base'],
      qualifiers: [],
      value: valueSchema('wikibase-item'),
    },
    'ex:source': {
      iri: 'https://example.test/source',
      labels: { en: 'source' },
      mappings: [],
      datatype: 'url',
      multivalued: false,
      qualifiers: [],
      value: valueSchema('url'),
    },
  },
};
const digest = releaseDigest(release);
beforeAll(async () => {
  expect(await bootstrapRelease(pool, release)).toBe(digest);
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const editor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  clientId: 'web',
  scopes: ['subject:create', 'subject:read', 'statement:propose'],
  requestedBy: null,
  authnEpoch: 1,
};
const access: Access = {
  async authenticate(token) {
    if (token !== 'editor') throw new AuthenticationError(401, 'Bearer error="invalid_token"');
    return editor;
  },
  async authorize(_client, actor, action, resource) {
    return (
      action === 'subject:read' ||
      (['subject:create', 'statement:propose'].includes(action) &&
        actor.kind === 'account' &&
        actor.accountId === editor.accountId &&
        resource.id === GLOBAL_CONTEXT)
    );
  },
};
const kernel = createKernel({
  pool,
  access,
  tokens,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: {
    async spend() {
      return { allowed: true };
    },
  },
});

async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: 'Bearer editor',
        'idempotency-key': `"${randomUUID()}"`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

const relation = (id: string) => ({
  property: { id: 'ex:related' },
  value: { type: 'value', content: id },
  references: [
    {
      parts: [{ property: { id: 'ex:source' }, value: { type: 'value', content: 'https://example.test/source' } }],
    },
  ],
});
const create = (type: string, statements: Record<string, unknown> = {}) =>
  call('POST', '/v1/subjects', {
    type,
    labels: { en: type },
    ...(Object.keys(statements).length ? { statements } : {}),
  });
const createLeaf = (statements: Record<string, unknown> = {}) => create('ex:Leaf', statements);
const count = async (table: string, subject?: string): Promise<number> => {
  const query = subject
    ? `SELECT count(*)::int AS n FROM semantic.${table} WHERE subject_id = $1`
    : `SELECT count(*)::int AS n FROM semantic.${table}`;
  const { rows } = await admin.query(query, subject ? [subject] : []);
  return rows[0].n;
};

test("an item value matches a target that is its type or one of its type's bases", async () => {
  const leaf = await createLeaf();
  expect(leaf.response.status).toBe(201);

  const created = await createLeaf({ 'ex:related': [relation(leaf.body.subject.id)] });
  expect(created.response.status).toBe(201);

  const proposalSubject = await createLeaf();
  const proposed = await call('POST', `/v1/subjects/${proposalSubject.body.subject.id}/candidates`, {
    statement: relation(leaf.body.subject.id),
  });
  expect(proposed.response.status).toBe(201);
  expect(proposed.body).toMatchObject({ candidate: expect.any(String), revision: 2 });
});

test('an item value whose type neither is nor descends from a target is refused at its pointer', async () => {
  const leaf = await createLeaf();
  const other = await create('ex:Other');
  expect(other.response.status).toBe(201);

  const subjectsBefore = await count('subject');
  const refusedCreate = await createLeaf({ 'ex:related': [relation(other.body.subject.id)] });
  expect(refusedCreate.response.status).toBe(400);
  expect(refusedCreate.body.errors).toContainEqual({
    pointer: '/statements/ex:related/0/value/content',
    code: 'out_of_range',
  });
  expect(await count('subject')).toBe(subjectsBefore);

  const revisionsBefore = await count('revision', leaf.body.subject.id);
  const candidatesBefore = await count('candidate', leaf.body.subject.id);
  const refusedProposal = await call('POST', `/v1/subjects/${leaf.body.subject.id}/candidates`, {
    statement: relation(other.body.subject.id),
  });
  expect(refusedProposal.response.status).toBe(400);
  expect(refusedProposal.body.errors).toContainEqual({
    pointer: '/statement/value/content',
    code: 'out_of_range',
  });
  expect(await count('revision', leaf.body.subject.id)).toBe(revisionsBefore);
  expect(await count('candidate', leaf.body.subject.id)).toBe(candidatesBefore);
});
