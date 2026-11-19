import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { ACCESS_EVIDENCE_TTL_MS } from '../../src/access/evidence-deadline.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { captureWithFoldedCost, openGrowthDatabase } from '../support/growth.ts';
import '../support/native-history-composition.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { fullView } from '../../src/library/views.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accessCommandAuthorization, actorOf, type AccountActor } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { encodeSession } from '../../src/tokens/session.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';
import { observeSql, type SqlObserver } from '../content/support/sql-observer.ts';
import readLinkCheckpoint from '../../src/semantic/read-link-checkpoint.sql';
import readPendingMember from '../../src/semantic/links-read-pending-member.sql';
import readPartitionBatch from '../../src/partition/read-batch.sql';
import readSubjectIdentity from '../../src/semantic/read-subject-identity.sql';
import readSubjectReference from '../../src/semantic/read-subject-reference.sql';
import readSubjectStatement from '../../src/semantic/read-subject.sql';
import readSummaries from '../../src/semantic/summaries-read.sql';
import readPermissionTime from '../../src/access/permission-time.sql';

const checkpointSql = readLinkCheckpoint['~standard'].query.text;
const pendingMemberSql = readPendingMember['~standard'].query.text;
const identitySql = readSubjectIdentity['~standard'].query.text;
const subjectSql = readSubjectStatement['~standard'].query.text;
const permissionTimeSql = readPermissionTime['~standard'].query.text;
const partitionBatchSql = readPartitionBatch['~standard'].query.text;
const referenceSql = readSubjectReference['~standard'].query.text;
const summarySql = readSummaries['~standard'].query.text;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const projection = linkProjection(pool);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) };
const routeKey = new Uint8Array(32).fill(43);
const actions = ['subject:create', 'subject:read', 'subject:merge', 'statement:propose', 'moderation:hide'] as const;
const accounts = {
  writer: newId(randomInt(65_536)),
  reader: newId(randomInt(65_536)),
  moderator: newId(randomInt(65_536)),
};
const realAccess = await createRealAccess(admin, accounts, actions);
const libraryAccess = realAccess.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey,
  receiptKeys: testReceiptKeys(),
  writeRate: realAccess.writeRate,
});
const globalSubjectResource = { route: 0, id: GLOBAL_CONTEXT };

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant(globalSubjectResource, 'writer', 'subject:create');
  await realAccess.grant(globalSubjectResource, 'writer', 'subject:merge');
  await realAccess.grant(globalSubjectResource, 'writer', 'statement:propose');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function libraryActor(persona: keyof typeof accounts, authPool: typeof pool = pool): Promise<AccountActor> {
  return (await actorOf(
    libraryAccess,
    new Request('https://kernel.test', { headers: { authorization: `Bearer ${realAccess.bearer(persona)}` } }),
    { pool: authPool, deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS },
  )) as AccountActor;
}

async function admittedWriter(action: 'subject:create' | 'subject:merge') {
  const actor = await libraryActor('writer');
  const deadline = Date.now() + 20_000;
  const authorization = await accessCommandAuthorization(
    libraryAccess,
    actor,
    action,
    globalSubjectResource,
    { pool, deadline },
    () => new Error(`Denied native fixture ${action}`),
  );
  return { actor, deadline, authorization };
}

function digest(value: string): Uint8Array {
  return createHash('sha256').update(value).digest();
}

function freshPartition(): number {
  return randomInt(1_000, 4_000);
}

async function createFixed(partition: number, type: string, label: string, statements?: Record<string, unknown>) {
  const route = partition * 16;
  const id = newId(route);
  const result = await createSubject(pool, {
    ...(await admittedWriter('subject:create')),
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: digest(id),
    item: { type, labels: { en: label }, ...(statements ? { statements } : {}) },
    release: { digest: bundledDigest, release: bundledRelease },
  });
  return { id, route, component: result.component };
}

async function createProjected(partition: number, label: string) {
  const target = await createFixed(partition, 'schema:Person', `${label} target`);
  return createFixed(partition, 'schema:Book', label, {
    'schema:author': [
      {
        property: { id: 'schema:author' },
        value: { type: 'value', content: target.id },
        qualifiers: [],
        references: [],
      },
    ],
  });
}

