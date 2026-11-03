import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { libraryErasureWorkflowId } from '../../src/library/erasure-participant.ts';
import { runCommand } from '../../src/command/command.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceFrontier,
  type NativeSourceIdentity,
} from '../../src/library/native-source-custody.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { testTokens } from '../support/test-kernel.ts';
import { createOwnedErasureFixture } from './support/erasure-worker.ts';

let f: Awaited<ReturnType<typeof createOwnedErasureFixture>>;
beforeAll(async () => {
  f = await createOwnedErasureFixture();
}, 360000);
afterAll(async () => {
  await f?.close();
});

type Result = {
  state: string;
  owned: { pages: number; removed: number };
  remainingStores: string[];
  continuation: { segment: number } | null;
  blockers: string[];
};
async function terminal(accountId: string) {
  await drainEffects(f.db.pool, partitionOf(routeOf(accountId)!));
  const root = libraryErasureWorkflowId(accountId);
  const deadline = Date.now() + 30000;
  while (!(await f.client.getWorkflow(root))) {
    if (Date.now() >= deadline) throw new Error('Default Library workflow did not start');
    await Bun.sleep(10);
  }
  let id = root;
  const results: Result[] = [];
  for (;;) {
    const result = (await f.client.retrieveWorkflow(id).getResult()) as Result;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
    expect(result.state).toBe('pending');
    expect(result.owned.pages).toBeLessThanOrEqual(100);
    results.push(result);
    if (result.continuation === null) break;
    id = `${root}:${result.continuation.segment}`;
  }
  expect(results.at(-1)!.remainingStores).toEqual([]);
  expect(results.at(-1)!.blockers).toContain(
    'shared receipt/outbox/write_basis/work payloads: no exact Library producer custody/minimizer handoff',
  );
  expect(await readErasureStatus(f.db.pool, accountId)).toMatchObject({
    state: 'pending',
    completedAt: null,
    participants: { library: { outcome: 'pending' } },
  });
  expect(
    (
      await f.db.admin.query(
        "SELECT 1 FROM access.erasure_acknowledgement WHERE route=$1 AND account_id=$2 AND participant='library'",
        [routeOf(accountId), accountId],
      )
    ).rows,
  ).toEqual([]);
  return results;
}

