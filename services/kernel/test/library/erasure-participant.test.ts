import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createEntryCommands } from '../../src/library/entries.ts';
import { libraryErasureWorkflowId } from '../../src/library/erasure-participant.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createPersonas, type Persona, type PersonasOptions } from '../support/personas.ts';
import { testKernel, testTokens, type TestKernel } from '../support/test-kernel.ts';
import { startErasureWorker } from './support/erasure-worker.ts';

let db: GrowthDatabase;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let options: PersonasOptions;
let people: Awaited<ReturnType<typeof createPersonas>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let worker: Awaited<ReturnType<typeof startErasureWorker>> | undefined;
let subjectId: string;
let privateId: string;
let unlistedId: string;
let sessionId: string;
let oldActor: Awaited<ReturnType<TestKernel['testAccess']['authenticate']>>;
let entries: ReturnType<typeof createEntryCommands>;
let correctionReviewId: string;
const key = () => crypto.randomUUID();

async function request(as: Persona | null, method: string, path: string, body?: unknown) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(as ? { authorization: `Bearer ${as.bearer}` } : {}),
        'idempotency-key': JSON.stringify(key()),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function json(response: Response, status: number) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'library-erasure-native-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 1000, seconds: 60 } } }),
    }),
  });
  options = { version: 1, pool: db.pool, auth };
  people = await createPersonas(kernel, options);
  for (const group of ['collections', 'personal_library', 'reading_progress'])
    await json(await request(people.staff, 'POST', `/v1/platform/exposure/${group}:open`), 200);
  await json(
    await request(people.staff, 'POST', '/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: people.staff.accountId },
      actions: ['subject:create'],
      valid: '(,)',
    }),
    201,
  );
  subjectId = (
    await json(
      await request(people.staff, 'POST', '/v1/subjects', {
        type: 'schema:Book',
        labels: { en: 'Native terminal Library fixture' },
      }),
      201,
    )
  ).subject.id;
  await json(await request(people.bob, 'PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned' }), 201);
  // Cross the real 100-key boundary; each copy is created through the ordinary API.
  for (let i = 0; i < 101; i++)
    await json(
      await request(people.bob, 'POST', '/v1/copies', {
        subjectId,
        kind: 'physical',
        status: 'owned',
        note: `private copy ${i}`,
      }),
      201,
    );
  privateId = (
    await json(
      await request(people.bob, 'POST', '/v1/collections', {
        title: 'private terminal contribution',
        visibility: 'private',
      }),
      201,
    )
  ).collection.id;
  unlistedId = (
    await json(
      await request(people.bob, 'POST', '/v1/collections', {
        title: 'unlisted terminal contribution',
        visibility: 'unlisted',
      }),
      201,
    )
  ).collection.id;
  sessionId = (
    await json(
      await request(people.bob, 'POST', '/v1/progressSessions', {
        subjectId,
        mode: 'scalar_amount',
        unit: 'page',
        total: '500',
      }),
      201,
    )
  ).progressSession.id;
  oldActor = await kernel.testAccess.authenticate(people.bob.bearer, { pool: db.pool, deadline: Date.now() + 5000 });
  entries = createEntryCommands({ pool: db.pool, access: kernel.testAccess, tokens: testTokens() });
  const ownedEntry = await entries.readEntry(oldActor, subjectId);
  if (!ownedEntry.incarnationId) throw new Error('Expected an incarnated entry for correction erasure coverage');
  correctionReviewId = (
    await json(
      await request(people.bob, 'POST', '/v1/libraryEntryAnnotationCorrections', {
        items: [
          {
            subjectId,
            incarnationId: ownedEntry.incarnationId,
            currentRevision: ownedEntry.revision,
            note: { op: 'set', value: 'private review state erased with owner' },
            priority: { op: 'preserve' },
          },
        ],
      }),
      201,
    )
  ).review.reviewId;
  client = await createWorkClient(db.url);
  // Auth owns its separate executor; the default kernel worker runs in its own process.
  worker = await startErasureWorker(db.url, client);
}, 360_000);

