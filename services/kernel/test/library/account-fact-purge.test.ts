import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { purgeAccountFactsPage } from '../../src/library/account-fact-purge.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
configureTestReceiptKeys(pool);
afterAll(() => pool.end());
const route = 0x6c60;
const id = (n: number) => `00000000-0000-7000-8000-6c60${n.toString(16).padStart(8, '0')}`;
const time = '2026-10-27T12:00:00.000Z';
test('terminal account fact pages erase bounded native rows exactly once preserve unrelated contributions and reject nonterminal owners', async () => {
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,transaction_id) VALUES($1,$2,'actor','deleted',true,$2),($1,$3,'actor','active',false,$3)`,
    [route, id(1), id(2)],
  );
  await pool.query(
    `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$4,'planned',1,$6,$6,$2),($1,$2,$5,'completed',2,$6,$6,$2),($1,$3,$4,'planned',1,$6,$6,$3)`,
    [route, id(1), id(2), id(10), id(11), time],
  );
  await pool.query(
    `INSERT INTO library.entry_state_change
      (route,account_id,subject_id,incarnation_id,prior_revision,revision,before_state,after_state,
       command_id,command_kind,changed_at,coverage_complete)
     VALUES($1,$2,$4,$7,1,2,'planned','completed',$9,'library.entry.put',$10,false),
           ($1,$2,$5,$8,1,2,'planned','completed',$11,'library.entry.put',$10,false),
           ($1,$3,$4,$7,1,2,'planned','completed',$12,'library.entry.put',$10,false)`,
    [route, id(1), id(2), id(10), id(11), time, id(50), id(51), randomUUID(), time, randomUUID(), randomUUID()],
  );
  await pool.query(
    `INSERT INTO library.entry_personal_fact(route,account_id,subject_id,fact_id,annotation_revision,note,priority,
       annotation_updated_at,annotation_transaction_id,created_at,updated_at,transaction_id)
     VALUES($1,$2,$3,$4,1,'Private annotation',8,$5,$2,$5,$5,$2)`,
    [route, id(1), id(10), id(12), time],
  );
  await pool.query(
    `INSERT INTO library.entry_source_observation(route,account_id,subject_id,provider,record_id,revision,
       privacy_status,privacy_meaning,source_created_status,source_created_value,source_created_precision,source_created_zone,
       source_updated_status,source_updated_value,source_updated_precision,source_updated_zone,created_at,updated_at,transaction_id)
     VALUES($1,$2,$3,'vndb','record-1',1,'known','private','known','2024-02','month','unknown',
       'unknown',NULL,NULL,NULL,$4,$4,$2)`,
    [route, id(1), id(10), time],
  );
  await pool.query(
    `INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,note,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$4,$6,'owned','Private erased note',1,$7,$7,$4),($1,$3,$5,$6,'owned','Keep note',1,$7,$7,$5)`,
    [route, id(20), id(21), id(1), id(2), id(10), time],
  );
  await pool.query(
    `INSERT INTO library.follow(route,account_id,target_id,target_type,state,reason,created_at,updated_at,transaction_id) VALUES($1,$2,$4,'subject','following','explicit',$6,$6,$2),($1,$2,$5,'subject','unfollowed','explicit',$6,$6,$2),($1,$3,$4,'subject','following','explicit',$6,$6,$3)`,
    [route, id(1), id(2), id(30), id(31), time],
  );
  await pool.query(
    `INSERT INTO library.collection(route,collection_id,curator_account_id,title,visibility,state,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'Keep public contribution','public','active',1,$4,$4,$3)`,
    [route, id(40), id(1), time],
  );
  const input = { accountId: id(1), kind: 'entry' as const, after: null, limit: 1, stepKey: randomUUID() };
  const first = await purgeAccountFactsPage({ pool }, input);
  expect(first.value.examined).toBe(1);
  expect(first.value.removed).toBe(1);
  expect(first.value.exhausted).toBe(false);
  expect(
    (
      await pool.query(`SELECT subject_id FROM library.entry_state_change WHERE route=$1 AND account_id=$2`, [
        route,
        id(1),
      ])
    ).rows,
  ).toEqual([{ subject_id: id(11) }]);
  const replay = await purgeAccountFactsPage({ pool }, input);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(first.value);
  expect(replay.transactionId).toBe(first.transactionId);
  const second = await purgeAccountFactsPage(
    { pool },
    { ...input, after: first.value.after, limit: 100, stepKey: randomUUID() },
  );
  expect(second.value.examined).toBe(1);
  expect(second.value.removed).toBe(1);
  expect(second.value.exhausted).toBe(true);
  expect(
    (await pool.query(`SELECT account_id FROM library.entry_state_change WHERE route=$1 ORDER BY account_id`, [route]))
      .rows,
  ).toEqual([{ account_id: id(2) }]);
  expect(
    (
      await pool.query(`SELECT count(*)::int AS n FROM library.entry_personal_fact WHERE route=$1 AND account_id=$2`, [
        route,
        id(1),
      ])
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect(
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM library.entry_source_observation WHERE route=$1 AND account_id=$2`,
        [route, id(1)],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect(
    (await pool.query(`SELECT account_id FROM library.entry WHERE route=$1 ORDER BY account_id`, [route])).rows,
  ).toEqual([{ account_id: id(2) }]);
  const copies = await purgeAccountFactsPage(
    { pool },
    { accountId: id(1), kind: 'copy', after: null, limit: 100, stepKey: randomUUID() },
  );
  expect(copies.value.examined).toBe(1);
  expect(copies.value.removed).toBe(1);
  expect((await pool.query(`SELECT note FROM library.copy WHERE route=$1`, [route])).rows).toEqual([
    { note: 'Keep note' },
  ]);
  const follows = await purgeAccountFactsPage(
    { pool },
    { accountId: id(1), kind: 'follow', after: null, limit: 100, stepKey: randomUUID() },
  );
  expect(follows.value.examined).toBe(2);
  expect(follows.value.removed).toBe(2);
  expect((await pool.query(`SELECT account_id FROM library.follow WHERE route=$1`, [route])).rows).toEqual([
    { account_id: id(2) },
  ]);
  const empty = await purgeAccountFactsPage({ pool }, { ...input, limit: 100, stepKey: randomUUID() });
  expect(empty.value.examined).toBe(0);
  expect(empty.value.removed).toBe(0);
  expect(empty.value.exhausted).toBe(true);
  expect(
    (
      await pool.query(`SELECT title,state FROM library.collection WHERE route=$1 AND collection_id=$2`, [
        route,
        id(40),
      ])
    ).rows,
  ).toEqual([{ title: 'Keep public contribution', state: 'active' }]);
  await expect(
    purgeAccountFactsPage({ pool }, { ...input, accountId: id(2), stepKey: randomUUID() }),
  ).rejects.toBeDefined();
  await expect(
    purgeAccountFactsPage({ pool }, { ...input, accountId: id(999), stepKey: randomUUID() }),
  ).rejects.toBeDefined();
  await expect(purgeAccountFactsPage({ pool }, { ...input, limit: 101, stepKey: randomUUID() })).rejects.toBeDefined();
  expect(
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM core.outbox WHERE type='com.rezics.library.follow.updated.v1' AND subject=$1 AND data->>'targetId'=$2`,
        [id(1), id(30)],
      )
    ).rows[0].n,
  ).toBe(1);
});
