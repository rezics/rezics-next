import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg, { type PoolClient, type QueryConfig, type QueryResult } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent, unverifyAccountAgent, verifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createSubject, readItemTypes, updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { readItemIdentityVersion } from '../../src/semantic/item-identity.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'web',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
const release = { digest: bundledDigest, release: bundledRelease };

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

async function person(label: string, route = 34112): Promise<string> {
  const id = newId(route);
  const created = await createSubject(pool, {
    actor,
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: new Uint8Array(32),
    item: { type: 'schema:Person', labels: { en: label } },
    release,
    authorize: async () => true,
    deadline: Date.now() + 60_000,
  });
  return created.subject.id;
}

function withTestDeadline<T>(run: () => Promise<T>): Promise<T> {
  return withRequestDeadline(Date.now() + 60_000, run);
}

async function identityRevision(id: string) {
  const { rows } = await admin.query(
    `SELECT revision, recorded_transaction_id::text AS transaction_id
     FROM semantic.revision
     WHERE route = $1 AND subject_id = $2::uuid AND kind = 'identity'
     ORDER BY revision DESC LIMIT 1`,
    [routeOf(id), id],
  );
  return rows[0] as { revision: number; transaction_id: string } | undefined;
}

test('item identity version uses the caller RR snapshot without transferring type text', async () => {
  const id = await person('Snapshot subject');
  const old = await pool.connect();
  let committed = false;
  try {
    await old.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(await readPartition(old, partitionOf(routeOf(id)!))).not.toBeNull();
    const oldTypes = await readItemTypes(old, [id]);
    const observedOld = observe(old);
    const oldVersion = await readItemIdentityVersion(observedOld.client, id);
    expect(oldTypes.get(id)).toBe('schema:Person');
    expect(oldVersion).toMatchObject({ revision: 1, redirect: null });
    const metadataCall = observedOld.calls.find((call) => call.text.includes('FROM semantic.subject AS subject'));
    expect(metadataCall?.columns).toEqual(['revision', 'transactionId', 'redirect']);
    expect(metadataCall?.text).not.toMatch(/\btype\b/i);

    await updateSubjectIdentity(pool, {
      subject: id,
      type: 'schema:Organization',
      release,
      authorize: async () => true,
      deadline: Date.now() + 60_000,
    });

    expect(await readItemTypes(old, [id])).toEqual(oldTypes);
    expect(await readItemIdentityVersion(observedOld.client, id)).toEqual(oldVersion);
    expect(observedOld.calls.filter((call) => call.text.includes('FROM semantic.subject AS subject'))).toHaveLength(2);
    await old.query('COMMIT');

    const fresh = await pool.connect();
    try {
      await fresh.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const freshTypes = await readItemTypes(fresh, [id]);
      const freshVersion = await readItemIdentityVersion(fresh, id);
      expect(freshTypes.get(id)).toBe('schema:Organization');
      expect(freshVersion).toMatchObject({ revision: 2, redirect: null });
      const identity = await identityRevision(id);
      expect(freshVersion?.transactionId).toBe(identity?.transaction_id);
      await fresh.query('COMMIT');
    } finally {
      fresh.release();
    }
    committed = true;
  } finally {
    if (!committed) await old.query('ROLLBACK').catch(() => undefined);
    old.release();
  }

  const hidden = await person('Hidden subject');
  const takenDown = await person('Taken down subject');
  await admin.query("UPDATE semantic.subject SET visibility = 'hidden' WHERE route = $1 AND subject_id = $2::uuid", [
    routeOf(hidden),
    hidden,
  ]);
  await admin.query(
    "UPDATE semantic.subject SET visibility = 'taken_down' WHERE route = $1 AND subject_id = $2::uuid",
    [routeOf(takenDown), takenDown],
  );
  expect(await readItemIdentityVersion(pool, newId(34128))).toBeNull();
  expect(await readItemIdentityVersion(pool, hidden)).toBeNull();
  expect(await readItemIdentityVersion(pool, takenDown)).toBeNull();
  let queried = false;
  const invalidClient = {
    query: (async () => {
      queried = true;
      throw new Error('Invalid ids must not reach SQL');
    }) as PoolClient['query'],
  };
  expect(await readItemIdentityVersion(invalidClient, 'invalid')).toBeNull();
  expect(queried).toBe(false);
});

