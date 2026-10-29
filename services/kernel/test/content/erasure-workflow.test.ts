import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { Pool } from 'pg';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { runCommand, type AuthoritativeTime, type CommandTransaction } from '../../src/command/command.ts';
import { erasePostLogical } from '../../src/content/erase-post.ts';
import { runAuthorErasure } from '../../src/content/erasure-workflow.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
import { beginAuthorErasure } from '../../src/content/operations.ts';
import type { OperationProgress } from '../../src/content/operation-contract.ts';
import { contentWorkWorkflowId } from '../../src/content/work-contract.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

let fixture: Awaited<ReturnType<typeof standingFixture>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let work: Awaited<ReturnType<typeof composeWork>>;
let systemPool: Pool;
let measuredPool: Pool | undefined;
// One entry per prepared page and one per page formula statement, in call order.
const pagePrepares: { ids: readonly string[] }[] = [];
const pageChecks: { ids: readonly string[]; time: AuthoritativeTime | undefined }[] = [];
const crashes = new Map<string, string[]>();
const route = 0x6798;
const partition = partitionOf(route);
const routeKey = new Uint8Array(32).fill(7);
const context = () => ({
  deadline: Date.now() + 10_000,
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
});

beforeAll(async () => {
  fixture = await standingFixture(['account:read']);
  const preparePage = fixture.access.preparePage!.bind(fixture.access);
  fixture.access.preparePage = async (actor, action, page, context) => {
    if (action === 'post:erase') pagePrepares.push({ ids: page.ids });
    return preparePage(actor, action, page, context);
  };
  const authorizePage = fixture.access.authorizePage!.bind(fixture.access);
  fixture.access.authorizePage = async (tx, actor, action, page, evidence, time) => {
    if (action === 'post:erase') pageChecks.push({ ids: page.ids, time });
    return authorizePage(tx, actor, action, page, evidence, time);
  };
  systemPool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 10 });
  client = await createWorkClient(process.env.DATABASE_URL!);
  work = await composeWork(
    [
      {
        name: 'erasure-test',
        register() {
          DBOS.registerWorkflow(
            async (operationId: string, pauseAfter?: string) =>
              runAuthorErasure(
                {
                  pool: measuredPool ?? systemPool,
                  access: fixture.access,
                  readConsent: fixture.readConsent,
                  currentTime: () => new Date(),
                  durableStep: async (name, action) => {
                    if (name === pauseAfter && name.includes(':revisions:')) {
                      await DBOS.setEvent('barrier', name);
                      expect(await DBOS.recv('continue', 30)).toBe(true);
                    }
                    const value = await DBOS.runStep(
                      async () => {
                        const result = await action();
                        const revoke = crashes.get(name);
                        if (revoke) {
                          crashes.delete(name);
                          await fixture.reader.query(
                            "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=ANY($2::uuid[]) AND action='post:erase'",
                            [route, revoke],
                          );
                          throw new Error('Commit completed before the native step checkpoint');
                        }
                        return result;
                      },
                      { name, retriesAllowed: true, maxAttempts: 2, intervalSeconds: 0.001 },
                    );
                    if (name === pauseAfter && !name.includes(':revisions:')) {
                      await DBOS.setEvent('barrier', name);
                      expect(await DBOS.recv('continue', 30)).toBe(true);
                    }
                    return value;
                  },
                  checkpoint: {
                    // A zero timeout reads again whenever the first read returns within the same millisecond, so the
                    // statement count varies from run to run. A deadline already past makes the read exactly once.
                    read: (id) => DBOS.getEvent<OperationProgress>(id, 'progress', -1),
                    write: (_id, progress) => DBOS.setEvent('progress', progress),
                  },
                },
                operationId,
              ),
            { name: 'content.authorErase' },
          );
        },
      },
    ],
    { databaseUrl: process.env.DATABASE_URL!, pool: systemPool, client },
  );
  await work.launch();
});

afterAll(async () => {
  await work?.shutdown();
  await client?.close();
  await systemPool?.end();
  await fixture?.close();
});