afterAll(async () => {
  await worker?.close();
  await client?.close();
  await auth?.close();
  await db?.close();
});

async function result(persona: Persona) {
  const partition = partitionOf(routeOf(persona.accountId)!);
  await drainEffects(db.pool, partition);
  const id = libraryErasureWorkflowId(persona.accountId);
  const deadline = Date.now() + 30000;
  while (!(await client.getWorkflow(id))) {
    if (Date.now() >= deadline) throw new Error(`Default Library effect did not register ${id}: ${worker?.output}`);
    await Bun.sleep(10);
  }
  const value = (await client.retrieveWorkflow(id).getResult()) as {
    state: string;
    facts: { pages: number; examined: number; removed: number };
    remainingStores: string[];
    blockers: string[];
  };
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(4096);
  expect((await client.getWorkflow(id))?.workflowName).toBe('library.accountErasure');
  return value;
}
async function pending(persona: Persona) {
  expect(await readErasureStatus(db.pool, persona.accountId)).toMatchObject({
    version: 1,
    state: 'pending',
    completedAt: null,
    participants: { library: { outcome: 'pending', retained: [] } },
  });
  expect(
    (
      await db.admin.query(
        `SELECT outcome FROM access.erasure_acknowledgement WHERE route=$1 AND account_id=$2 AND participant='library'`,
        [routeOf(persona.accountId), persona.accountId],
      )
    ).rows,
  ).toEqual([]);
}

test('fresh Auth deletion of an unused actor reaches the registered default participant but missing all-role custody forbids none', async () => {
  const deleted = await deletePersona(options, people.alice);
  expect(deleted.accountId).toBe(people.alice.accountId);
  const observed = await result(people.alice);
  expect(observed.state).toBe('pending');
  expect(observed.facts).toEqual({ pages: 3, examined: 0, removed: 0 });
  expect(observed.remainingStores).toEqual([]);
  expect(observed.blockers).toContain(
    'shared receipt/outbox/write_basis/work payloads: no exact Library producer custody/minimizer handoff',
  );
  await pending(people.alice);
  expect((await request(people.alice, 'GET', '/v1/libraryEntries')).status).toBe(401);
}, 90000);

