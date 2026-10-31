import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent, accountAgentId } from '../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const accounts = { person: newId(21000), editor: newId(21016), moderator: newId(21032) };
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'context:create',
  'moderation:hide',
];
const real = await createRealAccess(admin, accounts, actions);
const kernel = createKernel({
  pool,
  access: real.access,
  writeRate: real.writeRate,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) },
  routeKey: new Uint8Array(32).fill(73),
});
const projection = linkProjection(pool);
const relays = startRelays(pool, [projection], { intervalMs: 20 });
const property = 'rezics:penNameOf';
const target = accountAgentId(accounts.person);
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const reference = { parts: [snak('schema:url', 'https://example.test/biography')] };
const statement = (sourced: boolean) => ({
  ...snak(property, target),
  qualifiers: [],
  references: sourced ? [reference] : [],
});
const sessions = new Map<string, string>();
type Persona = keyof typeof accounts;
async function call(method: string, path: string, as?: Persona, body?: unknown, key = randomUUID()) {
  const headers: Record<string, string> = {};
  if (as) {
    headers.authorization = `Bearer ${real.bearer(as)}`;
    const session = sessions.get(as);
    if (session) headers['rezics-session-token'] = session;
  }
  if (method === 'POST') headers['idempotency-key'] = `"${key}"`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const session = response.headers.get('rezics-session-token');
  if (as && session) sessions.set(as, session);
  return { status: response.status, body: (await response.json()) as any };
}
async function created(type = 'schema:Person', statements = {}, as: Persona = 'editor') {
  const result = await call('POST', '/v1/subjects', as, { type, labels: { en: `Agent ${randomUUID()}` }, statements });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.subject;
}
async function read(id: string, as?: Persona, context?: string) {
  const result = await call('GET', `/v1/subjects/${id}${context ? `?context=${context}` : ''}`, as);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.subject;
}
async function page(path: string, as?: Persona) {
  const result = await call('GET', path, as);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}
async function catchUp(id: string) {
  for (let i = 0; i < 200; i++) {
    const result = await projection.run(partitionOf(routeOf(id)!));
    if (result.status === 'read' && result.envelopes === 0) return;
    await Bun.sleep(5);
  }
  throw new Error('Projection did not drain');
}
const subjectIds = (subject: any) => (subject.statements[property] ?? []).map((row: any) => row.id);
const relations = (id: string) => `/v1/subjects/${id}/relations?property=${encodeURIComponent(property)}`;
const inverse = () => `/v1/subjects/${target}/links?property=${encodeURIComponent(property)}`;
const candidates = (id: string) =>
  `/v1/subjects/${id}/candidates?property=${encodeURIComponent(property)}&target=${target}`;
async function proposed(id: string, as: Persona, sourced = false) {
  return call('POST', `/v1/subjects/${id}/candidates`, as, { statement: statement(sourced) });
}

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  for (const as of ['person', 'editor'] as const)
    for (const action of ['subject:create', 'statement:propose', 'context:accept', 'context:adopt', 'context:create'])
      await real.grant({ route: 0, id: GLOBAL_CONTEXT }, as, action);
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
  await ensureAccountAgent(pool, { account: accounts.person, kind: 'person', name: 'The person behind the name' });
});
afterAll(async () => {
  await relays.stop();
  await Promise.all([pool.end(), admin.end()]);
});

test('consent statements can be retracted before or after disclosure and cannot be disclosed again', async () => {
  for (const publish of [false, true]) {
    const pen = await created('schema:Person', { [property]: [statement(false)] }, 'person');
    const candidate = pen.statements[property][0].id;
    if (publish) expect((await call('POST', `/v1/statements/${candidate}/disclose`, 'person')).status).toBe(200);
    await catchUp(pen.id);
    expect((await call('POST', `/v1/statements/${candidate}/retract`, 'editor')).status).toBe(403);
    const retracted = await call('POST', `/v1/statements/${candidate}/retract`, 'person');
    expect([retracted.status, retracted.body]).toEqual([200, { candidate, retracted: true }]);
    await catchUp(pen.id);
    for (const as of [undefined, 'person', 'moderator'] as const) {
      expect(subjectIds(await read(pen.id, as))).toEqual([]);
      expect(await page(relations(pen.id), as)).not.toHaveProperty('count');
      expect((await page(inverse(), as)).links.map((row: any) => row.statement)).not.toContain(candidate);
    }
    const client = await admin.connect();
    try {
      expect((await readCandidateDisclosure(client, { subject: pen.id, candidate }))?.disclosed).toBe(false);
    } finally {
      client.release();
    }
    const snapshot = await subjectSource(pool).read(partitionOf(routeOf(pen.id)!), [pen.id]);
    expect(snapshot.subjects[0]!.statements.filter((row) => row.property === property)).toEqual([]);
    expect((await call('POST', `/v1/statements/${candidate}/disclose`, 'person')).status).toBe(409);
    expect((await call('POST', `/v1/statements/${candidate}/retract`, 'person')).status).toBe(200);
  }
});