async function mergePair(partition: number) {
  const first = await createFixed(partition, 'schema:Person', 'Merge candidate one');
  const second = await createFixed(partition, 'schema:Person', 'Merge candidate two');
  const [survivor, merged] = [first.id, second.id].sort() as [string, string];
  const result = await mergeSubjects(pool, {
    subjects: [first.id, second.id],
    survivor,
    ...(await admittedWriter('subject:merge')),
    idempotencyKey: randomUUID(),
    digest: digest(`${survivor}:${merged}`),
    release: { digest: bundledDigest, release: bundledRelease },
  });
  expect(result).toMatchObject({ survivor, redirected: merged });
  return { survivor, merged, component: result.component };
}

async function hide(id: string) {
  const response = await call('POST', `/v1/subjects/${id}:hide`, {
    token: 'moderator',
    key: `"${randomUUID()}"`,
    body: { reason: 'Hidden for the read resolution test.' },
  });
  expect(response.response.status).toBe(200);
}

async function leaveProjectionBehind(partition: number): Promise<void> {
  await admin.query("DELETE FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer='semantic_links'", [
    partition,
  ]);
  const state = await admin.query<{ position: string }>(
    'SELECT position::text AS position FROM core.partition WHERE partition_no=$1',
    [partition],
  );
  expect(state.rows).toHaveLength(1);
  expect(BigInt(state.rows[0]!.position)).toBeGreaterThan(0n);
  const checkpoint = await admin.query(
    "SELECT 1 FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer='semantic_links'",
    [partition],
  );
  expect(checkpoint.rows).toHaveLength(0);
}

async function catchUpLinks(partition: number): Promise<void> {
  for (let step = 0; step < 200; step++) {
    const result = await projection.run(partition);
    if (result.status === 'busy') {
      await Bun.sleep(5);
      continue;
    }
    if (result.envelopes === 0) return;
  }
  throw new Error(`Semantic link projection did not catch up for partition ${partition}`);
}

async function call(
  method: string,
  path: string,
  options: { token?: keyof typeof accounts; key?: string; ifMatch?: string; body?: unknown; session?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${realAccess.bearer(options.token)}`;
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
  if (options.session) headers[SESSION_HEADER] = options.session;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

function projectionWaitReads(observer: SqlObserver, from = 0) {
  return observer.records
    .slice(from)
    .filter(({ statement }) => /core\.consumer_checkpoint|semantic\.merge_member|projection_pending/i.test(statement));
}

function assertEarlyAnswerRead(observer: SqlObserver, id: string, from: number) {
  const records = observer.records.slice(from);
  expect(records.some(({ statement, parameters }) => statement === identitySql && parameters.includes(id))).toBe(true);
  expect(projectionWaitReads(observer, from)).toHaveLength(0);
}

async function readDuringStaleProjection(
  observer: SqlObserver,
  id: string,
  component: { partition: number; epoch: number; position: bigint },
  whileWaiting: () => Promise<void>,
) {
  const barrier = observer.hold({ statement: checkpointSql }, 'after');
  const request = call('GET', `/v1/subjects/${id}`, {
    token: 'reader',
    session: encodeSession(tokens, `account:${accounts.reader}`, [component]),
  });
  try {
    await Promise.race([
      barrier.entered,
      request.then(({ response }) => {
        throw new Error(`Subject GET returned ${response.status} before reaching the projection checkpoint`);
      }),
    ]);
    await whileWaiting();
  } finally {
    barrier.release();
  }
  return request;
}

function accessExpiryWitness(preparedAt: string): number {
  // The native time query runs after Access starts its evidence lifetime.
  return Date.parse(preparedAt) + ACCESS_EVIDENCE_TTL_MS + 25;
}

test('missing and unreadable subject resolution do not wait for link projection', async () => {
  const partition = freshPartition();
  const hidden = await createFixed(partition, 'schema:Person', 'Hidden subject');
  const deniedSubject = await createFixed(partition, 'schema:Person', 'Unreadable subject');
  await hide(hidden.id);
  await realAccess.grant({ route: hidden.route, id: hidden.id }, 'reader', 'subject:read');
  await realAccess.grant({ route: deniedSubject.route, id: deniedSubject.id }, 'reader', 'subject:read');
  const denialTransaction = randomUUID();
  await admin.query(
    `INSERT INTO access.resource_denial
         (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
       VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
    [deniedSubject.route, deniedSubject.id, accounts.reader, denialTransaction],
  );
  await leaveProjectionBehind(partition);

  const observer = observeSql(pool);
  try {
    const missing = newId(hidden.route);
    const beforeMissing = observer.records.length;
    const absent = await call('GET', `/v1/subjects/${missing}`, { token: 'reader' });
    expect(absent.response.status).toBe(404);
    assertEarlyAnswerRead(observer, missing, beforeMissing);

    const beforeHidden = observer.records.length;
    const unreadable = await call('GET', `/v1/subjects/${hidden.id}`, { token: 'reader' });
    expect(unreadable.response.status).toBe(404);
    assertEarlyAnswerRead(observer, hidden.id, beforeHidden);

    const beforeDenied = observer.records.length;
    const denied = await call('GET', `/v1/subjects/${deniedSubject.id}`, { token: 'reader' });
    expect(denied.response.status).toBe(404);
    assertEarlyAnswerRead(observer, deniedSubject.id, beforeDenied);
  } finally {
    await admin.query('DELETE FROM access.resource_denial WHERE transaction_id=$1', [denialTransaction]);
    await observer.close();
  }
}, 60_000);