async function scope(posts: number, revisions = 1, accountId = fixture.actor) {
  const actor = (await fixture.context(accountId)).actor;
  const body = Buffer.from(serializeDocument(fromPlainText('Private historical text')));
  const threadId = newId(route);
  const boardId = newId(route);
  const ids = Array.from({ length: posts }, () => newId(route)).sort();
  const at = '2026-01-01T00:00:00.000000Z';
  const tx = await fixture.reader.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      `INSERT INTO content.thread
       (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,'Erasure fixture','published',1,$2)`,
      [route, threadId, actor.accountId, boardId],
    );
    const heads = ids.map(() => newId(route));
    await tx.query(
      `INSERT INTO content.post
       (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,
        recorded_transaction_id,created_at)
       SELECT $1,$2,p.post_id,$3,p.head_revision_id,'published',1,p.post_id,$4
       FROM unnest($5::uuid[],$6::uuid[]) AS p(post_id,head_revision_id)`,
      [route, threadId, actor.accountId, at, ids, heads],
    );
    const owners = ids.flatMap((id) => Array.from({ length: revisions }, () => id));
    const revisionIds = ids.flatMap((_, post) =>
      Array.from({ length: revisions }, (_, index) => (index === 0 ? heads[post]! : newId(route))),
    );
    await tx.query(
      `INSERT INTO content.revision
       (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,
        board_id,availability,recorded_transaction_id,recorded_at)
       SELECT $1,$2,r.post_id,r.revision_id,$3,sha256($3),'Private historical text','MIT','{}',$4,'available',
              r.post_id,$5
       FROM unnest($6::uuid[],$7::uuid[]) AS r(post_id,revision_id)`,
      [route, threadId, body, boardId, at, owners, revisionIds],
    );
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  await fixture.grant(actor.accountId, 'account:read', {
    route: routeOf(actor.accountId)!,
    id: actor.accountId,
  });
  await fixture.reader.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
     SELECT $1,g.id,$2,'post:erase','(,)'::tstzrange,g.id FROM unnest($3::uuid[]) AS g(id)
     ON CONFLICT DO NOTHING`,
    [route, actor.accountId, ids],
  );
  return { actor, threadId, ids, at };
}

test('production Access requires native identity evidence even when a persisted snapshot matches a live actor', async () => {
  const selected = await scope(2);
  const deps = { pool: fixture.pool, access: fixture.access, routeKey };
  // Positive control: the real Auth-issued actor and actual native point command work.
  expect(
    (await erasePostLogical(deps, selected.actor, { postId: selected.ids[0]!, reason: 'Erase' }, context())).value
      .postId,
  ).toBe(selected.ids[0]!);
  // A database snapshot has the same fields but no Access factory's private evidence.
  // The workflow needs an Accounts-owned restoration port; it cannot register JSON as authority.
  const snapshot = structuredClone(selected.actor);
  expect(snapshot).toEqual(selected.actor);
  await expect(
    erasePostLogical(deps, snapshot, { postId: selected.ids[1]!, reason: 'Erase' }, context()),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(
    (
      await fixture.reader.query('SELECT availability FROM content.post WHERE route=$1 AND post_id=$2', [
        route,
        selected.ids[1],
      ])
    ).rows,
  ).toEqual([{ availability: 'available' }]);
});

test('native initiation commits the provenance receipt required by durable initiator restoration', async () => {
  const selected = await scope(1);
  const request = context();
  const result = await beginAuthorErasure(
    {
      pool: fixture.pool,
      access: fixture.access,
      clock: () => new Date(),
      workflows: {
        async enqueue() {
          throw new Error('Initiation must publish its native source before enqueue');
        },
        async status() {
          throw new Error('Initiation must not read workflow status');
        },
      },
    },
    selected.actor,
    { threadId: selected.threadId, authorId: selected.actor.accountId },
    request,
  );
  const receipt = await fixture.reader.query<{ response: { operationId: string; durableInitiator?: string } }>(
    `SELECT response FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind='content.author-erasure' AND idempotency_key=$3`,
    [partition, selected.actor.accountId, request.idempotencyKey],
  );
  expect(receipt.rows).toHaveLength(1);
  expect(receipt.rows[0]!.response.operationId).toBe(result.value.operationId);
  // The Accounts helper independently checks this creation-time commitment.
  // A workflow reader cannot add it later or reconstruct original snapshots.
  expect(receipt.rows[0]!.response.durableInitiator).toMatch(/^[0-9a-f]{64}$/);
});

test('the content initiator reader accepts only the committed operation source and creation receipt', async () => {
  const { readErasureInitiator } = await import('../../src/content/erasure-initiator.ts');
  const { durableInitiatorCommitment } = await import('../../src/access/durable-initiator-capture.ts');
  async function inspect<T>(read: (tx: CommandTransaction, time: AuthoritativeTime) => Promise<T>) {
    let value!: T;
    const complete = new Error('Read complete; roll back without publishing an event');
    try {
      await runCommand(fixture.pool, { partition }, async (tx, { time }) => {
        value = await read(tx, time);
        throw complete;
      });
    } catch (error) {
      if (error !== complete) throw error;
    }
    return { value };
  }
  const selected = await scope(1);
  const request = context();
  const created = await beginAuthorErasure(
    {
      pool: fixture.pool,
      access: fixture.access,
      clock: () => new Date(),
      workflows: {
        async enqueue() {
          throw new Error('Only the durable relay may enqueue');
        },
        async status() {
          throw new Error('No status read during initiation');
        },
      },
    },
    selected.actor,
    { threadId: selected.threadId, authorId: selected.actor.accountId },
    request,
  );
  const operation = {
    route,
    id: created.value.operationId,
    kind: 'content.author-erasure',
    sourceId: created.value.operationId,
  };
  const observed = await inspect(async (tx, time) => {
    const record = await readErasureInitiator(tx, operation, time);
    expect(await readErasureInitiator(tx, { ...operation, sourceId: newId(route) }, time)).toBeNull();
    expect(await readErasureInitiator(tx, { ...operation, kind: 'content.other' }, time)).toBeNull();
    return record;
  });
  expect(observed.value).toMatchObject({
    operation,
    initiatorAccountId: selected.actor.accountId,
    actor: selected.actor,
    recordedTransactionId: created.transactionId,
    originalAccount: { minimumAuthnEpoch: '1', operatorAccountId: null },
    originalDelegation: null,
    creation: {
      commandKind: operation.kind,
      idempotencyKey: request.idempotencyKey,
      target: { route, id: selected.ids[0]! },
    },
  });
  const receipt = await fixture.reader.query(
    `SELECT response FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind='content.author-erasure' AND idempotency_key=$3`,
    [partition, selected.actor.accountId, request.idempotencyKey],
  );
  expect(durableInitiatorCommitment(observed.value!)).toBe(receipt.rows[0].response.durableInitiator);
  const copiedId = newId(route);
  await fixture.reader.query(
    `INSERT INTO content.operation
     (route,operation_id,initiator_account_id,author_account_id,thread_id,anchor_post_id,actor_kind,actor_account_id,
      actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,empty_scope,upper_created_at,
      upper_post_id,requested_at,recorded_transaction_id)
     SELECT route,$3,initiator_account_id,author_account_id,thread_id,anchor_post_id,actor_kind,actor_account_id,
       actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,empty_scope,upper_created_at,
       upper_post_id,requested_at,recorded_transaction_id
     FROM content.operation WHERE route=$1 AND operation_id=$2`,
    [route, operation.id, copiedId],
  );
  await inspect(async (tx, time) => {
    expect(await readErasureInitiator(tx, { ...operation, id: copiedId, sourceId: copiedId }, time)).toBeNull();
  });
});

test('native workflow resolves persisted initiating identity and physically completes more than two post pages', async () => {
  const selected = await scope(201, 3);
  const source = await beginAuthorErasure(
    {
      pool: fixture.pool,
      access: fixture.access,
      clock: () => new Date(),
      workflows: {
        async enqueue() {
          throw new Error('Only the durable relay may enqueue');
        },
        async status() {
          throw new Error('No status read during initiation');
        },
      },
    },
    selected.actor,
    { threadId: selected.threadId, authorId: selected.actor.accountId },
    context(),
  );
  const operationId = source.value.operationId;
  let envelope: Envelope | undefined;
  const read = await readBatch(fixture.pool, {
    partition,
    consumer: 'erasure_workflow_test',
    apply: async (envelopes) => {
      envelope = envelopes.find((item) => item.position === source.position);
    },
  });
  expect(read.status).toBe('read');
  expect(envelope).toBeDefined();
  const tx = await fixture.pool.connect();
  try {
    await tx.query('BEGIN');
    await readPartition(tx, partition);
    await bindAuthorErasureWorkflow(tx, operationId, envelope!, 0);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  const workflowId = contentWorkWorkflowId(source, 0, 'authorErase', operationId);
  const handle = await client.enqueue(
    { workflowName: 'content.authorErase', queueName: 'governance', workflowID: workflowId },
    operationId,
  );
  expect(await handle.getResult()).toEqual({ processedPosts: 201, erasedRevisions: 603 });
  expect((await handle.getStatus())?.status).toBe('SUCCESS');
  expect(await client.getEvent<OperationProgress>(workflowId, 'progress', 0)).toMatchObject({
    processedPosts: 201,
    erasedRevisions: 603,
    steps: 3,
  });
  const result = await fixture.reader.query(
    `SELECT p.availability, r.body, r.search_text, r.availability AS revision_availability, r.licence
     FROM content.post p JOIN content.revision r ON r.route=p.route AND r.post_id=p.post_id
     WHERE p.route=$1 AND p.thread_id=$2`,
    [route, selected.threadId],
  );
  expect(result.rows).toHaveLength(603);
  for (const row of result.rows)
    expect(row).toEqual({
      availability: 'erased',
      body: null,
      search_text: null,
      revision_availability: 'erased',
      licence: 'MIT',
    });
});

async function launchSelection(
  selected: Awaited<ReturnType<typeof scope>>,
  pause: false | 'logical' | 'cleanup' = false,
  crash = false,
) {
  // Each launch is a new authenticated request, including growth runs after seeding.
  const actor = (await fixture.context(selected.actor.accountId)).actor;
  const source = await beginAuthorErasure(
    {
      pool: fixture.pool,
      access: fixture.access,
      clock: () => new Date(),
      workflows: {
        async enqueue() {
          throw new Error('Only the durable relay may enqueue');
        },
        async status() {
          throw new Error('No status read during initiation');
        },
      },
    },
    actor,
    { threadId: selected.threadId, authorId: selected.actor.accountId },
    context(),
  );
  let envelope: Envelope | undefined;
  const consumer = `erasure_${crypto.randomUUID().replaceAll('-', '')}`;
  while (!envelope) {
    const batch = await readBatch(fixture.pool, {
      partition,
      consumer,
      apply: async (envelopes) => {
        envelope = envelopes.find((item) => item.position === source.position);
      },
    });
    if (batch.status !== 'read') break;
  }
  expect(envelope).toBeDefined();
  const tx = await fixture.pool.connect();
  try {
    await tx.query('BEGIN');
    await readPartition(tx, partition);
    await bindAuthorErasureWorkflow(tx, source.value.operationId, envelope!, 0);
    await tx.query('COMMIT');
  } finally {
    tx.release();
  }
  const workflowId = contentWorkWorkflowId(source, 0, 'authorErase', source.value.operationId);
  const logical = `wf:${source.value.operationId}:erase:-infinity:${source.value.operationId}`;
  const barrier =
    pause === 'cleanup'
      ? `wf:${source.value.operationId}:revisions:${selected.ids[0]}:-infinity:${selected.ids[0]}`
      : logical;
  if (crash) crashes.set(logical, selected.ids.slice(0, 100));
  // Initiation has its own T; observe only the workflow's logical commands.
  pagePrepares.length = 0;
  pageChecks.length = 0;
  const handle = await client.enqueue(
    { workflowName: 'content.authorErase', queueName: 'governance', workflowID: workflowId },
    source.value.operationId,
    pause ? barrier : undefined,
  );
  if (pause) expect(await client.getEvent(workflowId, 'barrier', 30)).toBe(barrier);
  return { handle, workflowId, operationId: source.value.operationId };
}

test('author erasure deletes account notices and its seen marker through bounded pages', async () => {
  const selected = await scope(1);
  const accountId = selected.actor.accountId;
  const accountRoute = routeOf(accountId)!;
  const ids = Array.from({ length: 2001 }, () => newId(accountRoute));
  await fixture.reader.query(
    `INSERT INTO content.notice (route, recipient_id, notice_id, kind, source_id, created_at)
     SELECT $1, $2, notice_id, 'reply', notice_id, now()
     FROM unnest($3::uuid[]) AS seeded(notice_id)`,
    [accountRoute, accountId, ids],
  );
  const seenNoticeId = newId(accountRoute);
  await fixture.reader.query(
    `INSERT INTO content.notice_seen (route, account_id, seen_notice_id, seen_at)
     VALUES ($1, $2, $3, now())`,
    [accountRoute, accountId, seenNoticeId],
  );

  const trace = observeSql(systemPool);
  try {
    const { handle } = await launchSelection(selected);
    expect(await handle.getResult()).toEqual({ processedPosts: 1, erasedRevisions: 1 });
  } finally {
    await trace.close();
  }
  expect(
    trace.records.filter((record) => /DELETE FROM content\.notice AS notice/i.test(record.statement)),
  ).toHaveLength(3);
  expect(trace.records.filter((record) => /DELETE FROM content\.notice_seen/i.test(record.statement))).toHaveLength(1);

  const notices = await fixture.reader.query(
    'SELECT notice_id FROM content.notice WHERE route = $1 AND recipient_id = $2',
    [accountRoute, accountId],
  );
  const seen = await fixture.reader.query(
    'SELECT account_id FROM content.notice_seen WHERE route = $1 AND account_id = $2',
    [accountRoute, accountId],
  );
  expect(notices.rows).toHaveLength(0);
  expect(seen.rows).toHaveLength(0);
  await fixture.reader.query('TRUNCATE TABLE content.notice_seen, content.notice');
});

for (const revocation of ['grant', 'consent'] as const) {
  test(`native ${revocation} revocation at the logical step barrier preserves cleanup and stops later posts`, async () => {
    const selected = await scope(102, 3, revocation === 'consent' ? fixture.recipient : fixture.actor);
    const started = await launchSelection(selected, 'logical');
    expect(
      (
        await fixture.reader.query('SELECT availability FROM content.post WHERE route=$1 AND post_id=$2', [
          route,
          selected.ids[0],
        ])
      ).rows,
    ).toEqual([{ availability: 'erased' }]);
    expect(
      (
        await fixture.reader.query(
          'SELECT body IS NOT NULL AS retained FROM content.revision WHERE route=$1 AND post_id=$2',
          [route, selected.ids[0]],
        )
      ).rows.every((row) => row.retained),
    ).toBe(true);
    if (revocation === 'grant') {
      await fixture.reader.query(
        "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=ANY($2::uuid[]) AND subject_id=$3 AND action='post:erase'",
        [route, selected.ids, selected.actor.accountId],
      );
    } else {
      // Auth owns the current consent fact. Use a separate real connection to
      // its own database, never a replacement reader or persisted scope ceiling.
      const { Pool } = await import('pg');
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/standing_auth_${process.pid}`;
      const auth = new Pool({ connectionString: url.toString() });
      try {
        await auth.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
          selected.actor.accountId,
          selected.actor.clientId,
        ]);
      } finally {
        await auth.end();
      }
      expect(
        await fixture.readConsent({
          actorAccountId: selected.actor.accountId,
          clientId: selected.actor.clientId,
          deadline: Date.now() + 5000,
        }),
      ).toBeNull();
    }
    await client.send(started.workflowId, true, 'continue');
    await expect(started.handle.getResult()).rejects.toMatchObject({ code: 7 });
    expect((await started.handle.getStatus())?.status).toBe('ERROR');
    expect(await client.getEvent(started.workflowId, 'progress', 0)).toMatchObject({
      processedPosts: 100,
      erasedRevisions: 300,
      steps: 2,
    });
    expect(
      (
        await fixture.reader.query(
          'SELECT body, search_text, availability FROM content.revision WHERE route=$1 AND post_id=$2',
          [route, selected.ids[0]],
        )
      ).rows.every((row) => row.body === null && row.search_text === null && row.availability === 'erased'),
    ).toBe(true);
    expect(
      (
        await fixture.reader.query('SELECT availability FROM content.post WHERE route=$1 AND post_id=ANY($2::uuid[])', [
          route,
          selected.ids.slice(100),
        ])
      ).rows,
    ).toEqual([{ availability: 'available' }, { availability: 'available' }]);
  });
}