test('identity changes and one-hop redirects are revalidated independently', async () => {
  const account = newId(34144);
  const agentId = accountAgentId(account);
  await withTestDeadline(() =>
    ensureAccountAgent(pool, { account, kind: 'person', name: 'Agent before sync', language: 'en' }),
  );
  const createdVersion = await readItemIdentityVersion(pool, agentId);
  expect(createdVersion).toMatchObject({ revision: 1, redirect: null });

  await withTestDeadline(() =>
    ensureAccountAgent(pool, { account, kind: 'person', name: 'Agent after sync', language: 'en' }),
  );
  const syncedVersion = await readItemIdentityVersion(pool, agentId);
  expect(syncedVersion).toMatchObject({ revision: 2, redirect: null });
  expect(syncedVersion?.transactionId).toBe((await identityRevision(agentId))?.transaction_id);

  const subject = await person('Editorial tail subject', 34160);
  await updateSubjectIdentity(pool, {
    subject,
    type: 'schema:Organization',
    release,
    authorize: async () => true,
    deadline: Date.now() + 60_000,
  });
  const identity = await readItemIdentityVersion(pool, subject);
  const editorialTail = randomUUID();
  await admin.query(
    `INSERT INTO semantic.revision(route, subject_id, revision, kind, release, recorded_transaction_id)
     SELECT $1, $2::uuid, revision, CASE revision % 3 WHEN 0 THEN 'propose' WHEN 1 THEN 'accept' ELSE 'adopt' END,
            $3, $4::uuid
     FROM generate_series(3, 90) AS versions(revision)`,
    [routeOf(subject), subject, bundledDigest, editorialTail],
  );
  const latestOverall = await admin.query(
    'SELECT max(revision)::int AS revision FROM semantic.revision WHERE route = $1 AND subject_id = $2::uuid',
    [routeOf(subject), subject],
  );
  expect(latestOverall.rows[0].revision).toBe(90);
  expect(await readItemIdentityVersion(pool, subject)).toEqual(identity);

  const [source, middle, final] = await Promise.all([
    person('Redirect source', 34176),
    person('Redirect middle', 34192),
    person('Redirect final', 34208),
  ]);
  const sourceVersion = await readItemIdentityVersion(pool, source);
  const transactionId = randomUUID();
  await admin.query(
    `INSERT INTO semantic.redirect(route, subject_id, sequence, target, recorded_transaction_id)
     VALUES ($1, $2::uuid, 1, $3::uuid, $5::uuid), ($4, $3::uuid, 1, $6::uuid, $5::uuid)`,
    [routeOf(source), source, middle, routeOf(middle), transactionId, final],
  );
  expect(await readItemIdentityVersion(pool, source)).toEqual({
    ...sourceVersion!,
    redirect: middle,
  });
  expect((await readItemIdentityVersion(pool, middle))?.redirect).toBe(final);
  expect((await readItemIdentityVersion(pool, source))?.transactionId).toBe(sourceVersion?.transactionId);

  const catalog = await person('Catalogue agent', 34224);
  const verificationAccount = newId(34240);
  const verificationAgent = accountAgentId(verificationAccount);
  await withTestDeadline(() =>
    ensureAccountAgent(pool, {
      account: verificationAccount,
      kind: 'person',
      name: 'Private agent',
      language: 'en',
    }),
  );
  const beforeVerification = await readItemIdentityVersion(pool, verificationAgent);
  await withTestDeadline(() =>
    verifyAccountAgent(pool, { account: verificationAccount, catalogue: catalog, receipt: randomUUID() }),
  );
  const merged = await readItemIdentityVersion(pool, verificationAgent);
  expect(merged).toEqual({ ...beforeVerification!, redirect: catalog });
  await withTestDeadline(() => unverifyAccountAgent(pool, { account: verificationAccount, receipt: randomUUID() }));
  const reversed = await readItemIdentityVersion(pool, verificationAgent);
  expect(reversed).toEqual(beforeVerification);
});