test('authorized subject redirects resolve before projection freshness', async () => {
  const partition = freshPartition();
  const { survivor, merged } = await mergePair(partition);
  await realAccess.grant({ route: routeOf(merged)!, id: merged }, 'reader', 'subject:read');

  const hiddenPair = await mergePair(partition);
  await hide(hiddenPair.merged);
  const unreadablePair = await mergePair(partition);
  await realAccess.grant(
    { route: routeOf(unreadablePair.merged)!, id: unreadablePair.merged },
    'reader',
    'subject:read',
  );
  const denialTransaction = randomUUID();
  await admin.query(
    `INSERT INTO access.resource_denial
         (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
       VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
    [routeOf(unreadablePair.merged), unreadablePair.merged, accounts.reader, denialTransaction],
  );
  await leaveProjectionBehind(partition);

  const observer = observeSql(pool);
  try {
    const beforeRedirect = observer.records.length;
    const redirect = await call('GET', `/v1/subjects/${merged}`, { token: 'reader' });
    expect(redirect.response.status).toBe(308);
    expect(redirect.response.headers.get('location')).toBe(`/v1/subjects/${survivor}`);
    expect(redirect.body.redirect).toEqual({ from: merged, to: survivor });
    assertEarlyAnswerRead(observer, merged, beforeRedirect);

    const beforeUnreadable = observer.records.length;
    const unreadable = await call('GET', `/v1/subjects/${hiddenPair.merged}`, { token: 'reader' });
    expect(unreadable.response.status).toBe(404);
    expect(unreadable.response.headers.get('location')).toBeNull();
    expect(unreadable.body).not.toHaveProperty('redirect');
    assertEarlyAnswerRead(observer, hiddenPair.merged, beforeUnreadable);

    const beforeDenied = observer.records.length;
    const denied = await call('GET', `/v1/subjects/${unreadablePair.merged}`, { token: 'reader' });
    expect(denied.response.status).toBe(404);
    expect(denied.response.headers.get('location')).toBeNull();
    expect(denied.body).not.toHaveProperty('redirect');
    assertEarlyAnswerRead(observer, unreadablePair.merged, beforeDenied);
  } finally {
    await admin.query('DELETE FROM access.resource_denial WHERE transaction_id=$1', [denialTransaction]);
    await observer.close();
  }
}, 60_000);

test('authorized Subject GET advances its causal homes while the native relay drains older work', async () => {
  await createFixed(1001, 'schema:Person', 'Older partition one');
  await createFixed(1002, 'schema:Person', 'Older partition two');
  const foreign = await createFixed(1003, 'schema:Person', 'Causal partition');
  const author = await createFixed(1004, 'schema:Person', 'Projected author');
  const live = await createFixed(1004, 'schema:Book', 'Prioritized subject', {
    'schema:author': [
      {
        property: { id: 'schema:author' },
        value: { type: 'value', content: author.id },
        qualifiers: [],
        references: [],
      },
    ],
  });
  await realAccess.grant({ route: author.route, id: author.id }, 'reader', 'subject:read');
  await realAccess.grant({ route: live.route, id: live.id }, 'reader', 'subject:read');
  const nativePool = createPool(databaseUrl);
  const relay = linkProjection(nativePool);
  const firstRun = Promise.withResolvers<void>();
  const releaseOldest = Promise.withResolvers<void>();
  const demandFound = Promise.withResolvers<void>();
  const dispatches: number[] = [];
  const worker = startRelays(
    nativePool,
    [
      {
        ...relay,
        async scanPriority(client) {
          const homes = await relay.scanPriority!(client);
          if (homes.some((home) => home.partition_no === 1003) && homes.some((home) => home.partition_no === 1004))
            demandFound.resolve();
          return homes;
        },
        async run(partition) {
          dispatches.push(partition);
          if (dispatches.length === 1) {
            firstRun.resolve();
            await releaseOldest.promise;
          }
          return relay.run(partition);
        },
      },
    ],
    { concurrency: 1 },
  );
  try {
    await firstRun.promise;
    const request = call('GET', `/v1/subjects/${live.id}`, {
      token: 'reader',
      session: encodeSession(tokens, `account:${accounts.reader}`, [foreign.component]),
    });
    await Promise.race([
      demandFound.promise,
      request.then(({ response }) => {
        throw new Error(`Subject GET returned ${response.status} before relay demand`);
      }),
    ]);
    releaseOldest.resolve();
    const { response, body } = await request;
    expect(response.status).toBe(200);
    expect(body.subject.statements['schema:author'][0].value.content).toBe(author.id);
    expect(dispatches[1]).toBe(1003);
    expect(dispatches[2]).not.toBe(1004);
    expect(dispatches[3]).toBe(1004);
  } finally {
    releaseOldest.resolve();
    await worker.stop();
    await nativePool.end();
  }
}, 10_000);

test('Subject GET sees the applied relation while the link checkpoint trails its own completion events', async () => {
  const partition = freshPartition();
  const author = await createFixed(partition, 'schema:Person', 'Projected author');
  await catchUpLinks(partition);
  const book = await createFixed(partition, 'schema:Book', 'Book with an author', {
    'schema:author': [
      {
        property: { id: 'schema:author' },
        value: { type: 'value', content: author.id },
        qualifiers: [],
        references: [],
      },
    ],
  });
  await realAccess.grant({ route: book.route, id: book.id }, 'reader', 'subject:read');
  await realAccess.grant({ route: author.route, id: author.id }, 'reader', 'subject:read');
  const read = (session?: string) =>
    call('GET', `/v1/subjects/${book.id}`, { token: 'reader', ...(session && { session }) });

  // The same positive checkpoint cannot stand in for unprojected inputs.
  expect((await read()).body.code).toBe('semantic_not_ready');
  expect(await projection.run(partition)).toMatchObject({ status: 'read', position: book.component.position });
  const {
    rows: [home],
  } = await admin.query<{ position: string }>('SELECT position::text FROM core.partition WHERE partition_no=$1', [
    partition,
  ]);
  const position = BigInt(home!.position);
  expect(position).toBeGreaterThan(book.component.position);
  const session = encodeSession(tokens, `account:${accounts.reader}`, [{ ...book.component, position }]);
  const current = await read(session);
  expect(current.response.status).toBe(200);
  expect(current.body.subject.statements['schema:author'][0].value.content).toBe(author.id);
  const foreign = await createFixed((partition + 1) % 4096, 'schema:Person', 'Pending foreign Subject');
  const pending = encodeSession(tokens, `account:${accounts.reader}`, [
    { ...book.component, position },
    foreign.component,
  ]);
  expect((await read(pending)).body.code).toBe('semantic_not_ready');
}, 60_000);

test('live subject construction preserves projection freshness and final authorization', async () => {
  const partition = freshPartition();
  const target = await createFixed(partition, 'schema:Person', 'Projected author');
  const live = await createFixed(partition, 'schema:Book', 'Live relation', {
    'schema:author': [
      {
        property: { id: 'schema:author' },
        value: { type: 'value', content: target.id },
        qualifiers: [],
        references: [],
      },
    ],
  });
  await realAccess.grant({ route: live.route, id: live.id }, 'reader', 'subject:read');
  await realAccess.grant({ route: target.route, id: target.id }, 'reader', 'subject:read');
  await leaveProjectionBehind(partition);

  const observer = observeSql(pool);
  try {
    const liveRequest = await readDuringStaleProjection(observer, live.id, live.component, async () => {
      await catchUpLinks(partition);
    });
    expect(liveRequest.response.status).toBe(200);
    expect(liveRequest.body.subject.statements['schema:author']).toHaveLength(1);
    expect(liveRequest.body.subject.statements['schema:author'][0].value.content).toBe(target.id);
    const liveWaits = projectionWaitReads(observer);
    expect(liveWaits.some(({ statement }) => statement === checkpointSql)).toBe(true);
    expect(liveWaits.some(({ statement }) => statement === pendingMemberSql)).toBe(true);
    expect(observer.records.some(({ statement }) => statement.includes('semantic.outbound_link'))).toBe(true);

    const deniedPartition = freshPartition();
    const permissionChanged = await createProjected(deniedPartition, 'Permission race');
    await realAccess.grant({ route: permissionChanged.route, id: permissionChanged.id }, 'reader', 'subject:read');
    await leaveProjectionBehind(deniedPartition);
    const revokeObserver = observeSql(pool);
    const denialTransaction = randomUUID();
    try {
      const denied = await readDuringStaleProjection(
        revokeObserver,
        permissionChanged.id,
        permissionChanged.component,
        async () => {
          await admin.query(
            `INSERT INTO access.resource_denial
                 (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
               VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
            [permissionChanged.route, permissionChanged.id, accounts.reader, denialTransaction],
          );
          await catchUpLinks(deniedPartition);
        },
      );
      expect(denied.response.status).toBe(404);
      expect(projectionWaitReads(revokeObserver).some(({ statement }) => statement === checkpointSql)).toBe(true);
    } finally {
      await admin.query('DELETE FROM access.resource_denial WHERE transaction_id=$1', [denialTransaction]);
      await revokeObserver.close();
    }

    const hiddenPartition = freshPartition();
    const visibilityChanged = await createProjected(hiddenPartition, 'Visibility race');
    await realAccess.grant({ route: visibilityChanged.route, id: visibilityChanged.id }, 'reader', 'subject:read');
    await leaveProjectionBehind(hiddenPartition);
    const hideObserver = observeSql(pool);
    try {
      const hidden = await readDuringStaleProjection(
        hideObserver,
        visibilityChanged.id,
        visibilityChanged.component,
        async () => {
          await hide(visibilityChanged.id);
          await catchUpLinks(hiddenPartition);
        },
      );
      expect(hidden.response.status).toBe(404);
      expect(projectionWaitReads(hideObserver).some(({ statement }) => statement === checkpointSql)).toBe(true);
    } finally {
      await hideObserver.close();
    }

    const redirectPartition = freshPartition();
    const redirectCandidate = await createProjected(redirectPartition, 'Redirect race candidate');
    const redirectMate = await createProjected(redirectPartition, 'Redirect race mate');
    const [survivor, merged] = [redirectCandidate.id, redirectMate.id].sort() as [string, string];
    await realAccess.grant({ route: routeOf(merged)!, id: merged }, 'reader', 'subject:read');
    await realAccess.grant({ route: routeOf(survivor)!, id: survivor }, 'reader', 'subject:read');
    await leaveProjectionBehind(redirectPartition);
    const redirectObserver = observeSql(pool);
    try {
      const redirected = await readDuringStaleProjection(
        redirectObserver,
        merged,
        redirectCandidate.component,
        async () => {
          await mergeSubjects(pool, {
            subjects: [survivor, merged],
            survivor,
            ...(await admittedWriter('subject:merge')),
            idempotencyKey: randomUUID(),
            digest: digest(`${survivor}:${merged}:live`),
            release: { digest: bundledDigest, release: bundledRelease },
          });
          await moveMergePage(pool, merged, survivor);
          await catchUpLinks(redirectPartition);
        },
      );
      expect(redirected.response.status).toBe(308);
      expect(redirected.response.headers.get('location')).toBe(`/v1/subjects/${survivor}`);
      expect(projectionWaitReads(redirectObserver).some(({ statement }) => statement === checkpointSql)).toBe(true);
    } finally {
      await redirectObserver.close();
    }
  } finally {
    await observer.close();
  }
}, 60_000);

