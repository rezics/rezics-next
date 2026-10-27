import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import * as semantic from '../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const accounts = { owner: newId(21000), editor: newId(21001), stranger: newId(21002), platform: newId(21003) };
let now = new Date();
const clock = () => new Date(now);
const day = 86_400_000;
const actions = [
  'definitions:publish',
  'definitions:activate',
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:create',
  'context:read',
  'context:accept',
  'context:adopt',
  'statement:delete',
  'statement:restore',
  'account:delete',
  'context:delete',
  'context:restore',
  'semantic:purge',
  'semantic:hold',
  'moderation:takedown',
];
const real = await createRealAccess(admin, accounts, actions);
const routeKey = new Uint8Array(32).fill(71);
const kernel = createKernel({
  pool,
  access: real.access,
  clock,
  routeKey,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) },
  writeRate: createWriteRateLimiter({
    secret: 'semantic-deletion-native-test-rate-secret',
    overrides: '{"new-account":{"write":{"maximum":10000,"seconds":60}}}',
  }),
});
type Persona = keyof typeof accounts;
async function call(method: string, path: string, persona?: Persona, body?: unknown, key = `"${randomUUID()}"`) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(persona ? { authorization: `Bearer ${real.bearer(persona)}` } : {}),
        'idempotency-key': key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
function status(answer: { status: number; body: unknown }, expected: number) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(expected);
}
const snak = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
const cited = (property: string, content: unknown) => ({
  ...snak(property, content),
  references: [{ parts: [snak('schema:url', 'https://example.test/evidence')] }],
});
async function person(label = 'Communal catalogue person') {
  const result = await call('POST', '/v1/subjects', 'owner', { type: 'schema:Person', labels: { en: label } });
  status(result, 201);
  return result.body.subject.id as string;
}
async function proposal(subject: string, payload = `https://example.test/personal/${randomUUID()}`) {
  const result = await call('POST', `/v1/subjects/${subject}/candidates`, 'owner', {
    statement: cited('schema:url', payload),
  });
  status(result, 201);
  return { subject, candidate: result.body.candidate as string, payload };
}
const path = (record: { subject: string; candidate: string }) =>
  `/v1/subjects/${record.subject}/candidates/${record.candidate}`;
