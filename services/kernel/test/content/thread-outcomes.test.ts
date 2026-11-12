import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { openMeasuredThreadCreate } from './thread-driver.ts';

process.env.CONTENT_THREAD_DRIVER = fileURLToPath(new URL('./thread-driver.ts', import.meta.url));

const threadDriver = await import('./thread-driver.ts');
setDefaultTimeout(60_000);
beforeAll(() => threadDriver.initializeContentThreadSystem());
afterAll(() => threadDriver.closeContentThreadSystem());

await import('../../../../specs/content-thread-outcomes.test.ts');

/** Seed the growing Access and Content relations read by the atomic create path. The harness analyzes these rows
 * before each measurement so the planner sees the same indexed histories the command sees in production. */
async function seedNeighbours(database: GrowthDatabase, count: number): Promise<void> {
  const accountId = newId(0x2345);
  const boardId = newId(0x3456);
  for (const route of [0x1111, 0x5678]) {
    const threads = Array.from({ length: count }, () => newId(route));
    const posts = threads.map(() => newId(route));
    const revisions = threads.map(() => newId(route));
    const transaction = randomUUID();
    const resources = [...threads, ...posts];
    const resourceTypes = [
      ...Array.from({ length: count }, () => 'content.thread'),
      ...Array.from({ length: count }, () => 'content.post'),
    ];
    const grantRoles = [
      ...Array.from({ length: count }, () => 'content.thread.owner'),
      ...Array.from({ length: count }, () => 'content.post.owner'),
    ];
    await database.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       SELECT $1,resource_id,$2,'thread:read','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
      [route, accountId, transaction, threads],
    );
    await database.admin.query(
      `INSERT INTO access.resource_initialization(route,resource_id,resource_type,creator_id,initialized_at)
       SELECT $1,resource_id,resource_type,$2,clock_timestamp()
       FROM unnest($3::uuid[],$4::text[]) AS row(resource_id,resource_type)`,
      [route, accountId, resources, resourceTypes],
    );
    await database.admin.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
       SELECT $1,resource_id,$2,grant_role,'(,)'::tstzrange,$3
       FROM unnest($4::uuid[],$5::text[]) AS row(resource_id,grant_role)`,
      [route, accountId, transaction, resources, grantRoles],
    );
    await database.admin.query(
      `INSERT INTO access.resource_role_provenance
         (route,resource_id,resource_type,original_creator,account_id,grant_role,side,source_transaction)
       SELECT $1,resource_id,resource_type,$2,$2,'','creator',$3
       FROM unnest($4::uuid[],$5::text[]) AS row(resource_id,resource_type)`,
      [route, accountId, transaction, resources, resourceTypes],
    );
    await database.admin.query(
      `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
       SELECT $1,'account',$2,'content.thread.create',key,sha256(convert_to(key,'UTF8')),1,1,$3,'{}'
       FROM unnest($4::text[]) AS key`,
      [partitionOf(route), accountId, transaction, threads],
    );
    const client = await database.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
         SELECT $1,thread_id,$2,$3,'Neighbour','published',1,$4 FROM unnest($5::uuid[]) AS thread_id`,
        [route, accountId, boardId, transaction, threads],
      );
      await client.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
         SELECT $1,thread_id,post_id,$2,revision_id,'published',1,$3
         FROM unnest($4::uuid[],$5::uuid[],$6::uuid[]) AS row(thread_id,post_id,revision_id)`,
        [route, accountId, transaction, threads, posts, revisions],
      );
      await client.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
         SELECT $1,thread_id,post_id,revision_id,$2,sha256($2),'neighbour','MIT','{}',$3,'available',$4
         FROM unnest($5::uuid[],$6::uuid[],$7::uuid[]) AS row(thread_id,post_id,revision_id)`,
        [route, Buffer.from('Neighbour body'), boardId, transaction, threads, posts, revisions],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Keep full-key and active-actor permit probes on their declared indexes as history grows. */
async function seedSlowPermits(database: GrowthDatabase, count: number): Promise<void> {
  const boardResult = await database.admin.query<{ route: number; board_id: string }>(
    `SELECT route,board_id::text AS board_id FROM content.board
     ORDER BY created_at DESC,board_id LIMIT 1`,
  );
  const board = boardResult.rows[0];
  if (!board) throw new Error('Thread create growth board is missing');

  const actorKeys = Array.from({ length: count }, () => createHash('sha256').update(randomUUID()).digest());
  const commandKeys = Array.from({ length: count }, () => createHash('sha256').update(randomUUID()).digest());
  const requestDigests = Array.from({ length: count }, () => createHash('sha256').update(randomUUID()).digest());
  await database.admin.query(
    `INSERT INTO content.board_slow_actor(route,board_id,actor_key)
     SELECT $1,$2,actor_key FROM unnest($3::bytea[]) AS row(actor_key)`,
    [board.route, board.board_id, actorKeys],
  );
  await database.admin.query(
    `INSERT INTO content.board_slow_permit
       (route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,generation,
        security_episode,interval_seconds,state)
     SELECT $1,$2,actor_key,command_key,request_digest,$1,'content.thread.create',1,1,0,'reserved'
     FROM unnest($3::bytea[],$4::bytea[],$5::bytea[])
       AS row(actor_key,command_key,request_digest)`,
    [board.route, board.board_id, actorKeys, commandKeys, requestDigests],
  );
}

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const database = await openGrowthDatabase();
  try {
    const measured = await openMeasuredThreadCreate(database);
    try {
      const report = await checkGrowth(database, {
        name: 'content.thread.create',
        scales: [32, 256, 2048],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        grow: async (db, scale, previous) => {
          if (previous === 0) {
            await seedNeighbours(db, 2048);
            await seedSlowPermits(db, 2048);
          }
          await measured.grow(db, scale, previous);
        },
        operation: (db, scale, repetition) => measured.operation(db, scale, repetition),
      });
      console.log(JSON.stringify(report));
    } finally {
      await measured.close();
    }
  } finally {
    await database.close();
  }
}, 180_000);
