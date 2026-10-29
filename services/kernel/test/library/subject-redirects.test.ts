import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { syncSubjectListing } from '../../src/library/listing.ts';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(107);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(108)]]) };
const accounts = { owner: newId(0x6c41), other: newId(0x6c41), suspended: newId(0x6c41) };
type Persona = keyof typeof accounts | 'anonymous';
const scopes = [
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'library_entry:delete',
  'copy:create',
  'copy:read',
  'copy:list',
  'copy:update',
  'copy:delete',
  'follow:create',
  'follow:delete',
  'follow:read',
  'follow:list',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'published_log:create',
  'published_log:read',
  'published_log:list',
  'subject:read',
  'exposure:open',
];
const actorFor = (accountId: string): AccountActor => ({
  kind: 'account',
  accountId,
  clientId: 'subject-redirects',
  scopes,
  requestedBy: null,
  authnEpoch: 1,
});
const actors: Record<keyof typeof accounts, AccountActor> = {
  owner: actorFor(accounts.owner),
  other: actorFor(accounts.other),
  suspended: actorFor(accounts.suspended),
};
const credentials = new Map<keyof typeof accounts, string>();
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let writerPoolInstrumented = false;

const mergeAuthorization: CommandAuthorization = {
  action: 'subject:merge',
  resource: { route: 0, id: GLOBAL_CONTEXT },
  denied: () => new Error('Subject merge was denied'),
  async authorize() {
    return 'execute';
  },
};