type ObservedQuery = {
  text: string;
  values: unknown[] | undefined;
  columns: string[];
  rows: Record<string, unknown>[];
  protocolBytes: number;
};

function protocolBytes(result: QueryResult<Record<string, unknown>>): number {
  const rowDescription = 7 + result.fields.reduce((bytes, field) => bytes + 19 + Buffer.byteLength(field.name), 0);
  const dataRows = result.rows.reduce(
    (bytes, row) =>
      bytes +
      7 +
      result.fields.reduce((columns, field) => {
        const value = row[field.name];
        return columns + 4 + (value === null ? 0 : Buffer.byteLength(String(value)));
      }, 0),
    0,
  );
  return 30 + rowDescription + dataRows;
}

function observe(client: PoolClient): { client: Pick<PoolClient, 'query'>; calls: ObservedQuery[] } {
  const calls: ObservedQuery[] = [];
  const query = (async (query: string | QueryConfig, values?: unknown[]) => {
    const text = typeof query === 'string' ? query : query.text;
    const parameters = typeof query === 'string' ? values : query.values;
    const result = (await (typeof query === 'string'
      ? client.query(query, values as unknown[])
      : client.query(query))) as QueryResult<Record<string, unknown>>;
    calls.push({
      text,
      values: parameters,
      columns: result.fields.map((field) => field.name),
      rows: result.rows,
      protocolBytes: protocolBytes(result),
    });
    return result;
  }) as PoolClient['query'];
  return { client: { query }, calls };
}

async function longTypeSubject(type: string, route: number): Promise<string> {
  const id = newId(route);
  await admin.query(
    `INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id, current_release)
     VALUES ($1, $2::uuid, $3, $2::uuid, $4)`,
    [route, id, type, bundledDigest],
  );
  await admin.query(
    `INSERT INTO semantic.revision(route, subject_id, revision, kind, release, recorded_transaction_id)
     VALUES ($1, $2::uuid, 1, 'create', $3, $2::uuid)`,
    [route, id, bundledDigest],
  );
  return id;
}

test('a long visible type does not change the metadata query or result bytes', async () => {
  const short = `schema:T${'x'.repeat(300)}`;
  const long = `schema:T${'x'.repeat(1400)}`;
  const shortId = await longTypeSubject(short, 34256);
  const longId = await longTypeSubject(long, 34256);
  const client = await pool.connect();
  try {
    expect((await readItemTypes(client, [shortId])).get(shortId)).toBe(short);
    expect((await readItemTypes(client, [longId])).get(longId)).toBe(long);
    const shortObservation = observe(client);
    for (let index = 0; index < 6; index++) await readItemIdentityVersion(shortObservation.client, shortId);
    const longObservation = observe(client);
    for (let index = 0; index < 6; index++) await readItemIdentityVersion(longObservation.client, longId);

    for (const observation of [shortObservation, longObservation]) {
      expect(observation.calls).toHaveLength(6);
      expect(new Set(observation.calls.map((call) => call.text)).size).toBe(1);
      expect(new Set(observation.calls.map((call) => call.protocolBytes)).size).toBe(1);
      expect(observation.calls.every((call) => call.protocolBytes < 256)).toBe(true);
      for (const call of observation.calls) {
        expect(call.columns).toEqual(['revision', 'transactionId', 'redirect']);
        expect(call.text).not.toMatch(/\btype\b/i);
        expect(JSON.stringify(call.rows)).not.toContain(short);
        expect(JSON.stringify(call.rows)).not.toContain(long);
        expect(JSON.stringify(call.values)).not.toContain(short);
        expect(JSON.stringify(call.values)).not.toContain(long);
      }
    }
    expect(shortObservation.calls[0]!.protocolBytes).toBe(longObservation.calls[0]!.protocolBytes);
    expect(shortObservation.calls[0]!.protocolBytes).toBe(179);
  } finally {
    client.release();
  }
});
