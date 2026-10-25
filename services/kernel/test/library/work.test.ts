import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import type { Collection, CollectionVisibility } from '../../src/library/collection-model.ts';
import { syncSubjectListing } from '../../src/library/listing.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { capture, openGrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const db = await openGrowthDatabase(url);
const pool = db.openPool({ max: 10 });
const client = await createWorkClient(url);
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'library', alg: 'ES256' };
const scopes = ['collection:create', 'collection:read', 'collection:update', 'collection:delete', 'subject:read'];
const access = createAccess({
  actions: new Map(scopes.map((action) => [action, { anonymous: action === 'subject:read' }])),
  auth: {
    issuer: 'https://auth.example.test',
    audience: 'https://api.rezics.test',
    jwksUrl: 'https://auth.example.test/jwks',
    fetch: async () => Response.json({ keys: [jwk] }),
  },
});
const commands = createCollectionCommands({ pool: db.pool, access });
let actor: AccountActor;
let token: string;
let worker: Awaited<ReturnType<typeof composeWork>>;

beforeAll(async () => {
  const accountId = newId(0x6a31);
  await db.admin.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     VALUES ($1, $2, 'actor', 'active', $2, false, 1, true)`,
    [routeOf(accountId), accountId],
  );
  token = await new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'library', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  actor = await access.authenticate(token, { pool: db.pool, deadline: Date.now() + 5000 });
  await bootstrapRelease(db.pool, bundledRelease);
  worker = await composeWork([libraryWorkModule], { databaseUrl: url, pool, client, env: {} });
  await worker.launch();
});

afterAll(async () => {
  await worker?.shutdown();
  await client.close();
  await db.close();
});

async function subject() {
  actor = await owner();
  const key = randomUUID();
  return (
    await createSubject(db.pool, {
      actor,
      target: subjectTarget(new Uint8Array(32).fill(106), actor.accountId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: 'Listing subject' } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
}

async function collection(visibility: CollectionVisibility = 'public') {
  return (await commands.createCollection(await owner(), { title: 'Listing Collection', visibility }, randomUUID()))
    .value;
}

async function add(collectionId: string, subjectId: string) {
  return (await commands.addMember(await owner(), collectionId, { subjectId }, randomUUID())).value;
}

async function flip(row: Collection, visibility: CollectionVisibility) {
  return (await commands.updateCollection(await owner(), row.id, { revision: row.revision, visibility }, randomUUID()))
    .value;
}

async function owner() {
  return access.authenticate(token, { pool: db.pool, deadline: Date.now() + 5000 });
}

async function event(collectionId: string, memberId?: string): Promise<CloudEvent> {
  const type: CloudEvent['type'] = memberId
    ? 'com.rezics.library.collection.member.changed.v1'
    : 'com.rezics.library.collection.listing.changed.v1';
  const row = (
    await db.admin.query(
      `SELECT * FROM core.outbox WHERE subject=$1 AND type=$2
       AND ($3::text IS NULL OR data->>'memberId'=$3) ORDER BY position DESC LIMIT 1`,
      [collectionId, type, memberId ?? null],
    )
  ).rows[0]!;
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type,
    subject: collectionId,
    time: row.recorded_at.toISOString(),
    sequence: String(row.position).padStart(19, '0'),
    datacontenttype: 'application/json',
    data: row.data,
  };
}

async function run(notification: CloudEvent) {
  const name = notification.type.includes('.member.') ? 'library_member_listing' : 'library_collection_listing';
  const handle = await client.enqueue(
    {
      workflowName: 'effect',
      queueName: 'effects',
      queuePartitionKey: String(routeOf(notification.subject!)! >>> 4),
      workflowID: randomUUID(),
    },
    name,
    notification,
  );
  await handle.getResult({ pollingIntervalMs: 10 });
  if (name === 'library_collection_listing') {
    const workflow = await client.getWorkflow(notification.id);
    expect(workflow).toMatchObject({ workflowName: 'library.collectionListing', queueName: 'workflows' });
    await client.retrieveWorkflow(notification.id).getResult({ pollingIntervalMs: 10 });
  }
}

async function state(subjectId: string) {
  const values = [routeOf(subjectId), subjectId];
  return {
    pairs: (
      await db.admin.query(
        'SELECT * FROM library.subject_collection WHERE route=$1 AND subject_id=$2 ORDER BY collection_id',
        values,
      )
    ).rows,
    listing: (await db.admin.query('SELECT * FROM library.subject_listing WHERE route=$1 AND subject_id=$2', values))
      .rows,
    events: (
      await db.admin.query('SELECT * FROM core.outbox WHERE subject=$1 ORDER BY position, event_seq', [subjectId])
    ).rows,
    receipts: (
      await db.admin.query('SELECT * FROM core.receipt WHERE actor_account_id=$1 ORDER BY idempotency_key', [subjectId])
    ).rows,
  };
}

async function listed(subjectId: string, collectionId: string, multiplicity: number) {
  const saved = await state(subjectId);
  expect(saved.pairs).toHaveLength(multiplicity ? 1 : 0);
  if (multiplicity)
    expect(saved.pairs[0]).toMatchObject({ route: routeOf(subjectId), collection_id: collectionId, multiplicity });
  expect(saved.listing[0]?.public_collection_count ?? 0).toBe(multiplicity ? 1 : 0);
  return saved;
}

test('member effects project duplicate membership once and remove each member from current truth', async () => {
  const s = await subject();
  const c = await collection();
  const first = await add(c.id, s);
  const second = await add(c.id, s);
  const old = await event(c.id, first.id);
  await run(await event(c.id, second.id));
  const original = await listed(s, c.id, 2);
  await run(old);
  expect(await state(s)).toEqual(original);
  await commands.removeMember(await owner(), c.id, first.id, randomUUID());
  await run(await event(c.id, first.id));
  await listed(s, c.id, 1);
  await commands.removeMember(await owner(), c.id, second.id, randomUUID());
  await run(await event(c.id, second.id));
  const final = await listed(s, c.id, 0);
  await run(old);
  expect(await state(s)).toEqual(final);
});

test('listing workflows hide and restore every distinct subject, and deleted member rows still remove listings', async () => {
  const subjects = [await subject(), await subject()];
  let c = await collection();
  for (const s of subjects) await add(c.id, s);
  await add(c.id, subjects[0]!);
  const old = await event(c.id);
  await run(old);
  for (const s of subjects) await listed(s, c.id, s === subjects[0] ? 2 : 1);
  c = await flip(c, 'private');
  await run(await event(c.id));
  for (const s of subjects) await listed(s, c.id, 0);
  // Older notifications must reread private truth, never disclose their old public state.
  const privateState = await Promise.all(subjects.map(state));
  await run({ ...old, id: randomUUID() });
  expect(await Promise.all(subjects.map(state))).toEqual(privateState);
  c = await flip(c, 'public');
  await run(await event(c.id));
  for (const s of subjects) await listed(s, c.id, s === subjects[0] ? 2 : 1);
  await commands.deleteCollection(await owner(), c.id, c.revision, randomUUID());
  const deleted = await event(c.id);
  await run(deleted);
  for (const s of subjects) await listed(s, c.id, 0);
  const final = await Promise.all(subjects.map(state));
  await run(deleted);
  // A second execution with a new durable identity must also be a no-op.
  await run({ ...deleted, id: randomUUID() });
  expect(await Promise.all(subjects.map(state))).toEqual(final);
});

test('private and unlisted membership never writes a subject pair or commits a projection', async () => {
  for (const visibility of ['private', 'unlisted'] as const) {
    const s = await subject();
    const c = await collection(visibility);
    const member = await add(c.id, s);
    const before = await state(s);
    await run(await event(c.id, member.id));
    expect(await state(s)).toEqual(before);
  }
});

test('a Collection with 101 distinct subjects is synced in durable keyset steps of 100', async () => {
  const c = await collection();
  const subjects: string[] = [];
  for (let i = 0; i < 101; i++) {
    const s = await subject();
    subjects.push(s);
    await add(c.id, s);
  }
  await add(c.id, subjects[0]!);
  const notification = await event(c.id);
  await run(notification);
  const steps = await client.listWorkflowSteps(notification.id);
  expect(steps?.filter((step) => step.name === 'library.syncCollectionPage')).toHaveLength(2);
  for (const s of subjects) await listed(s, c.id, s === subjects[0] ? 2 : 1);
});

test('member and listing statement costs depend only on this Collection at three unrelated scales', async () => {
  const memberCosts: number[] = [];
  const listingCosts: number[][] = [[], []];
  let previous = 0;
  const measure = async (notification: CloudEvent) => {
    const measured = await capture(db, () => run(notification));
    const statements = measured.capture.statements.filter((sql) => /\blibrary\./.test(sql));
    expect(statements.some((sql) => /library\.(entry|session|copy|follow)/.test(sql))).toBe(false);
    return statements.length;
  };
  for (const scale of [1, 8, 64]) {
    for (let i = previous; i < scale; i++) {
      const c = await collection();
      const s = await subject();
      await add(c.id, s);
      await syncSubjectListing({ pool: db.pool }, { subjectId: s, collectionId: c.id });
    }
    previous = scale;
    const c = await collection();
    const s = await subject();
    const m = await add(c.id, s);
    memberCosts.push(await measure(await event(c.id, m.id)));
    for (const [index, size] of [1, 4].entries()) {
      const target = await collection();
      for (let i = 0; i < size; i++) await add(target.id, await subject());
      listingCosts[index]!.push(await measure(await event(target.id)));
    }
  }
  expect(memberCosts).toEqual([2, 2, 2]);
  expect(listingCosts).toEqual([
    [3, 3, 3],
    [9, 9, 9],
  ]);
});