test('all logical pages commit before cleanup, with one command and T per page and final counters already published', async () => {
  const selected = await scope(205, 3);
  const started = await launchSelection(selected, 'cleanup');
  try {
    expect(await client.getEvent(started.workflowId, 'progress', 0)).toEqual({
      processedPosts: 205,
      erasedRevisions: 615,
      steps: 3,
    });
    const posts = await fixture.reader.query(
      'SELECT availability, security_revision FROM content.post WHERE route=$1 AND post_id=ANY($2::uuid[])',
      [route, selected.ids],
    );
    expect(posts.rows).toHaveLength(205);
    expect(posts.rows.every((row) => row.availability === 'erased' && row.security_revision === '2')).toBe(true);
    const retained = await fixture.reader.query(
      'SELECT count(*)::int AS n FROM content.revision WHERE route=$1 AND post_id=ANY($2::uuid[]) AND body IS NOT NULL',
      [route, selected.ids],
    );
    expect(retained.rows[0].n).toBe(615);
    for (let start = 0; start < selected.ids.length; start += 100) {
      const page = selected.ids.slice(start, start + 100);
      // Whatever the page size, Access prepares once and evaluates one formula statement for the whole page.
      const prepared = pagePrepares.filter((entry) => entry.ids.some((id) => page.includes(id)));
      const observed = pageChecks.filter((entry) => entry.ids.some((id) => page.includes(id)));
      expect(prepared.map((entry) => [...entry.ids])).toEqual([[...page].sort()]);
      expect(observed.map((entry) => [...entry.ids])).toEqual([[...page].sort()]);
      expect(observed[0]!.time).toBeDefined();
      const events = await fixture.reader.query(
        `SELECT count(*)::int AS n, count(DISTINCT position)::int AS commands
         FROM core.outbox WHERE partition_no=$1 AND type='com.rezics.content.post.erased.v1'
           AND data->>'postId'=ANY($2::text[])`,
        [partition, page],
      );
      expect(events.rows).toEqual([{ n: page.length, commands: 1 }]);
    }
    const receipts = await fixture.reader.query(
      "SELECT response FROM core.receipt WHERE partition_no=$1 AND command_kind='content.author-erasure.page' AND idempotency_key LIKE $2",
      [partition, `wf:${started.operationId}:erase:%`],
    );
    expect(receipts.rows.map((row) => row.response.processedPosts).sort((a, b) => a - b)).toEqual([5, 100, 100]);
  } finally {
    await client.send(started.workflowId, true, 'continue');
  }
  expect(await started.handle.getResult()).toEqual({ processedPosts: 205, erasedRevisions: 615 });
  expect(await client.getEvent(started.workflowId, 'progress', 0)).toEqual({
    processedPosts: 205,
    erasedRevisions: 615,
    steps: 3,
  });
});