test('a live identity change during projection wait retries against its current component', async () => {
  const partition = freshPartition();
  const target = await createFixed(partition, 'schema:Person', 'Identity race target');
  const live = await createFixed(partition, 'schema:Book', 'Before identity race', {
    'schema:author': [
      {
        property: { id: 'schema:author' },
        value: { type: 'value', content: target.id },
        qualifiers: [],
        references: [],
      },
    ],
  });
  await realAccess.grant({ route: live.route, id: live.id }, 'writer', 'subject:read');
  await realAccess.grant({ route: live.route, id: live.id }, 'reader', 'subject:read');
  await realAccess.grant({ route: target.route, id: target.id }, 'reader', 'subject:read');
  await leaveProjectionBehind(partition);

  const observer = observeSql(pool);
  try {
    const current = await readDuringStaleProjection(observer, live.id, live.component, async () => {
      const revised = await call('PATCH', `/v1/subjects/${live.id}/terms`, {
        token: 'writer',
        key: `"${randomUUID()}"`,
        ifMatch: '"1"',
        body: { labels: { en: 'After identity race' } },
      });
      expect(revised.response.status, JSON.stringify(revised.body)).toBe(200);
      expect(revised.body).toEqual({ subject: live.id, revision: 2 });
      await catchUpLinks(partition);
    });
    expect(current.response.status).toBe(200);
    expect(current.body.subject.labels).toMatchObject({ en: 'After identity race' });
    expect(current.body.subject.revision).toBe(2);
    expect(current.body.subject.statements['schema:author']).toHaveLength(1);
    expect(current.body.subject.statements['schema:author'][0].value.content).toBe(target.id);
  } finally {
    await observer.close();
  }
}, 60_000);