test('private consent preserves public facts and a sourced replacement publishes through ordinary review', async () => {
  const pen = await created('schema:Person', { [property]: [statement(true)] });
  const original = pen.statements[property][0].id;
  await catchUp(pen.id);
  const own = await proposed(pen.id, 'person');
  expect(own.status).toBe(201);
  expect(subjectIds(await read(pen.id))).toEqual([original]);
  expect(await page(relations(pen.id))).not.toHaveProperty('count');
  const replacement = await proposed(pen.id, 'editor', true);
  expect(replacement.status).toBe(201);
  const decision = await call(
    'POST',
    `/v1/subjects/${pen.id}/candidates/${replacement.body.candidate}:accept`,
    'editor',
    {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    },
  );
  expect(decision.status).toBe(200);
  const listing = await page(candidates(pen.id), 'person');
  const adoption = await call('POST', `/v1/subjects/${pen.id}:adopt`, 'editor', {
    context: GLOBAL_CONTEXT,
    property,
    target,
    mode: 'replace',
    selection: [{ candidate: replacement.body.candidate, rank: 'normal' }],
    expected_head: listing.adoption.head,
  });
  expect(adoption.status, JSON.stringify(adoption.body)).toBe(200);
  await catchUp(pen.id);
  expect(subjectIds(await read(pen.id))).toEqual([replacement.body.candidate]);
  expect(await page(relations(pen.id))).not.toHaveProperty('count');
  expect((await page(inverse())).links.map((row: any) => row.statement)).toContain(replacement.body.candidate);
});

test('disclosure and retraction preserve a Context suppression in relation pages and counts', async () => {
  const pen = await created('schema:Person', { [property]: [statement(false)] }, 'person');
  const candidate = pen.statements[property][0].id;
  const context = await call('POST', '/v1/contexts', 'editor', { labels: { en: 'Private names omitted' } });
  expect(context.status, JSON.stringify(context.body)).toBe(201);
  const contextId = context.body.context.id;
  const suppression = await call('POST', `/v1/subjects/${pen.id}:adopt`, 'editor', {
    context: contextId,
    property,
    target,
    mode: 'suppress',
    selection: [],
    expected_head: null,
  });
  expect(suppression.status, JSON.stringify(suppression.body)).toBe(200);
  expect((await call('POST', `/v1/statements/${candidate}/disclose`, 'person')).status).toBe(200);
  await catchUp(pen.id);
  expect(subjectIds(await read(pen.id))).toEqual([candidate]);
  expect(subjectIds(await read(pen.id, undefined, contextId))).toEqual([]);
  expect((await read(pen.id, undefined, contextId)).relationCounts).not.toHaveProperty(property);
  const forward = await page(`${relations(pen.id)}&context=${contextId}`);
  expect(forward.relations).toEqual([]);
  expect(forward).not.toHaveProperty('count');
  expect((await page(`${inverse()}&context=${contextId}`)).links.map((row: any) => row.statement)).not.toContain(
    candidate,
  );
  expect((await call('POST', `/v1/statements/${candidate}/retract`, 'person')).status).toBe(200);
  await catchUp(pen.id);
  expect(await page(relations(pen.id))).not.toHaveProperty('count');
  expect(await page(`${relations(pen.id)}&context=${contextId}`)).not.toHaveProperty('count');
  expect((await page(`${inverse()}&context=${contextId}`)).links.map((row: any) => row.statement)).not.toContain(
    candidate,
  );
});