test('a denial on the last post rolls back the whole logical page', async () => {
  const selected = await scope(100, 3);
  await fixture.reader.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='post:erase'",
    [route, selected.ids.at(-1)],
  );
  const started = await launchSelection(selected);
  await expect(started.handle.getResult()).rejects.toMatchObject({ code: 7 });
  expect(await client.getEvent(started.workflowId, 'progress', 0)).toEqual({
    processedPosts: 0,
    erasedRevisions: 0,
    steps: 1,
  });
  const posts = await fixture.reader.query(
    'SELECT availability FROM content.post WHERE route=$1 AND post_id=ANY($2::uuid[])',
    [route, selected.ids],
  );
  expect(posts.rows.every((row) => row.availability === 'available')).toBe(true);
  const revisions = await fixture.reader.query(
    'SELECT body FROM content.revision WHERE route=$1 AND post_id=ANY($2::uuid[])',
    [route, selected.ids],
  );
  expect(revisions.rows.every((row) => row.body !== null)).toBe(true);
});

test('a committed logical page survives denied replay before its DBOS checkpoint and continues later pages', async () => {
  const selected = await scope(102, 3);
  const started = await launchSelection(selected, false, true);
  expect(await started.handle.getResult()).toEqual({ processedPosts: 102, erasedRevisions: 306 });
  expect(await client.getEvent(started.workflowId, 'progress', 0)).toEqual({
    processedPosts: 102,
    erasedRevisions: 306,
    steps: 2,
  });
  const revisions = await fixture.reader.query(
    'SELECT body FROM content.revision WHERE route=$1 AND post_id=ANY($2::uuid[])',
    [route, selected.ids],
  );
  expect(revisions.rows.every((row) => row.body === null)).toBe(true);
});