test('live subject authorization is freshly prepared after an actual projection wait outlives evidence', async () => {
  const partition = freshPartition();
  const target = await createFixed(partition, 'schema:Person', 'Evidence lifetime target');
  const live = await createFixed(partition, 'schema:Book', 'Evidence lifetime read', {
    'schema:author': [
      {
        property: { id: 'schema:author' },
        value: { type: 'value', content: target.id },
        qualifiers: [],
        references: [],
      },
    ],
  });
  await realAccess.grant({ route: live.route, id: live.id }, 'reader', 'subject:read');
  await realAccess.grant({ route: target.route, id: target.id }, 'reader', 'subject:read');
  await leaveProjectionBehind(partition);

  const observer = observeSql(pool);
  const identity = observer.hold({ statement: identitySql }, 'after');
  try {
    const request = readDuringStaleProjection(observer, live.id, live.component, async () => {
      const identityRead = observer.records.findIndex(({ statement }) => statement === identitySql);
      const initial = observer.records
        .slice(0, identityRead)
        .findLast(({ statement }) => statement === permissionTimeSql);
      expect(initial).toBeDefined();
      await catchUpLinks(partition);
      await Bun.sleep(Math.max(0, accessExpiryWitness(initial!.executedAt) - Date.now()));
    });
    try {
      await Promise.race([identity.entered, request]);
      // Age the preflight proof before the projection wait starts. The wait has at most half the remaining request budget.
      await Bun.sleep(650);
    } finally {
      identity.release();
    }
    const current = await request;
    expect(current.response.status).toBe(200);
    expect(current.body.subject.statements['schema:author']).toHaveLength(1);
    expect(current.body.subject.statements['schema:author'][0].value.content).toBe(target.id);
    const detail = observer.records.findIndex(({ statement }) => statement === subjectSql);
    const checkpoint = observer.records.slice(0, detail).findLastIndex(({ statement }) => statement === checkpointSql);
    expect(detail).toBeGreaterThan(checkpoint);
    expect(checkpoint).toBeGreaterThan(0);
    expect(
      observer.records.slice(checkpoint + 1, detail).filter(({ statement }) => statement === permissionTimeSql),
    ).toHaveLength(2);
  } finally {
    await observer.close();
  }
}, 60_000);