test('complete local native cleanup stays pending for shared custody and T immediately fences typed writes and private/unlisted reads', async () => {
  expect((await request(people.bob, 'GET', `/v1/collections/${privateId}`)).status).toBe(200);
  expect((await request(null, 'GET', `/v1/collections/${unlistedId}`)).status).toBe(200);
  const nativeOwner = [routeOf(people.bob.accountId), people.bob.accountId];
  expect(
    (
      await db.admin.query(
        'SELECT session_id FROM library.progress_session WHERE route=$1 AND account_id=$2 AND session_id=$3',
        [...nativeOwner, sessionId],
      )
    ).rows,
  ).toEqual([{ session_id: sessionId }]);
  for (const table of ['progress_head', 'fact_source_head'])
    expect(
      (await db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND account_id=$2 LIMIT 1`, nativeOwner))
        .rows,
    ).toEqual([{ '?column?': 1 }]);
  for (const id of [privateId, unlistedId])
    expect(
      (
        await db.admin.query(
          'SELECT collection_id FROM library.collection WHERE route=$1 AND curator_account_id=$2 AND collection_id=$3',
          [...nativeOwner, id],
        )
      ).rows,
    ).toEqual([{ collection_id: id }]);
  await deletePersona(options, people.bob);
  // Authority/disclosure must fail at T, independently of asynchronous physical work.
  const denied = await capture(db, async () => {
    await expect(entries.putEntry(oldActor, subjectId, { state: 'completed' }, key())).rejects.toBeInstanceOf(
      GrantDeniedError,
    );
    await expect(entries.listEntries(oldActor)).rejects.toBeInstanceOf(GrantDeniedError);
  });
  expect(denied.capture.statements.length).toBeGreaterThan(0);
  expect((await request(people.bob, 'GET', `/v1/collections/${privateId}`)).status).toBe(401);
  for (const path of [
    `/v1/collections/${privateId}`,
    `/v1/collections/${unlistedId}`,
    `/v1/collections/${unlistedId}/members`,
  ])
    expect((await request(null, 'GET', path)).status).toBe(404);
  const observed = await result(people.bob);
  expect(observed.state).toBe('pending');
  expect(observed.facts.pages).toBe(4);
  expect(observed.facts.examined).toBeGreaterThanOrEqual(102);
  expect(observed.facts.removed).toBe(observed.facts.examined);
  expect(observed.remainingStores).toEqual([]);
  await pending(people.bob);
  const owner = [routeOf(people.bob.accountId), people.bob.accountId];
  expect(
    (
      await db.admin.query(
        'SELECT review_id FROM library.entry_annotation_review WHERE route=$1 AND account_id=$2 AND review_id=$3',
        [...owner, correctionReviewId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.admin.query(
        'SELECT review_id FROM library.entry_annotation_review_item WHERE route=$1 AND account_id=$2 AND review_id=$3',
        [...owner, correctionReviewId],
      )
    ).rows,
  ).toEqual([]);
  for (const table of ['entry', 'copy', 'follow'])
    expect(
      (await db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND account_id=$2 LIMIT 1`, owner)).rows,
    ).toEqual([]);
  expect(
    (
      await db.admin.query('SELECT session_id FROM library.progress_session WHERE route=$1 AND session_id=$2', [
        owner[0],
        sessionId,
      ])
    ).rows,
  ).toEqual([]);
  for (const table of ['progress_unit', 'progress_change'])
    expect(
      (
        await db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND session_id=$2 LIMIT 1`, [
          owner[0],
          sessionId,
        ])
      ).rows,
    ).toEqual([]);
  for (const table of ['progress_head', 'fact_source_head'])
    expect(
      (await db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND account_id=$2 LIMIT 1`, owner)).rows,
    ).toEqual([]);
  for (const id of [privateId, unlistedId]) {
    expect(
      (
        await db.admin.query(
          'SELECT 1 FROM library.collection WHERE route=$1 AND curator_account_id=$2 AND collection_id=$3',
          [...owner, id],
        )
      ).rows,
    ).toEqual([]);
    for (const table of ['collection_member', 'canonical_source_fact', 'canonical_source_state'])
      expect(
        (
          await db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND collection_id=$2 LIMIT 1`, [
            owner[0],
            id,
          ])
        ).rows,
      ).toEqual([]);
  }
  // Native receipts prove page/result/delete atomicity and fixed raw-key bounds.
  const receipts = await db.admin.query(
    `SELECT response FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
      AND command_kind='library.account-facts.purge' ORDER BY position LIMIT 10`,
    [partitionOf(owner[0] as number), people.bob.accountId],
  );
  expect(receipts.rows).toHaveLength(4);
  for (const { response } of receipts.rows) {
    expect(response.examined).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(512);
  }
}, 90000);

test('native same-ID resume after committed partial purge preserves pending evidence and cannot manufacture an ACK', async () => {
  const id = libraryErasureWorkflowId(people.bob.accountId);
  const before = await result(people.bob);
  const steps = await client.listWorkflowSteps(id);
  await client.resumeWorkflow(id, { queueName: 'workflows' });
  expect(await client.retrieveWorkflow(id).getResult()).toEqual(before);
  expect(await client.listWorkflowSteps(id)).toEqual(steps);
  await pending(people.bob);
  // Duplicate enqueue uses the default participant's stable identity and existing result.
  const duplicate = await client.enqueue(
    {
      workflowName: 'library.accountErasure',
      workflowID: id,
      workflowIDReusePolicy: 'return-existing',
      queueName: 'workflows',
    },
    people.bob.accountId,
  );
  expect(await duplicate.getResult()).toEqual(before);
  await pending(people.bob);
}, 90000);
