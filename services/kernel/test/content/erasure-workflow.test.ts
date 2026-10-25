import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
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
import { newId, partitionOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { standingFixture } from '../access/standing-fixture.ts';

let fixture: Awaited<ReturnType<typeof standingFixture>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let work: Awaited<ReturnType<typeof composeWork>>;
const route = 0x6798;
const partition = partitionOf(route);
const routeKey = new Uint8Array(32).fill(7);
const context = () => ({
  deadline: Date.now() + 10_000,
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
});

beforeAll(async () => {
  fixture = await standingFixture();
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
                  pool: fixture.pool,
                  access: fixture.access,
                  readConsent: fixture.readConsent,
                  currentTime: () => new Date(),
                  durableStep: async (name, action) => {
                    const value = await DBOS.runStep(action, { name });
                    if (name === pauseAfter) {
                      await DBOS.setEvent('barrier', name);
                      expect(await DBOS.recv('continue', 30)).toBe(true);
                    }
                    return value;
                  },
                  checkpoint: {
                    read: (id) => DBOS.getEvent<OperationProgress>(id, 'progress', 0),
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
    { databaseUrl: process.env.DATABASE_URL!, pool: fixture.pool, client },
  );
  await work.launch();
});

afterAll(async () => {
  await work?.shutdown();
  await client?.close();
  await fixture?.close();
});

async function scope(posts: number, revisions = 1) {
  const actor = (await fixture.context()).actor;
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
    for (const postId of ids) {
      const head = newId(route);
      await tx.query(
        `INSERT INTO content.post
         (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,
          recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,'published',1,$3,$6)`,
        [route, threadId, postId, actor.accountId, head, at],
      );
      for (let index = 0; index < revisions; index++)
        await tx.query(
          `INSERT INTO content.revision
           (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,
            board_id,availability,recorded_transaction_id,recorded_at)
           VALUES ($1,$2,$3,$4,$5,sha256($5),'Private historical text','MIT','{}',$6,'available',$3,$7)`,
          [route, threadId, postId, index === 0 ? head : newId(route), Buffer.from('private'), boardId, at],
        );
    }
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  for (const id of ids) await fixture.grant(actor.accountId, 'post:erase', { route, id });
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
     (route,operation_id,initiator_account_id,author_account_id,thread_id,actor_kind,actor_account_id,
      actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,empty_scope,upper_created_at,
      upper_post_id,requested_at,recorded_transaction_id)
     SELECT route,$3,initiator_account_id,author_account_id,thread_id,actor_kind,actor_account_id,
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

async function launchSelection(selected: Awaited<ReturnType<typeof scope>>, pause = false) {
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
  const barrier = `wf:${source.value.operationId}:erase:${selected.ids[0]}`;
  const handle = await client.enqueue(
    { workflowName: 'content.authorErase', queueName: 'governance', workflowID: workflowId },
    source.value.operationId,
    pause ? barrier : undefined,
  );
  if (pause) expect(await client.getEvent(workflowId, 'barrier', 30)).toBe(barrier);
  return { handle, workflowId, operationId: source.value.operationId };
}

for (const revocation of ['grant', 'consent'] as const) {
  test(`native ${revocation} revocation at the logical step barrier preserves cleanup and stops later posts`, async () => {
    const selected = await scope(3, 101);
    const started = await launchSelection(selected, true);
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
      processedPosts: 1,
      erasedRevisions: 101,
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
          selected.ids.slice(1),
        ])
      ).rows,
    ).toEqual([{ availability: 'available' }, { availability: 'available' }]);
  });
}

test('checkGrowth proves fixed native erasure pages against unrelated and same-partition history', async () => {
  const { checkGrowth, openGrowthDatabase, seed } = await import('../support/growth.ts');
  const { pageAuthorErasurePosts, nullErasedRevisionPage, eraseRevisionMedia } =
    await import('../../src/content/erasure-workflow.ts');
  const db = await openGrowthDatabase();
  const selected = await scope(1, 100);
  await erasePostLogical(
    { pool: fixture.pool, access: fixture.access, routeKey },
    selected.actor,
    { postId: selected.ids[0]!, reason: 'Erase' },
    context(),
  );
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
      const body = Buffer.alloc(256, 7);
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
    const report = await checkGrowth(db, {
      name: 'native content erasure pages',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (target, scale, previous) => seed(target, population, { from: previous, to: scale }),
      async operation(target) {
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
    // Affected-row and byte growth is deliberate and separate from unrelated
    // history: every affected revision has the same fixed-size body and exact parent key.
    const linearScopes = new Map<number, Awaited<ReturnType<typeof scope>>>();
    const linear = await checkGrowth(db, {
      name: 'affected erasure revisions',
      scales: [1, 8, 64],
      bounds: { rows: 'linear', statements: 'constant', blocks: 'linear' },
      async grow(target, scale) {
        const value = await scope(1, scale);
        await erasePostLogical(
          { pool: fixture.pool, access: fixture.access, routeKey },
          value.actor,
          { postId: value.ids[0]!, reason: 'Erase' },
          context(),
        );
        linearScopes.set(scale, value);
        await target.admin.query('VACUUM (ANALYZE)');
      },
      async operation(target, scale) {
        const value = linearScopes.get(scale)!;
        try {
          await runCommand(target.pool, { partition }, async (tx) => {
            expect(
              await nullErasedRevisionPage(tx, {
                route,
                post_id: value.ids[0]!,
                after_at: '-infinity',
                after_id: value.ids[0]!,
              }),
            ).toHaveLength(scale);
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
      },
    });
    console.info('Affected erasure growth', JSON.stringify(linear.samples));
  } finally {
    await db.close();
  }
});
