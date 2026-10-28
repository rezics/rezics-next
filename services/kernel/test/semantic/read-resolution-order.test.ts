import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { capture, openGrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { fullView } from '../../src/library/views.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { actorOf, type AccountActor } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { encodeSession } from '../../src/tokens/session.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';
import { observeSql, type SqlObserver } from '../content/support/sql-observer.ts';
import readLinkCheckpoint from '../../src/semantic/read-link-checkpoint.sql';
import readPendingMember from '../../src/semantic/links-read-pending-member.sql';
import readSubjectIdentity from '../../src/semantic/read-subject-identity.sql';
import readSubjectStatement from '../../src/semantic/read-subject.sql';
import readPermissionTime from '../../src/access/permission-time.sql';
import { updateSubjectIdentity } from '../../src/semantic/subject.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const projection = linkProjection(pool);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) };
const routeKey = new Uint8Array(32).fill(43);
const actions = ['subject:create', 'subject:read', 'subject:merge', 'moderation:hide'] as const;
const accounts = {
  writer: newId(randomInt(65_536)),
  reader: newId(randomInt(65_536)),
  moderator: newId(randomInt(65_536)),
};
const realAccess = await createRealAccess(admin, accounts, actions);
const libraryAccess = realAccess.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
const kernel = createKernel({ pool, access: realAccess.access, tokens, routeKey, writeRate: realAccess.writeRate });
const writer = actor('writer');
const subjectMergeAuthorization: CommandAuthorization = {
  action: 'subject:merge',
  resource: { route: 0, id: GLOBAL_CONTEXT },
  denied: () => new Error('Merge denied'),
  async authorize() {
    return 'execute';
  },
};

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'writer', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

function actor(persona: keyof typeof accounts): AccountActor {
  return {
    kind: 'account',
    accountId: accounts[persona],
    clientId: 'semantic-read-resolution',
    scopes: actions,
    requestedBy: null,
    authnEpoch: 1,
  };
}

async function libraryActor(persona: keyof typeof accounts, authPool: typeof pool = pool): Promise<AccountActor> {
  return (await actorOf(
    libraryAccess,
    new Request('https://kernel.test', { headers: { authorization: `Bearer ${realAccess.bearer(persona)}` } }),
    { pool: authPool, deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS },
  )) as AccountActor;
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
    actor: writer,
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: digest(id),
    item: { type, labels: { en: label }, ...(statements ? { statements } : {}) },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
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
    actor: writer,
    idempotencyKey: randomUUID(),
    digest: digest(`${survivor}:${merged}`),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: subjectMergeAuthorization,
    deadline: Date.now() + 20_000,
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
  options: { token?: keyof typeof accounts; key?: string; body?: unknown; session?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${realAccess.bearer(options.token)}`;
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
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
  expect(
    records.some(({ statement, parameters }) => statement === readSubjectIdentity.sql && parameters.includes(id)),
  ).toBe(true);
  expect(projectionWaitReads(observer, from)).toHaveLength(0);
}

async function readDuringStaleProjection(
  observer: SqlObserver,
  id: string,
  component: { partition: number; epoch: number; position: bigint },
  whileWaiting: () => Promise<void>,
) {
  const barrier = observer.hold({ statement: readLinkCheckpoint.sql }, 'after');
  const request = call('GET', `/v1/subjects/${id}`, {
    token: 'reader',
    session: encodeSession(tokens, `account:${accounts.reader}`, [component]),
  });
  try {
    await barrier.entered;
    await whileWaiting();
  } finally {
    barrier.release();
  }
  return request;
}

async function readFullViewDuringStaleProjection(
  observer: SqlObserver,
  id: string,
  reader: AccountActor,
  whileWaiting: () => Promise<void>,
) {
  const barrier = observer.hold({ statement: readLinkCheckpoint.sql }, 'after');
  const request = withRequestDeadline(Date.now() + DEFAULT_REQUEST_DEADLINE_MS, () =>
    fullView({ pool, access: libraryAccess, tokens }, reader, 'FULL', {
      entries: [{ subjectId: id }],
    }),
  );
  try {
    await Promise.race([
      barrier.entered,
      request.then(
        (view) => {
          throw new Error(`FULL view completed before reaching the projection checkpoint: ${JSON.stringify(view)}`);
        },
        (error) => {
          throw error;
        },
      ),
    ]);
    await whileWaiting();
  } finally {
    barrier.release();
  }
  return request;
}

async function waitPastPreparedAccessEvidence(observer: SqlObserver, from: number): Promise<void> {
  const preparedAt = observer.records
    .slice(from)
    .find(({ statement }) => statement === readPermissionTime.sql)?.executedAt;
  expect(preparedAt).toBeDefined();
  const expiresAt = Date.parse(preparedAt!) + 1_100;
  while (Date.now() < expiresAt) await Bun.sleep(Math.min(20, expiresAt - Date.now()));
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
    expect(liveRequest.body.subject.relationCounts['schema:author']).toBe(1);
    expect(liveRequest.body.subject.statements['schema:author']).toHaveLength(1);
    const liveWaits = projectionWaitReads(observer);
    expect(liveWaits.some(({ statement }) => statement === readLinkCheckpoint.sql)).toBe(true);
    expect(liveWaits.some(({ statement }) => statement === readPendingMember.sql)).toBe(true);
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
      expect(projectionWaitReads(revokeObserver).some(({ statement }) => statement === readLinkCheckpoint.sql)).toBe(
        true,
      );
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
      expect(projectionWaitReads(hideObserver).some(({ statement }) => statement === readLinkCheckpoint.sql)).toBe(
        true,
      );
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
            actor: writer,
            idempotencyKey: randomUUID(),
            digest: digest(`${survivor}:${merged}:live`),
            release: { digest: bundledDigest, release: bundledRelease },
            authorization: subjectMergeAuthorization,
            deadline: Date.now() + 20_000,
          });
          await moveMergePage(pool, merged, survivor);
          await catchUpLinks(redirectPartition);
        },
      );
      expect(redirected.response.status).toBe(308);
      expect(redirected.response.headers.get('location')).toBe(`/v1/subjects/${survivor}`);
      expect(projectionWaitReads(redirectObserver).some(({ statement }) => statement === readLinkCheckpoint.sql)).toBe(
        true,
      );
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
  await realAccess.grant({ route: live.route, id: live.id }, 'reader', 'subject:read');
  await realAccess.grant({ route: target.route, id: target.id }, 'reader', 'subject:read');
  await leaveProjectionBehind(partition);

  const observer = observeSql(pool);
  try {
    const current = await readDuringStaleProjection(observer, live.id, live.component, async () => {
      await updateSubjectIdentity(pool, {
        subject: live.id,
        labels: { en: 'After identity race' },
        release: { digest: bundledDigest, release: bundledRelease },
        authorize: async () => true,
      });
      await catchUpLinks(partition);
    });
    expect(current.response.status).toBe(200);
    expect(current.body.subject.labels).toMatchObject({ en: 'After identity race' });
    expect(current.body.subject.revision).toBe(2);
    expect(current.body.subject.relationCounts['schema:author']).toBe(1);
    expect(current.body.subject.statements['schema:author']).toHaveLength(1);
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
  const before = observer.records.length;
  try {
    const current = await readDuringStaleProjection(observer, live.id, live.component, async () => {
      await catchUpLinks(partition);
      await waitPastPreparedAccessEvidence(observer, before);
    });
    expect(current.response.status).toBe(200);
    expect(current.body.subject.relationCounts['schema:author']).toBe(1);
    expect(current.body.subject.statements['schema:author']).toHaveLength(1);
    const preparations = observer.records.slice(before).filter(({ statement }) => statement === readPermissionTime.sql);
    expect(preparations.length).toBeGreaterThan(3);
    expect(projectionWaitReads(observer, before).some(({ statement }) => statement === readLinkCheckpoint.sql)).toBe(
      true,
    );
  } finally {
    await observer.close();
  }
}, 60_000);

test('FULL subject display refreshes its Access proof after an actual projection wait outlives evidence', async () => {
  const partition = freshPartition();
  const target = await createFixed(partition, 'schema:Person', 'FULL evidence target');
  const live = await createFixed(partition, 'schema:Book', 'FULL evidence lifetime read', {
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

  const reader = await libraryActor('reader');
  const observer = observeSql(pool);
  const before = observer.records.length;
  try {
    const view = await readFullViewDuringStaleProjection(observer, live.id, reader, async () => {
      await catchUpLinks(partition);
      await waitPastPreparedAccessEvidence(observer, before);
    });
    expect(view.entries[0]!.subject).toMatchObject({
      id: live.id,
      label: { value: 'FULL evidence lifetime read', language: 'en' },
    });
    const preparations = observer.records.slice(before).filter(({ statement }) => statement === readPermissionTime.sql);
    expect(preparations.length).toBeGreaterThan(2);
    expect(projectionWaitReads(observer, before).some(({ statement }) => statement === readLinkCheckpoint.sql)).toBe(
      true,
    );
  } finally {
    await observer.close();
  }
}, 60_000);

test('FULL display classifies one late Access preparation SQL point per live subject across captured pools', async () => {
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

    const captured = await capture(
      growth,
      async () => {
        for (const subject of subjects) {
          const view = await withRequestDeadline(Date.now() + DEFAULT_REQUEST_DEADLINE_MS, () =>
            fullView({ pool: growth.pool, access: libraryAccess, tokens }, reader, 'FULL', {
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
    const identityReads = indices(readSubjectIdentity.sql);
    const subjectReads = indices(readSubjectStatement.sql);
    const checkpoints = indices(readLinkCheckpoint.sql);
    const permissionPreparations = indices(readPermissionTime.sql);

    expect(captured.capture.statementBackends).toHaveLength(statements.length);
    expect(identityReads).toHaveLength(subjects.length);
    expect(subjectReads).toHaveLength(subjects.length);
    expect(permissionPreparations.length).toBeGreaterThanOrEqual(subjects.length * 2);
    for (const identityRead of identityReads) {
      const subjectRead = subjectReads.find((index) => index > identityRead);
      expect(subjectRead).toBeDefined();
      const checkpoint = checkpoints.find((index) => index > identityRead && index < subjectRead!);
      expect(checkpoint).toBeDefined();
      expect(permissionPreparations.filter((index) => index > checkpoint! && index < subjectRead!)).toHaveLength(1);
    }
  } finally {
    await growth.close();
  }
}, 60_000);
