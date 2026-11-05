import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { disclosedRelationStatement, linkProjection } from '../../src/semantic/links.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const relays = startRelays(pool, [linkProjection(pool)], { intervalMs: 50 });
afterAll(async () => {
  await relays.stop();
  await pool.end();
  await admin.end();
});

const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  acceptor: '019a1b2c-3d4e-7f00-8a00-acce97000002',
};
const actions = ['subject:create', 'subject:read', 'statement:propose', 'context:accept', 'context:adopt'];
const realAccess = await createRealAccess(admin, accounts, actions);
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'context:accept');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'context:adopt');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});

const sessions: Record<string, string> = {};
async function call(
  method: string,
  path: string,
  options: { as?: string; key?: string; body?: unknown; kernel?: typeof kernel } = {},
) {
  const headers: Record<string, string> = {};
  if (options.as) {
    const credential = Object.hasOwn(accounts, options.as)
      ? realAccess.bearer(options.as as keyof typeof accounts)
      : options.as;
    headers.authorization = `Bearer ${credential}`;
    const session = sessions[options.as];
    if (session) headers['rezics-session-token'] = session;
  }
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await (options.kernel ?? kernel).handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const session = response.headers.get('rezics-session-token');
  if (options.as && session) sessions[options.as] = session;
  return { response, body: (await response.json()) as Record<string, any> };
}
const key = () => `"${randomUUID()}"`;
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function created(body: unknown, target = kernel): Promise<Record<string, any>> {
  const answer = await call('POST', '/v1/subjects', { as: 'editor', key: key(), body, kernel: target });
  expect(answer.response.status).toBe(201);
  return answer.body.subject;
}

test('native links and relations preserve each credit qualifier and stored release without pairing roles across statements', async () => {
  const person = await created({ type: 'schema:Person', labels: { en: 'Qualified performer' } });
  const role = await created({ type: 'skos:Concept', labels: { en: 'Narration' } });
  const character = await created({ type: 'wd:Q95074', labels: { en: 'The traveller' } });
  const source = await created({
    type: 'schema:Book',
    labels: { en: 'Qualified story' },
    statements: {
      'schema:author': [
        {
          ...statement('schema:author', person.id),
          qualifiers: [
            statement('wdt:P1932', 'First pen name'),
            statement('schema:position', '1'),
            statement('wdt:P3831', role.id),
          ],
        },
        {
          ...statement('schema:author', person.id),
          qualifiers: [statement('wdt:P1932', 'Second pen name'), statement('schema:position', '2')],
        },
      ],
      'schema:character': [
        {
          ...statement('schema:character', character.id),
          qualifiers: [statement('wdt:P3831', role.id), statement('rezics:spoilerLevel', { amount: '+2', unit: '1' })],
        },
      ],
    },
  });
  const incoming = await call('GET', `/v1/subjects/${person.id}/links?property=schema:author`, { as: 'editor' });
  expect(incoming.response.status).toBe(200);
  expect(incoming.body.links).toHaveLength(2);
  const assertions = incoming.body.links.map((row: any) => row.assertion);
  expect(
    assertions.map(
      (assertion: any) => assertion.qualifiers.find((q: any) => q.property.id === 'wdt:P1932').value.content,
    ),
  ).toEqual(['First pen name', 'Second pen name']);
  expect(assertions[0].rezics.release).toBe(source.statements['schema:author'][0].rezics.release);
  expect(assertions[0].qualifiers.find((q: any) => q.property.id === 'wdt:P3831').property.data_type).toBe(
    'wikibase-item',
  );
  expect(incoming.body.links[0].related[role.id].label.value).toBe('Narration');
  const outgoing = await call('GET', `/v1/subjects/${source.id}/relations?property=schema:character`, { as: 'editor' });
  expect(outgoing.response.status).toBe(200);
  expect(outgoing.body.relations[0].statement.qualifiers.map((q: any) => q.property.id)).toEqual([
    'wdt:P3831',
    'rezics:spoilerLevel',
  ]);
  expect(outgoing.body.relations[0].related[role.id].label.value).toBe('Narration');
  const visible = outgoing.body.relations[0];
  const concealedRole = disclosedRelationStatement(visible.statement, new Map([[character.id, visible.summary]]));
  expect(concealedRole?.qualifiers.map((q) => q.property.id)).toEqual(['rezics:spoilerLevel']);
  expect(JSON.stringify(concealedRole)).not.toContain(role.id);
  expect(disclosedRelationStatement(visible.statement, new Map())).toBeNull();
});

test('anonymous unqualified release navigation retains the original membership assertion and work direction', async () => {
  const work = await created({ type: 'wd:Q689445', labels: { en: 'Public visual novel' } });
  const release = await created({
    type: 'wd:Q20631656',
    labels: { en: 'Actual software release' },
    statements: { 'schema:exampleOfWork': [statement('schema:exampleOfWork', work.id)] },
  });
  const incoming = await call('GET', `/v1/subjects/${work.id}/links?property=schema:exampleOfWork&limit=20`);
  expect(incoming.response.status).toBe(200);
  const [row] = incoming.body.links;
  expect(incoming.body.links).toHaveLength(1);
  expect(row.subject).toBe(release.id);
  expect(row.summary.id).toBe(release.id);
  expect(row.statement).toBe(release.statements['schema:exampleOfWork'][0].id);
  expect(row.assertion).toEqual(release.statements['schema:exampleOfWork'][0]);
  expect(row.assertion.value).toEqual({ type: 'value', content: work.id });
  expect(row.assertion.qualifiers).toEqual([]);
  // A withheld work target cannot be turned into a raw-ID navigation fallback.
  expect(disclosedRelationStatement(row.assertion, new Map())).toBeNull();
});