async function accept(record: { subject: string; candidate: string }) {
  status(await call('POST', `${path(record)}:accept`, 'editor', { context: GLOBAL_CONTEXT, expected_head: null }), 200);
}
async function adopt(record: { subject: string; candidate: string }, expected: number | null) {
  const result = await call('POST', `/v1/subjects/${record.subject}:adopt`, 'editor', {
    context: GLOBAL_CONTEXT,
    property: 'schema:url',
    mode: 'replace',
    selection: [{ candidate: record.candidate, rank: 'normal' }],
    expected_head: expected,
  });
  status(result, 200);
  return result.body.adoption.head as number;
}
async function current(subject: string) {
  const result = await call('GET', `/v1/subjects/${subject}`, 'owner');
  status(result, 200);
  return result.body.subject;
}
async function revisions(subject: string) {
  return (
    await admin.query(
      'SELECT revision, kind FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision',
      [routeOf(subject), subject],
    )
  ).rows;
}
async function caughtUp(subject: string) {
  const projection = linkProjection(pool);
  for (let i = 0; i < 200; i++) {
    const result = await projection.run(partitionOf(routeOf(subject)!));
    if (result.status !== 'busy' && result.envelopes === 0) return;
    await Bun.sleep(5);
  }
  throw new Error('Link projection did not drain');
}
// Required native retention adapter, not an HTTP purge permission or a simulated worker.
// The import above exists on the base. Route outcomes fail before this unimplemented adapter is reached.
type RetentionPage = { examined: number; purged: number; checkpoint: string | null; done: boolean };
function retention() {
  const factory = Reflect.get(semantic, 'semanticRetention');
  expect(typeof factory, 'Semantic must expose its native durable retention adapter').toBe('function');
  return (
    factory as (
      pool: ReturnType<typeof createPool>,
      options: { clock: () => Date },
    ) => {
      step(input: { partition: number; limit: number; key: string }): Promise<RetentionPage>;
    }
  )(pool, { clock });
}
async function drain(subject: string) {
  const job = retention();
  for (let page = 0; page < 100; page++) {
    const result = await job.step({ partition: partitionOf(routeOf(subject)!), limit: 2, key: randomUUID() });
    expect(result.examined).toBeLessThanOrEqual(2);
    if (result.done) return;
  }
  throw new Error('Retention did not exhaust this small fixture');
}
async function absentPayload(payload: string) {
  // Evidence reads only; no SQL fixture writes or invented purge progress.
  const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='semantic'")).rows;
  for (const { tablename } of tables) {
    const result = await admin.query(
      `SELECT count(*)::int AS n FROM semantic."${tablename}" AS r WHERE strpos(to_jsonb(r)::text,$1)>0`,
      [payload],
    );
    expect(result.rows, tablename).toEqual([{ n: 0 }]);
  }
  for (const table of ['core.outbox', 'core.receipt']) {
    const result = await admin.query(
      `SELECT count(*)::int AS n FROM ${table} AS r WHERE strpos(to_jsonb(r)::text,$1)>0`,
      [payload],
    );
    expect(result.rows, table).toEqual([{ n: 0 }]);
  }
}
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  for (const action of ['subject:create', 'statement:propose', 'context:create'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', action);
  for (const action of ['context:accept', 'context:adopt'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  for (const action of ['moderation:takedown', 'semantic:purge', 'semantic:hold'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'platform', action);
});
afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

test('user-owned semantic records soft-delete and restore without resurrecting superseded decisions', async () => {
  const subject = await person();
  const old = await proposal(subject);
  await accept(old);
  const head = await adopt(old, null);
  const before = await revisions(subject);
  status(await call('DELETE', path(old), 'stranger'), 403);
  const deletedAt = clock().getTime();
  status(await call('DELETE', path(old), 'owner'), 200);
  expect(JSON.stringify(await current(subject))).not.toContain(old.payload);
  const candidates = await call('GET', `/v1/subjects/${subject}/candidates?property=schema%3Aurl`, 'owner');
  status(candidates, 200);
  expect(candidates.body.candidates).toContainEqual(expect.objectContaining({ id: old.candidate, deleted: true }));
  expect(JSON.stringify(candidates.body)).not.toContain(old.payload);
  expect(await readCandidateDisclosure(admin, old)).toEqual(expect.objectContaining({ disclosed: false }));
  const source = await subjectSource(pool, routeKey).read(partitionOf(routeOf(subject)!), [subject]);
  expect(JSON.stringify(source.subjects)).not.toContain(old.payload);
  const replacement = await proposal(subject);
  await accept(replacement);
  await adopt(replacement, head);
  now = new Date(deletedAt + 29 * day);
  status(await call('POST', `${path(old)}:restore-deleted`, 'stranger', {}), 403);
  status(await call('POST', `${path(old)}:restore-deleted`, 'owner', {}), 200);
  const shown = JSON.stringify(await current(subject));
  expect(shown).toContain(replacement.payload);
  expect(shown).not.toContain(old.payload);
  const after = await revisions(subject);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(new Set(after.map((row) => row.revision)).size).toBe(after.length);
});

test('owner restore expires at thirty days and cannot reverse current moderation', async () => {
  const record = await proposal(await person());
  const deletedAt = clock().getTime();
  status(await call('DELETE', path(record), 'owner'), 200);
  status(
    await call('POST', `${path(record)}:takedown`, 'platform', {
      notice: { complaint: 'One field', received_at: clock().toISOString(), scope: '/value' },
    }),
    200,
  );
  now = new Date(deletedAt + 29 * day);
  status(await call('POST', `${path(record)}:restore-deleted`, 'owner', {}), 200);
  expect((await readCandidateDisclosure(admin, record))?.disclosed).toBe(false);
  const expired = await proposal(await person());
  status(await call('DELETE', path(expired), 'owner'), 200);
  now = new Date(clock().getTime() + 30 * day);
  status(await call('POST', `${path(expired)}:restore-deleted`, 'owner', {}), 409);
});

test('community Context deletion uses its real owner and restores the same identity', async () => {
  const created = await call('POST', '/v1/contexts', 'owner', { labels: { en: 'Owned editorial context' } });
  status(created, 201);
  const id = created.body.context.id;
  status(await call('DELETE', `/v1/contexts/${id}`, 'stranger'), 403);
  status(await call('DELETE', `/v1/contexts/${id}`, 'owner'), 200);
  status(await call('GET', `/v1/contexts/${id}`), 404);
  status(await call('POST', `/v1/contexts/${id}:restore`, 'owner', {}), 200);
  expect((await call('GET', `/v1/contexts/${id}`)).body.context.id).toBe(id);
  // Neither the seeded authority nor a communal subject becomes creator-private data.
  status(await call('DELETE', `/v1/contexts/${GLOBAL_CONTEXT}`, 'owner'), 403);
});

test('semantic takedown withholds only covered fields and retains reversible data', async () => {
  const record = await proposal(await person('Unaffected label'));
  await accept(record);
  await adopt(record, null);
  status(
    await call('POST', `${path(record)}:takedown`, 'platform', {
      notice: { complaint: 'Only the URL value', received_at: clock().toISOString(), scope: '/value' },
    }),
    200,
  );
  const shown = JSON.stringify(await current(record.subject));
  expect(shown).toContain('Unaffected label');
  expect(shown).not.toContain(record.payload);
  const listed = await call('GET', `/v1/subjects/${record.subject}/candidates?property=schema%3Aurl`, 'owner');
  status(listed, 200);
  expect(listed.body.candidates).toContainEqual(expect.objectContaining({ id: record.candidate }));
  expect(JSON.stringify(listed.body)).toContain('https://example.test/evidence');
  now = new Date(clock().getTime() + 60 * day);
  await drain(record.subject);
  expect(
    (await admin.query('SELECT statement FROM semantic.candidate WHERE candidate_id=$1', [record.candidate])).rows[0]
      .statement.value.content,
  ).toBe(record.payload);
  status(await call('POST', `${path(record)}:restore`, 'platform', { reason: 'Counter-notice accepted' }), 200);
  expect(JSON.stringify(await current(record.subject))).toContain(record.payload);
});

test('semantic purge removes minimum personal payload in bounded durable pages while retaining nonpersonal skeleton', async () => {
  const record = await proposal(await person());
  await accept(record);
  await adopt(record, null);
  const before = await revisions(record.subject);
  status(await call('DELETE', path(record), 'owner'), 200);
  now = new Date(clock().getTime() + 30 * day);
  const job = retention();
  const key = randomUUID();
  const input = { partition: partitionOf(routeOf(record.subject)!), limit: 2, key };
  const committed = await job.step(input);
  expect(committed.examined).toBeLessThanOrEqual(2);
  // A new adapter instance represents restart after commit but before acknowledgement.
  expect(await retention().step(input)).toEqual(committed);
  await drain(record.subject);
  await absentPayload(record.payload);
  expect((await revisions(record.subject)).slice(0, before.length)).toEqual(before);
  const skeleton = await call('GET', `/v1/subjects/${record.subject}/candidates?property=schema%3Aurl`, 'owner');
  status(skeleton, 200);
  expect(skeleton.body.candidates).toContainEqual(expect.objectContaining({ id: record.candidate, deleted: true }));
  expect((await current(record.subject)).type).toBe('schema:Person');
});

test('early purge is separate platform authority and a legal hold suspends automatic purge', async () => {
  const record = await proposal(await person());
  status(await call('DELETE', path(record), 'owner'), 200);
  status(await call('POST', `${path(record)}:purge`, 'owner', { reason: 'early' }), 403);
  status(await call('POST', `${path(record)}:hold`, 'platform', { held: true, reason: 'Preserve evidence' }), 200);
  now = new Date(clock().getTime() + 31 * day);
  await drain(record.subject);
  expect(
    (await admin.query('SELECT statement FROM semantic.candidate WHERE candidate_id=$1', [record.candidate])).rows[0]
      .statement.value.content,
  ).toBe(record.payload);
  status(await call('POST', `${path(record)}:hold`, 'platform', { held: false, reason: 'Released' }), 200);
  await drain(record.subject);
  await absentPayload(record.payload);
  const earlyPrivacy = await proposal(await person());
  status(await call('DELETE', path(earlyPrivacy), 'owner'), 200);
  status(await call('POST', `${path(earlyPrivacy)}:purge`, 'platform', { reason: 'early' }), 200);
  await drain(earlyPrivacy.subject);
  await absentPayload(earlyPrivacy.payload);
  const early = await proposal(await person());
  status(
    await call('POST', `${path(early)}:purge`, 'platform', { reason: 'legal_order', order: 'order-reference' }),
    200,
  );
  await drain(early.subject);
  await absentPayload(early.payload);
});

test('paused consumers do not disclose a revoked source in inverse links or publicly live counts', async () => {
  const target = await person('Foreign target');
  const created = await call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Book',
    labels: { en: 'Revocable source' },
    statements: { 'schema:author': [cited('schema:author', target)] },
  });
  status(created, 201);
  const subject = created.body.subject.id;
  await caughtUp(subject);
  const inverse = () => call('GET', `/v1/subjects/${target}/links?property=schema%3Aauthor`);
  expect((await inverse()).body.count).toEqual({ value: 1, exact: true });
  status(
    await call('POST', `/v1/subjects/${subject}:takedown`, 'platform', {
      notice: { complaint: 'Whole source', received_at: clock().toISOString() },
    }),
    200,
  );
  // No projection.run or relay runs after the authoritative revocation.
  const withheld = await inverse();
  status(withheld, 200);
  expect(withheld.body.links).toEqual([]);
  expect(withheld.body.count, JSON.stringify(withheld.body)).toEqual({ value: 0, exact: true });
});

test('deleted community Context cannot disclose its adopted overlay while consumers pause', async () => {
  const record = await proposal(await person());
  const created = await call('POST', '/v1/contexts', 'owner', { labels: { en: 'Overlay lifecycle' } });
  status(created, 201);
  const context = created.body.context.id;
  status(await call('POST', `${path(record)}:accept`, 'owner', { context, expected_head: null }), 200);
  status(
    await call('POST', `/v1/subjects/${record.subject}:adopt`, 'owner', {
      context,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate: record.candidate, rank: 'normal' }],
      expected_head: null,
    }),
    200,
  );
  const read = () => call('GET', `/v1/subjects/${record.subject}?context=${context}`, 'owner');
  expect(JSON.stringify((await read()).body)).toContain(record.payload);
  status(await call('DELETE', `/v1/contexts/${context}`, 'owner'), 200);
  const withheld = await read();
  status(withheld, 404);
  expect(JSON.stringify(withheld.body)).not.toContain(record.payload);
  status(await call('POST', `/v1/contexts/${context}:restore`, 'owner', {}), 200);
  expect(JSON.stringify((await read()).body)).toContain(record.payload);
});