function accountActor(persona: keyof typeof accounts): AccountActor {
  return actors[persona];
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  as: Persona = 'owner',
  key: string = randomUUID(),
): Promise<Response> {
  return app.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers: {
        ...(as === 'anonymous' ? {} : { authorization: `Bearer ${credentials.get(as)!}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function json<T = Record<string, any>>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

async function problem(response: Response, status: number, code = 'not_found') {
  expect(response.status, await response.clone().text()).toBe(status);
  const body = await response.json();
  expect(body).toMatchObject({ status, code, type: `https://rezics.com/problems/${code}` });
  const { request_id: _requestId, ...stable } = body;
  return stable;
}

async function subject(label: string = randomUUID()): Promise<string> {
  const key = randomUUID();
  return (
    await createSubject(db.pool, {
      actor: accountActor('owner'),
      target: subjectTarget(routeKey, accounts.owner, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: label } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
}

async function mergedPair(label: string = randomUUID()) {
  const pair = await subjectPair(label);
  await mergeOnly([pair.survivor, pair.redirected]);
  return pair;
}

async function subjectPair(label: string = randomUUID()) {
  const ids = [await subject(`${label} one`), await subject(`${label} two`)].sort();
  const [survivor, redirected] = ids as [string, string];
  return { survivor, redirected };
}

async function collection(visibility: 'private' | 'public' = 'private') {
  if (!writerPoolInstrumented) {
    const NativePool = pg.Pool;
    pg.Pool = class extends NativePool {
      constructor(config?: pg.PoolConfig) {
        super(config);
        pg.Pool = NativePool;
        return db.openPool(config);
      }
    };
    writerPoolInstrumented = true;
  }
  return (
    await json<{ collection: { id: string } }>(
      await request('POST', '/v1/collections', { title: 'Shelf', visibility }),
      201,
    )
  ).collection;
}

async function addMember(collectionId: string, subjectId: string) {
  return json<{ member: { id: string; subjectId: string } }>(
    await request('POST', `/v1/collections/${collectionId}/members`, { subjectId }),
    201,
  );
}

async function mergeOnly(ids: [string, string]) {
  await mergeSubjects(db.pool, {
    subjects: ids,
    actor: accountActor('owner'),
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(randomUUID()).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: mergeAuthorization,
    deadline: Date.now() + 10_000,
  });
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'subject-redirects', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.subject-redirects.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.subject-redirects.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });

  for (const [persona, accountId] of Object.entries(accounts)) {
    await db.admin.query(
      `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
       VALUES ($1, $2, 'actor', $3, $2, false, 1, true)`,
      [routeOf(accountId), accountId, persona === 'suspended' ? 'suspended' : 'active'],
    );
    credentials.set(
      persona as keyof typeof accounts,
      await new SignJWT({
        client_id: 'subject-redirects',
        scope: scopes.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'subject-redirects', typ: 'at+jwt' })
        .setIssuer('https://auth.subject-redirects.test')
        .setAudience('https://api.rezics.test')
        .setSubject(accountId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }

  await bootstrapGovernance(db.pool, accounts.owner);
  for (const group of ['collections', 'personal_library', 'reading_progress'])
    await json(await request('POST', `/v1/platform/exposure/${group}:open`));
});

afterAll(async () => {
  await db?.close();
});

test('a write naming a merged subject lands on its survivor and an entry records the requested id', async () => {
  const { survivor, redirected } = await mergedPair('write target');
  const shelf = await collection();
  const member = await addMember(shelf.id, redirected);
  expect(member.member.subjectId).toBe(survivor);

  const entry = await json<{ libraryEntry: { subjectId: string; revision: number } }>(
    await request('PUT', `/v1/libraryEntries/${redirected}`, { state: 'planned' }),
    201,
  );
  expect(entry.libraryEntry.subjectId).toBe(survivor);
  const entryRows = await db.admin.query<{ subject_id: string; requested_subject_id: string | null }>(
    `SELECT subject_id::text, requested_subject_id::text
       FROM library.entry WHERE route = $1 AND account_id = $2 AND subject_id = $3`,
    [routeOf(accounts.owner), accounts.owner, survivor],
  );
  expect(entryRows.rows).toEqual([{ subject_id: survivor, requested_subject_id: redirected }]);

  const copy = await json<{ copy: { subjectId: string } }>(
    await request('POST', '/v1/copies', { subjectId: redirected, status: 'owned' }),
    201,
  );
  expect(copy.copy.subjectId).toBe(survivor);

  const session = await json<{ progressSession: { subjectId: string; versionSubjectId: string } }>(
    await request('POST', '/v1/progressSessions', {
      subjectId: redirected,
      versionSubjectId: redirected,
      mode: 'scalar_amount',
      unit: 'page',
    }),
    201,
  );
  expect(session.progressSession).toMatchObject({ subjectId: survivor, versionSubjectId: survivor });

  const follow = await json<{ follow: { targetId: string; targetType: string } }>(
    await request('PUT', `/v1/follows/${redirected}`),
  );
  expect(follow.follow).toMatchObject({ targetId: survivor, targetType: 'subject' });
});

test('Collection pages and every library read keep serving rows held under a merged id', async () => {
  const { survivor, redirected } = await subjectPair('read target');
  const shelf = await collection('public');
  const storedMember = await addMember(shelf.id, redirected);
  await syncSubjectListing({ pool: db.pool }, { subjectId: redirected, collectionId: shelf.id });
  await request('PUT', `/v1/libraryEntries/${redirected}`, { state: 'planned' });
  const copy = await json<{ copy: { id: string } }>(
    await request('POST', '/v1/copies', { subjectId: redirected, status: 'owned' }),
    201,
  );
  const session = await json<{ progressSession: { id: string } }>(
    await request('POST', '/v1/progressSessions', {
      subjectId: redirected,
      versionSubjectId: redirected,
      mode: 'scalar_amount',
      unit: 'page',
    }),
    201,
  );
  const log = await json<{ publishedLog: { id: string } }>(
    await request('POST', '/v1/publishedLogs', { sessionId: session.progressSession.id }),
    201,
  );
  await request('PUT', `/v1/follows/${redirected}`);
  await mergeOnly([survivor, redirected]);

  const expected = {
    id: survivor,
    type: 'schema:Book',
    types: ['schema:Book', ...bundledRelease.types['schema:Book']!.bases],
    label: { value: expect.any(String), language: 'en' },
    creativeWork: true,
    cover: null,
  };
  const membersBasic = await json<{ members: { id: string; subjectId: string }[] }>(
    await request('GET', `/v1/collections/${shelf.id}/members`),
  );
  expect(membersBasic.members).toContainEqual(
    expect.objectContaining({ id: storedMember.member.id, subjectId: redirected }),
  );
  const membersFull = await json<{ members: { subjectId: string; subject: unknown }[] }>(
    await request('GET', `/v1/collections/${shelf.id}/members?view=FULL`, undefined, 'anonymous'),
  );
  expect(membersFull.members).toContainEqual(expect.objectContaining({ subjectId: redirected, subject: expected }));

  const entryRead = await json<{ libraryEntry: { subjectId: string; subject: unknown } }>(
    await request('GET', `/v1/libraryEntries/${redirected}?view=FULL`),
  );
  expect(entryRead.libraryEntry).toMatchObject({ subjectId: redirected, subject: expected });
  const entryPage = await json<{ libraryEntries: { subject: unknown }[] }>(
    await request('GET', '/v1/libraryEntries?view=FULL'),
  );
  expect(entryPage.libraryEntries).toContainEqual(expect.objectContaining({ subject: expected }));

  const copyRead = await json<{ copy: { subjectId: string; subject: unknown } }>(
    await request('GET', `/v1/copies/${copy.copy.id}?view=FULL`),
  );
  expect(copyRead.copy).toMatchObject({ subjectId: redirected, subject: expected });
  const copyPage = await json<{ copies: { subject: unknown }[] }>(await request('GET', '/v1/copies?view=FULL'));
  expect(copyPage.copies).toContainEqual(expect.objectContaining({ subject: expected }));

  const sessionRead = await json<{
    progressSession: { subjectId: string; versionSubjectId: string; subject: unknown; versionSubject: unknown };
  }>(await request('GET', `/v1/progressSessions/${session.progressSession.id}?view=FULL`));
  expect(sessionRead.progressSession).toMatchObject({
    subjectId: redirected,
    versionSubjectId: redirected,
    subject: expected,
    versionSubject: expected,
  });
  const sessionPage = await json<{ progressSessions: { subject: unknown; versionSubject: unknown }[] }>(
    await request('GET', `/v1/progressSessions?subjectId=${redirected}&view=FULL`),
  );
  expect(sessionPage.progressSessions).toContainEqual(
    expect.objectContaining({ subject: expected, versionSubject: expected }),
  );

  const followRead = await json<{ follow: { targetId: string; target: unknown } }>(
    await request('GET', `/v1/follows/${redirected}?view=FULL`),
  );
  expect(followRead.follow).toMatchObject({ targetId: redirected, target: expected });
  const followPage = await json<{ follows: { targetId: string; target: unknown }[] }>(
    await request('GET', '/v1/follows?view=FULL'),
  );
  expect(followPage.follows).toContainEqual(expect.objectContaining({ targetId: redirected, target: expected }));

  const logRead = await json<{ publishedLog: { subject: unknown } }>(
    await request('GET', `/v1/publishedLogs/${log.publishedLog.id}?view=FULL`),
  );
  expect(logRead.publishedLog.subject).toEqual(expected);
  const logPage = await json<{ publishedLogs: { subject: unknown }[] }>(
    await request('GET', `/v1/publishedLogs?accountId=${accounts.owner}&view=FULL`),
  );
  expect(logPage.publishedLogs).toContainEqual(expect.objectContaining({ subject: expected }));

  const collections = await json<{ collections: { id: string }[] }>(
    await request('GET', `/v1/subjects/${redirected}/collections`),
  );
  expect(collections.collections).toContainEqual(expect.objectContaining({ id: shelf.id }));
  expect(
    (await json<{ collections: { id: string }[] }>(await request('GET', `/v1/subjects/${survivor}/collections`)))
      .collections,
  ).not.toContainEqual(expect.objectContaining({ id: shelf.id }));

  for (const path of [
    `/v1/libraryEntries/${redirected}`,
    `/v1/copies/${copy.copy.id}`,
    `/v1/progressSessions/${session.progressSession.id}`,
    `/v1/follows/${redirected}`,
    `/v1/publishedLogs/${log.publishedLog.id}`,
  ]) {
    const hidden = await request('GET', `${path}?view=FULL`, undefined, 'other');
    expect([200, 401, 403, 404]).toContain(hidden.status);
    expect(hidden.status).not.toBe(500);
  }
  const suspendedRead = await request('GET', `/v1/libraryEntries/${redirected}`, undefined, 'suspended');
  expect([401, 403, 404]).toContain(suspendedRead.status);
});

test('an entry remains addressed by its creation id and can be read, updated and deleted after a merge', async () => {
  const { survivor, redirected } = await subjectPair('entry address');
  const created = await json<{ libraryEntry: { subjectId: string; revision: number; state: string } }>(
    await request('PUT', `/v1/libraryEntries/${redirected}`, { state: 'planned' }),
    201,
  );
  expect(created.libraryEntry).toMatchObject({ subjectId: redirected, revision: 1, state: 'planned' });
  await mergeOnly([survivor, redirected]);

  const changed = await json<{ libraryEntry: { subjectId: string; revision: number; state: string } }>(
    await request('PUT', `/v1/libraryEntries/${redirected}`, { state: 'completed', revision: 1 }),
  );
  expect(changed.libraryEntry).toMatchObject({ subjectId: redirected, revision: 2, state: 'completed' });
  expect(await json(await request('GET', `/v1/libraryEntries/${redirected}`))).toMatchObject({
    libraryEntry: changed.libraryEntry,
  });
  await problem(await request('GET', `/v1/libraryEntries/${survivor}`), 404);
  expect((await request('DELETE', `/v1/libraryEntries/${redirected}?revision=2`)).status).toBe(204);
  await problem(await request('GET', `/v1/libraryEntries/${redirected}`), 404);
});

test('an unreadable survivor is indistinguishable from an unknown subject', async () => {
  const { survivor, redirected } = await mergedPair('hidden survivor');
  await db.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [routeOf(survivor), survivor, accounts.other, randomUUID()],
  );
  try {
    const hidden = await problem(
      await request('PUT', `/v1/libraryEntries/${redirected}`, { state: 'planned' }, 'other'),
      404,
    );
    expect(
      await problem(
        await request('PUT', `/v1/libraryEntries/${newId(routeOf(survivor)!)}`, { state: 'planned' }, 'other'),
        404,
      ),
    ).toEqual(hidden);
    expect(
      await problem(await request('POST', '/v1/copies', { subjectId: redirected, status: 'owned' }, 'other'), 404),
    ).toEqual(
      await problem(
        await request('POST', '/v1/copies', { subjectId: newId(routeOf(survivor)!), status: 'owned' }, 'other'),
        404,
      ),
    );
  } finally {
    await db.admin.query(
      `DELETE FROM access.resource_denial WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND action = 'subject:read'`,
      [routeOf(survivor), survivor, accounts.other],
    );
  }
});

test('redirect reads add one anchored read while writes and member pages stay constant with unrelated growth', async () => {
  const scales = [1, 8, 64] as const;
  const statementCounts: {
    add: number;
    basicPage: number;
    redirectPage: number;
    entryWrite: number;
    entryRead: number;
    entryDelete: number;
  }[] = [];
  const subjectReads: { basicPage: number; redirectPage: number }[] = [];
  const background = await collection('public');
  const basePage = await collection('public');
  const baseId = await subject('constant page subject');
  await addMember(basePage.id, baseId);
  const redirectedPage = await collection('public');
  const redirectedIds = await Promise.all([subject('constant redirect one'), subject('constant redirect two')]);
  await addMember(redirectedPage.id, redirectedIds[1]!);
  await mergeOnly(redirectedIds as [string, string]);

  let previous = 0;
  for (const scale of scales) {
    let costPair: { survivor: string; redirected: string } | undefined;
    for (let index = previous; index < scale; index++) {
      const pair = await Promise.all([subject(`unrelated ${index} one`), subject(`unrelated ${index} two`)]);
      await addMember(background.id, pair[1]!);
      await mergeOnly(pair as [string, string]);
      const [survivor, redirected] = pair.sort() as [string, string];
      costPair = { survivor, redirected };
    }
    previous = scale;

    const writeCollection = await collection();
    const writeTarget = await subject(`add member target ${scale}`);
    const added = await capture(db, () => addMember(writeCollection.id, writeTarget));
    expect(added.value.member.subjectId).toBe(writeTarget);

    const target = costPair!;
    const entryWrite = await capture(db, () =>
      request('PUT', `/v1/libraryEntries/${target.redirected}`, { state: 'planned' }),
    );
    expect((await json<{ libraryEntry: { subjectId: string } }>(entryWrite.value, 201)).libraryEntry.subjectId).toBe(
      target.survivor,
    );
    const entryRead = await capture(db, () => request('GET', `/v1/libraryEntries/${target.redirected}`));
    expect((await json<{ libraryEntry: { subjectId: string } }>(entryRead.value)).libraryEntry.subjectId).toBe(
      target.survivor,
    );
    const entryDelete = await capture(db, () =>
      request('DELETE', `/v1/libraryEntries/${target.redirected}?revision=1`),
    );
    expect(entryDelete.value.status).toBe(204);

    const basicPage = await capture(
      db,
      () => request('GET', `/v1/collections/${basePage.id}/members?view=FULL&limit=1`),
      { includeBackends: true },
    );
    const redirectPage = await capture(db, () =>
      request('GET', `/v1/collections/${redirectedPage.id}/members?view=FULL&limit=1`),
    );
    await json(basicPage.value);
    await json(redirectPage.value);

    // Preserve actual statement texts across scales before diagnosing count variation.
    // Include every pool and control/catalog statement; no measurement is filtered.
    console.log(
      'LIBRARY_BASIC_PAGE_CAPTURE',
      JSON.stringify({
        scale,
        statements: basicPage.capture.statements,
        backends: basicPage.capture.statementBackends,
        backgroundStatements: basicPage.capture.backgroundStatements,
        backgroundBackends: basicPage.capture.backgroundStatementBackends,
      }),
    );

    const countSubjectReads = (statements: readonly string[]) =>
      statements.filter((statement) => statement.includes('FROM semantic.subject AS s')).length;
    statementCounts.push({
      add: added.capture.statements.length,
      basicPage: basicPage.capture.statements.length,
      redirectPage: redirectPage.capture.statements.length,
      entryWrite: entryWrite.capture.statements.length,
      entryRead: entryRead.capture.statements.length,
      entryDelete: entryDelete.capture.statements.length,
    });
    subjectReads.push({
      basicPage: countSubjectReads(basicPage.capture.statements),
      redirectPage: countSubjectReads(redirectPage.capture.statements),
    });
  }

  expect(statementCounts[1]).toEqual(statementCounts[0]);
  expect(statementCounts[2]).toEqual(statementCounts[0]);
  expect(subjectReads).toEqual([
    { basicPage: 2, redirectPage: 3 },
    { basicPage: 2, redirectPage: 3 },
    { basicPage: 2, redirectPage: 3 },
  ]);
});