test('Library FULL refreshes its Access proof before final summary disclosure when initial evidence expires', async () => {
  const partition = freshPartition();
  const live = await createProjected(partition, 'FULL evidence lifetime read');
  await realAccess.grant({ route: live.route, id: live.id }, 'reader', 'subject:read');
  await leaveProjectionBehind(partition);

  const reader = await libraryActor('reader');
  const observer = observeSql(pool);
  // This is the summary observation's final source-home query, after its initial Access check.
  const source = observer.hold({ statement: partitionBatchSql, occurrence: 2 }, 'after');
  const request = withRequestDeadline(Date.now() + DEFAULT_REQUEST_DEADLINE_MS, () =>
    fullView({ routeKey, pool, access: libraryAccess, tokens }, reader, 'FULL', { entries: [{ subjectId: live.id }] }),
  );
  try {
    const observed = await Promise.race([
      source.entered,
      request.then(() => {
        throw new Error('FULL view completed before observing its summary source homes');
      }),
    ]);
    const observedAt = observer.records.indexOf(observed);
    const summary = observer.records.findIndex(({ statement }) => statement === summarySql);
    const initial = observer.records.slice(0, summary).findLast(({ statement }) => statement === permissionTimeSql);
    expect(summary).toBeGreaterThan(0);
    expect(observedAt).toBeGreaterThan(summary);
    expect(initial).toBeDefined();
    const expiredBy = accessExpiryWitness(initial!.executedAt);
    await Bun.sleep(Math.max(0, expiredBy - Date.now()));
    source.release();

    const view = await request;
    expect(view.entries[0]!.subject).toMatchObject({
      id: live.id,
      label: { value: 'FULL evidence lifetime read', language: 'en' },
    });
    const afterObservation = observer.records.slice(observedAt + 1);
    const current = afterObservation.findIndex(({ statement }) => statement === partitionBatchSql);
    expect(current).toBeGreaterThan(0);
    const refreshed = afterObservation.slice(0, current).filter(({ statement }) => statement === permissionTimeSql);
    expect(refreshed).toHaveLength(1);
    expect(Date.parse(refreshed[0]!.executedAt)).toBeGreaterThanOrEqual(expiredBy);
    expect(projectionWaitReads(observer)).toHaveLength(0);
  } finally {
    source.release();
    await request.catch(() => undefined);
    await observer.close();
  }
}, 60_000);