test('account erasure de-identifies retained public contributions and automatically purges private assertions', async () => {
  const record = await proposal(await person());
  await accept(record);
  await adopt(record, null);
  const privateName = `Private account name ${randomUUID()}`;
  await semantic.ensureAccountAgent(pool, { account: accounts.owner, kind: 'person', name: privateName });
  const agent = semantic.accountAgentId(accounts.owner);
  const holder = await person('Private assertion holder');
  const proposed = await call('POST', `/v1/subjects/${holder}/candidates`, 'owner', {
    statement: snak('rezics:penNameOf', agent),
  });
  status(proposed, 201);
  const privateCandidate = proposed.body.candidate;
  const access = real.access({ actions: LIFECYCLE_ACTIONS });
  await real.grant({ route: routeOf(accounts.owner)!, id: accounts.owner }, 'owner', 'account:delete');
  const actor = await access.authenticate(real.bearer('owner'), { pool, deadline: Date.now() + 5000 });
  const commands = createLifecycleCommands({ pool, access, clock });
  await commands.tombstone({ actor, deadline: Date.now() + 5000 }, { accountId: accounts.owner, key: randomUUID() });
  now = new Date(clock().getTime() + 30 * day);
  // Source and account partitions progress independently through native durable work.
  for (const subject of [accounts.owner, holder, record.subject]) await drain(subject);
  await absentPayload(privateName);
  const retained = await call('GET', `/v1/subjects/${record.subject}/candidates?property=schema%3Aurl`);
  status(retained, 200);
  expect(JSON.stringify(retained.body)).toContain(record.payload);
  expect(JSON.stringify(retained.body)).not.toContain(privateName);
  const privateRow = await admin.query('SELECT statement FROM semantic.candidate WHERE candidate_id=$1', [
    privateCandidate,
  ]);
  expect(JSON.stringify(privateRow.rows)).not.toContain(agent);
  const identity = await call('GET', `/v1/subjects/${agent}`);
  expect(JSON.stringify(identity.body)).not.toContain(privateName);
});