test('every measured revision erasure is a HOT update while another backend holds a snapshot', async () => {
  const { checkGrowth, openGrowthDatabase } = await import('../support/growth.ts');
  const { nullErasedRevisionPage } = await import('../../src/content/erasure-workflow.ts');
  const db = await openGrowthDatabase();
  const rollback = new Error('Rollback measured cleanup');
  let snapshot: import('pg').PoolClient | undefined;
  const values = new Map<number, Awaited<ReturnType<typeof scope>>>();
  const hotUpdates: { scale: number; updated: number; hot: number }[] = [];
  const check = {
    name: 'affected erasure revisions',
    scales: [1, 8, 64] as const,
    warmups: 1,
    repetitions: 5,
    bounds: { rows: 'linear' as const, statements: 'constant' as const, blocks: 'linear' as const },
  };
  const runsPerScale = (check.warmups ?? 1) + (check.repetitions ?? 5);
  let nextRepetition = 0;
  async function closeSnapshot(): Promise<void> {
    if (!snapshot) return;
    const current = snapshot;
    snapshot = undefined;
    try {
      await current.query('ROLLBACK');
    } finally {
      current.release();
    }
  }
  async function eraseRun(target: typeof db, scale: number, repetition: number, measured: boolean): Promise<void> {
    const value = values.get(repetition)!;
    try {
      await runCommand(target.pool, { partition }, async (tx) => {
        const before = measured
          ? await tx.query<{ updated: string; hot: string }>(
              `SELECT pg_stat_get_xact_tuples_updated('content.revision'::regclass) AS updated,
                      pg_stat_get_xact_tuples_hot_updated('content.revision'::regclass) AS hot`,
            )
          : undefined;
        expect(
          await nullErasedRevisionPage(tx, {
            route,
            post_id: value.ids[0]!,
            after_at: '-infinity',
            after_id: value.ids[0]!,
          }),
        ).toHaveLength(scale);
        if (measured) {
          const counts = await tx.query<{ updated: string; hot: string }>(
            `SELECT pg_stat_get_xact_tuples_updated('content.revision'::regclass) AS updated,
                    pg_stat_get_xact_tuples_hot_updated('content.revision'::regclass) AS hot`,
          );
          const count = counts.rows[0]!;
          const updated = Number(count.updated) - Number(before!.rows[0]!.updated);
          const hot = Number(count.hot) - Number(before!.rows[0]!.hot);
          if (updated !== scale || hot !== updated)
            throw new Error(`Revision erasure was not entirely HOT: updated=${updated}, hot=${hot}`);
          hotUpdates.push({ scale, updated, hot });
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
  try {
    const report = await checkGrowth(db, {
      ...check,
      async grow(_target, scale) {
        await closeSnapshot();
        for (let run = 0; run < runsPerScale; run++) {
          const value = await scope(1, scale);
          await erasePostLogical(
            { pool: fixture.pool, access: fixture.access, routeKey },
            value.actor,
            { postId: value.ids[0]!, reason: 'Erase' },
            context(),
          );
          values.set(nextRepetition++, value);
        }
      },
      async warmup(target, scale, repetition) {
        await eraseRun(target, scale, repetition, false);
      },
      async prepare(target) {
        snapshot = await target.admin.connect();
        await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await snapshot.query('SELECT count(*) FROM content.revision');
      },
      async operation(target, scale, repetition) {
        try {
          await eraseRun(target, scale, repetition, true);
        } finally {
          await closeSnapshot();
        }
      },
    });
    expect(report.samples.every((sample) => sample.cost.rows > 0 && sample.cost.blocks > 0)).toBe(true);
    console.info('Revision erasure HOT updates under snapshot', JSON.stringify(hotUpdates));
    console.info('Affected erasure growth', JSON.stringify(report.samples));
  } finally {
    await closeSnapshot();
    await db.close();
  }
});

test('checkGrowth proves fixed native erasure pages against unrelated and same-partition history', async () => {
  const { checkGrowth, openGrowthDatabase, seed } = await import('../support/growth.ts');
  const { pageAuthorErasurePosts, nullErasedRevisionPage, eraseRevisionMedia } =
    await import('../../src/content/erasure-workflow.ts');
  const db = await openGrowthDatabase();
  const population = {
    name: 'erasure-history',
    hotPartition: partition,
    rows({ route: seededRoute, ordinal }: { route: number; ordinal: number }) {
      const thread = newId(seededRoute),
        post = newId(seededRoute),
        revision = newId(seededRoute);
      const media = newId(seededRoute),
        author = newId(0x1234),
        board = newId(seededRoute);
      const body = Buffer.from(serializeDocument(fromPlainText('Unrelated history')));
      return {
        'content.thread': [
          {
            route: seededRoute,
            thread_id: thread,
            board_id: board,
            author_account_id: author,
            title: 'Unrelated',
            security_revision: 1,
            visibility: 'published',
            recorded_transaction_id: thread,
          },
        ],
        'content.post': [
          {
            route: seededRoute,
            thread_id: thread,
            post_id: post,
            author_account_id: author,
            head_revision_id: revision,
            security_revision: 1,
            visibility: 'published',
            recorded_transaction_id: post,
          },
        ],
        'content.revision': [
          {
            route: seededRoute,
            thread_id: thread,
            post_id: post,
            revision_id: revision,
            body,
            body_sha256: new Bun.CryptoHasher('sha256').update(body).digest(),
            search_text: 'Unrelated',
            licence: 'MIT',
            subject_ids: [],
            board_id: board,
            availability: 'available',
            recorded_transaction_id: post,
          },
        ],
        'content.media': [
          {
            route: seededRoute,
            media_id: media,
            container_id: thread,
            uploader_id: author,
            reservation_request_id: `seed-${ordinal}`,
            purpose: 'post-image',
            media_type: 'image/png',
            byte_count: 256,
            state: 'reserved',
            key: `m/${media}/original`,
            transaction_id: media,
          },
        ],
      };
    },
  };
  const rollback = new Error('Rollback measured cleanup');
  try {
    const fixedOptions = {
      name: 'native content erasure pages',
      scales: [32, 256, 2048] as const,
      warmups: 1,
      repetitions: 5,
      bounds: { rows: 'constant' as const, statements: 'constant' as const, blocks: 'logarithmic' as const },
    };
    const fixedRunsPerScale = (fixedOptions.warmups ?? 1) + (fixedOptions.repetitions ?? 5);
    const fixedScopes = new Map<number, Awaited<ReturnType<typeof scope>>>();
    let nextFixedRepetition = 0;
    const report = await checkGrowth(db, {
      ...fixedOptions,
      async grow(target, scale, previous) {
        await seed(target, population, { from: previous, to: scale });
        for (let run = 0; run < fixedRunsPerScale; run++) {
          const value = await scope(1, 100);
          await erasePostLogical(
            { pool: fixture.pool, access: fixture.access, routeKey },
            value.actor,
            { postId: value.ids[0]!, reason: 'Erase' },
            context(),
          );
          fixedScopes.set(nextFixedRepetition++, value);
        }
      },
      async operation(target, _scale, repetition) {
        const selected = fixedScopes.get(repetition)!;
        try {
          await runCommand(target.pool, { partition }, async (tx) => {
            const posts = await pageAuthorErasurePosts(tx, {
              route,
              partition_no: partition,
              operation_id: selected.threadId,
              initiator_id: selected.actor.accountId,
              thread_id: selected.threadId,
              author_id: selected.actor.accountId,
              after_at: '-infinity',
              after_id: selected.threadId,
              upper_at: selected.at,
              upper_id: selected.ids[0]!,
            });
            expect(posts.map((post) => post.post_id)).toEqual(selected.ids);
            const revisions = await nullErasedRevisionPage(tx, {
              route,
              post_id: selected.ids[0]!,
              after_at: '-infinity',
              after_id: selected.ids[0]!,
            });
            expect(revisions).toHaveLength(100);
            expect(
              await eraseRevisionMedia(tx, {
                route,
                post_id: selected.ids[0]!,
                revision_id: revisions[0]!.revision_id,
              }),
            ).toEqual([]);
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
      },
    });
    expect(report.samples.every((sample) => sample.cost.rows > 0 && sample.cost.blocks > 0)).toBe(true);
    console.info('Native erasure growth', JSON.stringify(report.samples));
  } finally {
    await db.close();
  }
});

test('checkGrowth fixes a 205-post author while other authors grow in the same partition', async () => {
  const { checkGrowth, openGrowthDatabase, seed } = await import('../support/growth.ts');
  const db = await openGrowthDatabase();
  let selected: Awaited<ReturnType<typeof scope>>;
  let spare: Awaited<ReturnType<typeof scope>>;
  let paused: Awaited<ReturnType<typeof launchSelection>> | undefined;
  let sparePaused: Awaited<ReturnType<typeof launchSelection>> | undefined;
  async function finish(run: Awaited<ReturnType<typeof launchSelection>> | undefined): Promise<void> {
    if (!run) return;
    await client.send(run.workflowId, true, 'continue');
    await run.handle.getResult();
  }
  try {
    measuredPool = db.pool;
    const report = await checkGrowth(db, {
      name: 'native logical author page',
      rule: 'series',
      // Native author erasure Cost: operation source/restoration, page seek and
      // anchor validation; 100 post validations, revision-prefix counts and
      // tombstones; Access P/Q adds account/inverse preparation and, per post,
      // direct/active-account grants, active-account roles and identity denial,
      // plus seven Global formula descents shared by the page.
      indexProbes: 2 + 1 + 1 + 100 * (1 + 1 + 1 + 5) + 7 + 3,
      scales: [256, 1024, 4096],
      repetitions: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(target, scale, previous) {
        await finish(paused);
        paused = undefined;
        // Logical erasure is irreversible. Each sample gets a fresh author with
        // the same 205-post, three-revision shape outside the measured boundary.
        // The warm-up author is seeded the same way and erased before the sample.
        selected = await scope(205, 3);
        spare = await scope(205, 3, fixture.principal);
        await seed(
          target,
          {
            name: 'other authors in logical page partition',
            hotPartition: partition,
            hotShare: 1,
            rows() {
              const postId = newId(route);
              const head = newId(route);
              const noiseAccount = newId(routeOf(selected.actor.accountId)!);
              const body = Buffer.from(serializeDocument(fromPlainText('Other author revision')));
              return {
                'access.account': [
                  {
                    route: routeOf(noiseAccount),
                    account_id: noiseAccount,
                    kind: 'actor',
                    state: 'active',
                    transaction_id: noiseAccount,
                  },
                ],
                'access.membership_inverse': [
                  {
                    route: routeOf(noiseAccount),
                    account_id: noiseAccount,
                    kind: 'organization',
                    group_id: newId(route),
                    reservation_id: noiseAccount,
                    transaction_id: noiseAccount,
                  },
                ],
                'access.resource_grant': [
                  {
                    route,
                    resource_id: postId,
                    subject_id: noiseAccount,
                    action: 'post:erase',
                    valid: '(,)',
                    transaction_id: postId,
                  },
                ],
                'access.resource_denial': [
                  {
                    route,
                    resource_id: postId,
                    subject_id: noiseAccount,
                    action: 'post:erase',
                    reason: 'resource',
                    valid: '(,)',
                    transaction_id: postId,
                  },
                ],
                'access.resource_role_grant': [
                  {
                    route,
                    resource_id: postId,
                    subject_id: noiseAccount,
                    grant_role: 'fixture.owner',
                    valid: '(,)',
                    transaction_id: postId,
                  },
                ],
                'content.operation': [
                  {
                    route,
                    operation_id: newId(route),
                    initiator_account_id: selected.actor.accountId,
                    author_account_id: noiseAccount,
                    thread_id: selected.threadId,
                    anchor_post_id: postId,
                    actor_kind: 'account',
                    actor_account_id: selected.actor.accountId,
                    actor_client_id: selected.actor.clientId,
                    actor_scopes: selected.actor.scopes,
                    actor_requested_by: null,
                    actor_authn_epoch: selected.actor.authnEpoch,
                    empty_scope: true,
                    requested_at: new Date(),
                    recorded_transaction_id: postId,
                  },
                ],
                'content.post': [
                  {
                    route,
                    thread_id: selected.threadId,
                    post_id: postId,
                    author_account_id: noiseAccount,
                    head_revision_id: head,
                    visibility: 'published',
                    security_revision: 1,
                    recorded_transaction_id: postId,
                  },
                ],
                'content.revision': Array.from({ length: 3 }, (_, index) => ({
                  route,
                  thread_id: selected.threadId,
                  post_id: postId,
                  revision_id: index === 0 ? head : newId(route),
                  body,
                  body_sha256: new Bun.CryptoHasher('sha256').update(body).digest(),
                  search_text: 'Other author',
                  licence: 'MIT',
                  subject_ids: [],
                  board_id: newId(route),
                  availability: 'available',
                  recorded_transaction_id: postId,
                })),
              };
            },
          },
          { from: previous, to: scale },
        );
      },
      // The logical page consumes its posts, so warm that page on the spare author first.
      async warmup() {
        sparePaused = await launchSelection(spare, 'logical');
        await finish(sparePaused);
        sparePaused = undefined;
      },
      async operation() {
        paused = await launchSelection(selected, 'logical');
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBeGreaterThan(0);
      expect(Object.values(sample.cost.relations ?? {}).every((relation) => relation.sequentialScans === 0)).toBe(true);
    }
    console.info('Native logical page growth', JSON.stringify(report.samples));
  } finally {
    measuredPool = undefined;
    try {
      await finish(sparePaused);
      await finish(paused);
    } finally {
      await db.close();
    }
  }
}, 240_000);