test('Library FULL classifies one late summary Access SQL point per live subject across captured pools', async () => {
  const growth = await openGrowthDatabase(databaseUrl);
  try {
    const partition = freshPartition();
    const subjects = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createFixed(partition, 'schema:Book', `FULL cost subject ${index}`)),
    );
    for (const subject of subjects)
      await realAccess.grant({ route: subject.route, id: subject.id }, 'reader', 'subject:read');
    await catchUpLinks(partition);
    const reader = await libraryActor('reader', growth.pool);

    const captured = await captureWithFoldedCost(
      growth,
      async () => {
        for (const subject of subjects) {
          const view = await withRequestDeadline(Date.now() + DEFAULT_REQUEST_DEADLINE_MS, () =>
            fullView({ routeKey: routeKey, pool: growth.pool, access: libraryAccess, tokens }, reader, 'FULL', {
              entries: [{ subjectId: subject.id }],
            }),
          );
          expect(view.entries[0]!.subject).toMatchObject({ id: subject.id });
        }
      },
      { includeBackends: true },
    );
    const statements = captured.capture.statements;
    const indices = (statement: string) =>
      statements.flatMap((candidate, index) => (candidate === statement ? [index] : []));
    const referenceReads = indices(referenceSql);
    const summaryReads = indices(summarySql);
    const sourceReads = indices(partitionBatchSql);
    const permissionTimes = indices(permissionTimeSql);

    expect(captured.capture.statementBackends).toHaveLength(statements.length);
    expect(referenceReads).toHaveLength(subjects.length * 4);
    expect(summaryReads).toHaveLength(subjects.length);
    // Initial and final summary snapshots each bind homes and read their components.
    expect(sourceReads).toHaveLength(subjects.length * 4);
    // Two references and one summary check per phase each prepare and authorize at native time.
    expect(permissionTimes).toHaveLength(subjects.length * 12);
    for (const [index, summary] of summaryReads.entries()) {
      const bound = sourceReads[index * 4]!;
      const observed = sourceReads[index * 4 + 1]!;
      const current = sourceReads[index * 4 + 2]!;
      const checked = sourceReads[index * 4 + 3]!;
      expect(summary).toBeGreaterThan(referenceReads[index * 4 + 1]!);
      expect(bound).toBeGreaterThan(summary);
      expect(checked).toBeLessThan(referenceReads[index * 4 + 2]!);
      expect(permissionTimes.filter((position) => position > observed && position < current)).toHaveLength(1);
    }
  } finally {
    await growth.close();
  }
}, 60_000);