test('explicit account-agent name clear is immediate and does not create record deletion', async () => {
  const account = accounts.stranger;
  const name = `Clear-only name ${randomUUID()}`;
  const agent = semantic.accountAgentId(account);
  await semantic.ensureAccountAgent(pool, { account, kind: 'person', name });
  const before = await revisions(agent);
  await semantic.ensureAccountAgent(pool, { account, kind: 'person', name: null });
  await absentPayload(name);
  expect((await revisions(agent)).slice(0, before.length)).toEqual(before);
  const cleared = await call('GET', `/v1/subjects/${agent}`);
  status(cleared, 200);
  expect(cleared.body.subject.labels).toEqual({});
  await semantic.ensureAccountAgent(pool, { account, kind: 'person', name: 'New explicit name' });
  const restored = await call('GET', `/v1/subjects/${agent}`);
  status(restored, 200);
  expect(restored.body.subject.labels).toEqual({ und: 'New explicit name' });
});

test('retention failure before receipt commit leaves payload intact and the same page can retry', async () => {
  // Use another real principal because account deletion above is terminal.
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  const created = await call('POST', '/v1/subjects', 'editor', {
    type: 'schema:Person',
    labels: { en: 'Crash fixture' },
  });
  status(created, 201);
  const subject = created.body.subject.id;
  const payload = `https://example.test/crash/${randomUUID()}`;
  const proposed = await call('POST', `/v1/subjects/${subject}/candidates`, 'editor', {
    statement: cited('schema:url', payload),
  });
  status(proposed, 201);
  const record = { subject, candidate: proposed.body.candidate };
  status(await call('DELETE', path(record), 'editor'), 200);
  now = new Date(clock().getTime() + 31 * day);
  const input = { partition: partitionOf(routeOf(subject)!), limit: 2, key: randomUUID() };
  // A native command failure after its writes must roll back payload and checkpoint together.
  await admin.query(`CREATE FUNCTION public.reject_semantic_retention_receipt() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'retention receipt fault'; END $$`);
  await admin.query(`CREATE TRIGGER reject_semantic_retention_receipt BEFORE INSERT ON core.receipt
    FOR EACH ROW EXECUTE FUNCTION public.reject_semantic_retention_receipt()`);
  try {
    await expect(retention().step(input)).rejects.toThrow('retention receipt fault');
    const row = await admin.query('SELECT statement FROM semantic.candidate WHERE candidate_id=$1', [record.candidate]);
    expect(JSON.stringify(row.rows)).toContain(payload);
  } finally {
    await admin.query('DROP TRIGGER reject_semantic_retention_receipt ON core.receipt');
    await admin.query('DROP FUNCTION public.reject_semantic_retention_receipt()');
  }
  await retention().step(input);
  await drain(subject);
  await absentPayload(payload);
});

