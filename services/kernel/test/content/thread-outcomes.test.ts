import { test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { openMeasuredThreadCreate } from './thread-driver.ts';

process.env.CONTENT_THREAD_DRIVER = fileURLToPath(new URL('./thread-driver.ts', import.meta.url));

await import('../../../../specs/content-thread-outcomes.test.ts');

/** Neighbouring rows keep every key index worth its cost to the planner at the smallest scale, where it would
 * otherwise scan a table of a few dozen rows once per probe. */
async function seedNeighbours(database: GrowthDatabase, count: number): Promise<void> {
  const accountId = newId(0x2345);
  const boardId = newId(0x3456);
  for (const route of [0x1111, 0x5678]) {
    const threads = Array.from({ length: count }, () => newId(route));
    const posts = threads.map(() => newId(route));
    const revisions = threads.map(() => newId(route));
    const transaction = randomUUID();
    await database.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       SELECT $1,resource_id,$2,'thread:read','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
      [route, accountId, transaction, threads],
    );
    await database.admin.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
       SELECT $1,resource_id,$2,'content.thread.owner','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
      [route, accountId, transaction, threads],
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
          if (previous === 0) await seedNeighbours(db, 2048);
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