test('default native worker removes private sessions/history, labels, archives, pins and Collection children, retaining only immutable deidentified public contribution', async () => {
  const as = f.people.bob;
  const subjectId = await f.subject();
  const entry = (await f.json(as, 'PUT', `/v1/libraryEntries/${subjectId}`, 201, { state: 'planned' })).libraryEntry;
  // Actual retained clear, never a manually fabricated archive or sequence head.
  const clear = await f.request(
    as,
    'DELETE',
    `/v1/libraryEntries/${subjectId}?revision=${entry.revision}&incarnationId=${entry.incarnationId}`,
  );
  expect(clear.status).toBe(204);
  const actor = await f.kernel.testAccess.authenticate(as.bearer, { pool: f.db.pool, deadline: Date.now() + 5000 });
  const labels = createPersonalLabelCommands({ pool: f.db.pool, tokens: testTokens() });
  const label = (await labels.createLabel(actor, { name: 'private retained label' }, crypto.randomUUID())).value.label;
  const privateIds: string[] = [];
  for (const visibility of ['private', 'unlisted'] as const) {
    const collection = (
      await f.json(as, 'POST', '/v1/collections', 201, { title: `private ${visibility}`, visibility })
    ).collection;
    privateIds.push(collection.id);
    await f.json(as, 'POST', `/v1/collections/${collection.id}/members`, 201, { subjectId, note: 'private child' });
  }
  await f.json(as, 'PUT', `/v1/libraryPins/${privateIds[0]}`, 200, { revision: 0 });
  const publicCollection = (
    await f.json(as, 'POST', '/v1/collections', 201, {
      title: 'Completed public contribution',
      description: 'Frozen published meaning',
      visibility: 'public',
    })
  ).collection;
  const publicMember = (
    await f.json(as, 'POST', `/v1/collections/${publicCollection.id}/members`, 201, {
      subjectId,
      note: 'Completed public member',
    })
  ).member;
  const session = (
    await f.json(as, 'POST', '/v1/progressSessions', 201, {
      subjectId,
      mode: 'scalar_amount',
      unit: 'page',
      total: '500',
    })
  ).progressSession;
  await f.json(as, 'POST', `/v1/progressSessions/${session.id}/$record`, 200, {
    revision: session.revision,
    amount: '3',
  });
  const log = (
    await f.json(as, 'POST', '/v1/publishedLogs', 201, { sessionId: session.id, note: 'private progress snapshot' })
  ).publishedLog;
  const retirementKey = crypto.randomUUID();
  const retire = () =>
    f.kernel.handle(
      new Request(`http://kernel.test/v1/progressSessions/${session.id}/$retire`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${as.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(retirementKey),
        },
        body: JSON.stringify({ revision: 2 }),
      }),
    );
  expect((await retire()).status).toBe(200);
  expect((await f.request(as, 'GET', `/v1/progressSessions/${session.id}`)).status).toBe(404);
  const owner = [routeOf(as.accountId), as.accountId];
  for (const table of [
    'entry_deleted',
    'personal_label',
    'collection_pins',
    'progress_session',
    'progress_head',
    'published_log',
    'owner_write_counter',
    'fact_source_head',
  ])
    expect(
      (await f.db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND account_id=$2 LIMIT 1`, owner)).rows,
    ).toHaveLength(1);
  expect(
    (
      await f.db.admin.query('SELECT 1 FROM library.progress_change WHERE route=$1 AND session_id=$2 LIMIT 1', [
        owner[0],
        session.id,
      ])
    ).rows,
  ).toHaveLength(1);
  await deletePersona(f.options, as);
  expect((await retire()).status).toBe(401); // Terminal authority precedes the original receipt.
  expect((await f.request(as, 'POST', `/v1/progressSessions/${session.id}/$reopen`, { revision: 3 })).status).toBe(401);
  expect((await f.request(as, 'GET', `/v1/progressSessions/${session.id}`)).status).toBe(401);
  await f.start();
  const results = await terminal(as.accountId);
  expect(results.reduce((sum, result) => sum + result.owned.removed, 0)).toBeGreaterThan(10);
  for (const table of [
    'entry_deleted',
    'personal_label',
    'collection_pins',
    'progress_session',
    'progress_head',
    'published_log',
    'owner_write_counter',
    'fact_source_head',
  ])
    expect(
      (await f.db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND account_id=$2 LIMIT 1`, owner)).rows,
    ).toEqual([]);
  for (const table of ['progress_unit', 'progress_change'])
    expect(
      (
        await f.db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND session_id=$2 LIMIT 1`, [
          owner[0],
          session.id,
        ])
      ).rows,
    ).toEqual([]);
  for (const id of privateIds)
    for (const table of ['collection', 'collection_member', 'canonical_source_fact', 'canonical_source_state'])
      expect(
        (
          await f.db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND collection_id=$2 LIMIT 1`, [
            owner[0],
            id,
          ])
        ).rows,
      ).toEqual([]);
  for (const id of [...privateIds, publicCollection.id]) {
    expect(
      (
        await f.db.admin.query(
          'SELECT 1 FROM library.collection_listing_history WHERE route=$1 AND collection_id=$2 LIMIT 1',
          [owner[0], id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.db.admin.query(
          'SELECT 1 FROM library.canonical_source_fact WHERE route=$1 AND collection_id=$2 LIMIT 1',
          [owner[0], id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.db.admin.query(
          'SELECT 1 FROM library.canonical_source_state WHERE route=$1 AND collection_id=$2 LIMIT 1',
          [owner[0], id],
        )
      ).rows,
    ).toEqual([]);
  }
  expect(
    (
      await f.db.admin.query(
        'SELECT curator_account_id,title,description FROM library.collection WHERE route=$1 AND collection_id=$2',
        [owner[0], publicCollection.id],
      )
    ).rows,
  ).toEqual([{ curator_account_id: null, title: publicCollection.title, description: publicCollection.description }]);
  expect(
    (
      await f.db.admin.query(
        'SELECT subject_id,note FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
        [owner[0], publicCollection.id, publicMember.id],
      )
    ).rows,
  ).toEqual([{ subject_id: subjectId, note: 'Completed public member' }]);
  const publicRead = (await f.json(null, 'GET', `/v1/collections/${publicCollection.id}`, 200)).collection;
  expect(publicRead.curatorAccountId).toBeNull();
  expect(publicRead.title).toBe(publicCollection.title);
  expect((await f.request(null, 'GET', `/v1/publishedLogs/${log.id}`)).status).toBe(404);
  await expect(labels.readLabel(actor, label.id)).rejects.toMatchObject({ name: 'GrantDeniedError' });
  // Same-ID recovery uses committed native steps and cannot reopen the terminal record.
  const id = libraryErasureWorkflowId(as.accountId);
  const before = await f.client.retrieveWorkflow(id).getResult();
  const steps = await f.client.listWorkflowSteps(id);
  await f.client.resumeWorkflow(id, { queueName: 'workflows' });
  expect(await f.client.retrieveWorkflow(id).getResult()).toEqual(before);
  expect(await f.client.listWorkflowSteps(id)).toEqual(steps);
}, 90000);

test('native owned graph crosses its finite segment boundary, commits heads last and replays without recreating a private graph', async () => {
  const as = f.people.alice;
  const subjectId = await f.subject();
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const session = (
      await f.json(as, 'POST', '/v1/progressSessions', 201, { subjectId, mode: 'scalar_amount', unit: 'page' })
    ).progressSession;
    ids.push(session.id);
    await f.json(as, 'POST', `/v1/progressSessions/${session.id}/$record`, 200, {
      revision: session.revision,
      amount: '1',
    });
  }
  await deletePersona(f.options, as);
  expect(
    (await f.request(as, 'POST', `/v1/progressSessions/${ids[0]}/$record`, { revision: 2, amount: '2' })).status,
  ).toBe(401);
  const results = await terminal(as.accountId);
  expect(results.length).toBeGreaterThan(1);
  expect(results[0]!.owned.pages).toBe(100);
  const receipts = (
    await f.db.admin.query(
      `SELECT response,position FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
      AND command_kind='library.account-graph.purge' ORDER BY position LIMIT 300`,
      [partitionOf(routeOf(as.accountId)!), as.accountId],
    )
  ).rows;
  expect(receipts.length).toBe(results.reduce((sum, result) => sum + result.owned.pages, 0));
  for (const { response } of receipts) {
    expect(response.removed).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(512);
  }
  expect(receipts.at(-1)!.response.kind).toBe('fact_source_head');
  for (const id of ids)
    for (const table of ['progress_session', 'progress_unit', 'progress_change'])
      expect(
        (
          await f.db.admin.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND session_id=$2 LIMIT 1`, [
            routeOf(as.accountId),
            id,
          ])
        ).rows,
      ).toEqual([]);
  const root = libraryErasureWorkflowId(as.accountId);
  const before = await f.client.retrieveWorkflow(root).getResult();
  await f.client.enqueue(
    {
      workflowName: 'library.accountErasure',
      workflowID: root,
      workflowIDReusePolicy: 'return-existing',
      queueName: 'workflows',
    },
    as.accountId,
  );
  expect(await f.client.retrieveWorkflow(root).getResult()).toEqual(before);
  expect(
    (
      await f.db.admin.query('SELECT 1 FROM library.fact_source_head WHERE route=$1 AND account_id=$2', [
        routeOf(as.accountId),
        as.accountId,
      ])
    ).rows,
  ).toEqual([]);
}, 90000);

test('existing terminal runner retires released native capture children and final writer fences without a participant ACK or late hold recreation', async () => {
  const as = f.people.operator;
  const row = (
    await f.json(as, 'POST', '/v1/collections', 201, { title: 'Terminal native source', visibility: 'private' })
  ).collection;
  const route = routeOf(row.id)!;
  const work = () => ({
    deadline: Date.now() + 30000,
    allowance: {
      reservationId: crypto.randomUUID(),
      remaining: {
        candidateKeys: 100,
        nativeRows: 10000,
        nativePoints: 256,
        identityMetadataRows: 0,
        witnessKeys: 0,
        statements: 100,
        bytes: 1024 * 1024,
        emptySeeks: 100,
      },
    },
  });
  const metadata = await readNativeCollectionMetadata(f.db.pool, { route, collectionId: row.id }, work());
  if (!metadata.metadata) throw new Error('Missing native source');
  const identity: NativeSourceIdentity = {
    route,
    collectionId: row.id,
    accountId: as.accountId,
    incarnation: metadata.metadata.incarnation,
    generation: metadata.metadata.sourceGeneration,
    scope: 'curated',
    receivingEpoch: '1',
    effectKey: crypto.randomUUID(),
    ownerEpoch: (await f.db.pool.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [partitionOf(route)]))
      .rows[0].epoch,
  };
  const custody = createNativeLibrarySourceCustody({ pool: f.db.pool });
  let frontier: NativeSourceFrontier | null = null;
  for (let n = 0; n < 30; n++) {
    const page = await custody.capturePage({ ...work(), identity, frontier, limit: 100 });
    if (page.status !== 'pending') throw new Error('Native capture unavailable');
    frontier = page.frontier;
    if (frontier.driver === 'done') break;
  }
  if (!frontier || frontier.driver !== 'done') throw new Error('Finite capture did not complete');
  const completed = await custody.finishCapture({ ...work(), identity, frontier });
  if (completed.status !== 'complete') throw new Error('Missing native receipt');
  const captureId = completed.capture.captureId,
    holdId = crypto.randomUUID();
  for (const operation of ['readAndHold', 'releaseHold'] as const) {
    const result = await runCommand(f.db.pool, { partition: partitionOf(route) }, async (client, { time }) => ({
      value: await custody[operation]({ ...work(), client, at: time, identity, captureId, holdId }),
      events: [{ type: 'com.rezics.library.collection.updated.v1', data: { collectionId: row.id } }],
    }));
    expect(result.value.status).toBe(operation === 'readAndHold' ? 'held' : 'released');
  }
  await deletePersona(f.options, as);
  await terminal(as.accountId);
  for (const table of ['native_source_capture', 'native_source_receipt', 'native_source_hold'])
    expect(
      (await f.db.pool.query(`SELECT 1 FROM library.${table} WHERE route=$1 AND capture_id=$2`, [route, captureId]))
        .rows,
    ).toEqual([]);
  expect(
    (
      await f.db.pool.query('SELECT 1 FROM library.native_source_fence WHERE route=$1 AND account_id=$2', [
        route,
        as.accountId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (await f.db.pool.query('SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2', [route, row.id]))
      .rows,
  ).toEqual([]);
  const late = await runCommand(f.db.pool, { partition: partitionOf(route) }, async (client, { time }) => ({
    value: await custody.readAndHold({ ...work(), client, at: time, identity, captureId, holdId: crypto.randomUUID() }),
    events: [{ type: 'com.rezics.library.collection.updated.v1', data: { collectionId: row.id } }],
  }));
  expect(late.value.status).toBe('unavailable');
  expect(
    (
      await f.db.pool.query('SELECT 1 FROM library.native_source_fence WHERE route=$1 AND account_id=$2', [
        route,
        as.accountId,
      ])
    ).rows,
  ).toEqual([]);
}, 90000);