test('account-agent erasure still clears personal names when its stored type leaves the current release', async () => {
  for (const action of ['definitions:publish', 'definitions:activate'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  const release = {
    ...bundledRelease,
    types: {
      ...bundledRelease.types,
      'schema:SoftwareApplication': {
        iri: 'http://schema.org/SoftwareApplication',
        labels: { en: 'Software application' },
        mappings: [],
        bases: ['schema:Thing'],
        properties: [],
        facets: [],
      },
    },
  };
  const published = await call('POST', '/v1/definitions/releases', 'editor', { release });
  status(published, 201);
  const digest = published.body.digest;
  status(await call('POST', `/v1/definitions/releases/${digest}:activate`, 'editor', { expected_head: 1 }), 200);
  const account = newId(21004);
  const name = `Retired type personal name ${randomUUID()}`;
  try {
    await semantic.ensureAccountAgent(pool, { account, kind: 'software', name });
  } finally {
    status(
      await call('POST', `/v1/definitions/releases/${bundledDigest}:activate`, 'editor', { expected_head: 2 }),
      200,
    );
  }
  const cleared = await semantic.ensureAccountAgent(pool, { account, kind: 'software', name: null });
  expect(cleared.subject.type).toBe('schema:SoftwareApplication');
  expect(cleared.subject.labels).toEqual({});
  await absentPayload(name);
});
