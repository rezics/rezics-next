import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { runCommand } from '../../src/command/command.ts';
import { erasePostLogical } from '../../src/content/erase-post.ts';
import { runAuthorErasure } from '../../src/content/erasure-workflow.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
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
            async (operationId: string) =>
              runAuthorErasure(
                {
                  pool: fixture.pool,
                  access: fixture.access,
                  currentTime: () => new Date(),
                  durableStep: (name, action) => DBOS.runStep(action, { name }),
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

test('native workflow resolves persisted initiating identity and physically completes more than two post pages', async () => {
  const selected = await scope(201, 3);
  const operationId = newId(route);
  const event = {
    type: 'com.rezics.content.author-erasure.requested.v1',
    data: { operationId, threadId: selected.threadId, authorId: selected.actor.accountId },
  };
  // Setup persists only verified identity columns, just as the native initiation command does.
  const source = await runCommand(fixture.pool, { partition }, async (tx, { transactionId }) => {
    await tx.query(
      `INSERT INTO content.operation
       (route,operation_id,initiator_account_id,author_account_id,thread_id,actor_kind,actor_account_id,
        actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,empty_scope,upper_created_at,
        upper_post_id,requested_at,recorded_transaction_id)
       VALUES ($1,$2,$3,$3,$4,'account',$3,$5,$6,$7,$8,false,$9,$10,statement_timestamp(),$11)`,
      [
        route,
        operationId,
        selected.actor.accountId,
        selected.threadId,
        selected.actor.clientId,
        selected.actor.scopes,
        selected.actor.requestedBy,
        selected.actor.authnEpoch,
        selected.at,
        selected.ids.at(-1),
        transactionId,
      ],
    );
    return { value: operationId, events: [event] };
  });
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
