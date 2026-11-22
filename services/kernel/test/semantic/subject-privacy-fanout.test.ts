import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { encode, tree } from '../../src/search/public-filter-codec.ts';
import { systemClock } from '../../src/clock.ts';
import { maintainPublicFilterCoverageHome } from '../../src/semantic/public-filter-coverage-maintenance.ts';
import {
  PUBLIC_FILTER_SUBJECT_SCOPE,
  publicFilterCoverageKeys,
} from '../../src/semantic/public-filter-coverage-pending.ts';
import { newId } from '../../src/route/route.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { publicFilterSource } from '../../src/semantic/public-filter-source.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { digest, identityFixture, release } from './identity-fixture.ts';
import { identityEpochDatabase } from './support/identity-epoch.ts';
import { setNativePartitionEpochForFixture } from './support/public-filter-source.ts';

test('shared Subject withdrawal outlives legacy fanout and an enqueue during receiver intake', async () => {
  const db = await identityEpochDatabase();
  try {
    configureTestReceiptKeys(db.pool);
    const f = await identityFixture(db.pool, db.admin);
    const home = 1;
    const inputKey = PUBLIC_FILTER_SUBJECT_SCOPE;
    const route = home * 16;
    const books: string[] = [];
    for (const label of ['Included in the original cut', 'First withdrawal after the cut', 'Concurrent withdrawal']) {
      const key = randomUUID();
      const book = await createSubject(db.pool, {
        actor: f.editor,
        target: { route, id: newId(route) },
        idempotencyKey: key,
        digest: digest(key),
        release,
        item: { type: 'bf:Instance', labels: { en: label } },
        authorization: await f.authorization('subject:create'),
      });
      books.push(book.subject.id);
    }

    const source = { id: randomUUID(), configuration: randomUUID(), epoch: 1, partition: 0 };
    const readDefinition = randomUUID();
    const meaning = { digest: release.digest };
    await db.admin.query(
      `INSERT INTO semantic.public_filter_source(partition_no,source_id,configuration,route_digest,owner_epoch,family)
       VALUES(0,$1,$2,$3,1,'global-subject-v1')`,
      [source.id, source.configuration, digest(source.id).toString('hex')],
    );
    await db.admin.query(
      `INSERT INTO semantic.public_filter_read_definition
        (partition_no,read_definition,source_id,configuration,release_digest,capture_digest,capture,dependency_keys,coverage_keys)
       VALUES(0,$1,$2,$3,$4,$5,$6,'[]',$7)`,
      [
        readDefinition,
        source.id,
        source.configuration,
        meaning.digest,
        digest(readDefinition).toString('hex'),
        JSON.stringify(['object', [['catalogueCoverage', ['value', true]]]]),
        publicFilterCoverageKeys([], true),
      ],
    );
    async function subscribe(generation: number) {
      const job = randomUUID();
      const incarnation = randomUUID();
      const bootstrap = randomUUID();
      const registration = randomUUID();
      const physicalTarget = `privacy-fanout-${generation}`;
      const consumer = { readDefinition, meaningDigest: meaning.digest, physicalTarget, incarnation };
      await db.admin.query(
        'INSERT INTO search.public_filter_target(partition_no,physical_target,incarnation) VALUES(0,$1,$2)',
        [physicalTarget, incarnation],
      );
      await db.admin.query(
        `INSERT INTO search.generation_publication
         (job,physical_target,consumer,prefix,generation,family,native_incarnation,kinds,source_home,binding,activated_at,ack_protocol,subscription_protocol)
         VALUES($1,$2,$3,'privacy-fanout-', $4,'subjects',$5,'{}',0,$6,now()::text,1,1)`,
        [job, physicalTarget, consumer, generation, incarnation, { readDefinition, source, meaning }],
      );
      const { birth } = (
        await db.admin.query('SELECT core.open_subject_subscription_v1($1,$2) AS birth', [job, bootstrap])
      ).rows[0]!;
      await db.admin.query(
        `INSERT INTO search.public_filter_registration(partition_no,id,physical_target,consumer,definition,state)
        VALUES(0,$1,$2,$3,'{}','active')`,
        [registration, physicalTarget, encode(consumer)],
      );
      await db.admin.query(
        `INSERT INTO semantic.public_filter_bootstrap(partition_no,bootstrap,read_definition,request_key,consumer,
        snapshot_kind,native_snapshot,owner_epoch,source_position,state)
        VALUES(0,$1,$2,$3,$4,'prepared',pg_current_snapshot(),1,0,'capturing')`,
        [bootstrap, readDefinition, digest(job).toString('hex'), JSON.stringify(tree(consumer, 'value'))],
      );
      await db.admin.query('INSERT INTO semantic.subject_source_preparation_v1(birth,bootstrap) VALUES($1,$2)', [
        birth,
        bootstrap,
      ]);
      expect(
        (await db.admin.query('SELECT search.begin_subject_receiver_v1($1,$2) AS ready', [job, encode(consumer)]))
          .rows[0].ready,
      ).toBe(true);
      return { birth, bootstrap, job, registration };
    }

    await db.admin.query('SELECT core.enable_subject_retention_v1()');
    const { birth, bootstrap, registration, job } = await subscribe(1);
    const readPending = async () =>
      (
        await db.admin.query(
          `SELECT live,first_position,through_position,captured_revision FROM semantic.public_filter_privacy_pending
         WHERE (partition_no,input_key)=($1,$2)`,
          [home, inputKey],
        )
      ).rows[0]!;
    const maintain = () =>
      maintainPublicFilterCoverageHome(db.pool, home, { deadline: Date.now() + 5000, subjectWithdrawal: true }, 1);
    const readFanout = async () =>
      (
        await db.admin.query(
          `SELECT enqueue_revision,membership_revision,after_birth,complete,owner_epoch,first_position,through_position
         FROM semantic.subject_privacy_fanout_v1 WHERE (partition_no,input_key)=($1,$2) ORDER BY enqueue_revision`,
          [home, inputKey],
        )
      ).rows;

    await f.hide(books[0]!);
    await maintain();
    expect(await readPending()).toMatchObject({ live: true, captured_revision: '1' });
    expect(await readFanout()).toEqual([
      {
        enqueue_revision: '1',
        membership_revision: birth,
        after_birth: '0',
        complete: false,
        owner_epoch: 1,
        first_position: '1',
        through_position: '1',
      },
    ]);
    const { cuts } = (await db.admin.query('SELECT semantic.capture_subject_access_page_v1($1,0,2) AS cuts', [birth]))
      .rows[0]!;
    expect(cuts[home].privacy).toBe('1');
    await maintain();
    expect(await readPending()).toMatchObject({ live: false, captured_revision: null });

    await f.hide(books[1]!);
    await maintain();
    const original = await readPending();
    expect(original).toMatchObject({ live: true, captured_revision: '2' });
    const oldClear = `UPDATE semantic.public_filter_privacy_pending SET live=false, captured_through=NULL,
      captured_epoch=NULL,captured_revision=NULL,captured_enrollment_generation=NULL WHERE (partition_no,input_key)=($1,$2)`;
    await expect(db.admin.query(oldClear, [home, inputKey])).rejects.toThrow(
      'Subject privacy interval has no current disposition',
    );
    const { birth: lateBirth } = await subscribe(2);
    const intake = `INSERT INTO search.subject_privacy_intake_v1
      (birth,partition_no,input_key,enqueue_revision,privacy_base) VALUES($1,$2,$3,$4,$5)`;
    // The producer cut exists. No receiver page or independent ACK exists yet.
    await expect(db.admin.query(intake, [birth, home, inputKey, '2', cuts[home].privacy])).rejects.toThrow();
    const adopt = 'SELECT search.advance_subject_receiver_v1($1,32) AS homes';
    const accept = 'SELECT semantic.accept_subject_receiver_page_v1($1) AS homes';
    const first = await db.pool.connect();
    try {
      await first.query('SELECT pg_stat_force_next_flush()');
      await first.query('BEGIN');
      expect((await first.query(adopt, [job])).rows[0].homes).toBe(2);
      expect((await first.query(accept, [job])).rows[0].homes).toBe(0);
      const writes = await first.query(`SELECT sum(n_tup_ins+n_tup_upd+n_tup_del)::int AS count
        FROM pg_stat_xact_user_tables WHERE schemaname='search'`);
      expect(writes.rows[0].count).toBe(2);
      await first.query('COMMIT');
    } finally {
      first.release(true);
    }
    const pages = () => db.admin.query('SELECT * FROM search.subject_receiver_page_v1 WHERE birth=$1', [birth]);
    const saved = (await pages()).rows;
    expect(saved).toHaveLength(1);
    expect((await db.admin.query(adopt, [job])).rows[0].homes).toBe(2);
    expect((await pages()).rows).toEqual(saved);
    const stale = await db.admin.connect();
    try {
      await stale.query('BEGIN');
      await stale.query('UPDATE core.subject_retention_domain SET fenced=true WHERE singleton');
      await expect(stale.query(accept, [job])).rejects.toThrow();
    } finally {
      await stale.query('ROLLBACK');
      stale.release();
    }
    await expect(
      db.admin.query('INSERT INTO search.public_filter_ack_manifest(job) VALUES($1)', [job]),
    ).rejects.toThrow();
    expect((await db.admin.query(accept, [job])).rows[0].homes).toBe(2);
    expect((await db.admin.query(accept, [job])).rows[0].homes).toBe(0);
    await expect(
      db.admin.query('SELECT * FROM semantic.public_filter_book_dirty_homes($1)', [registration]),
    ).rejects.toThrow('A manifest ACK requires its original bootstrap');
    expect(
      (
        await db.admin.query(
          `SELECT behind,acknowledged_settlement FROM
      semantic.public_filter_effective_homes($1,$2,$3,1)`,
          [registration, bootstrap, home],
        )
      ).rows,
    ).toEqual([{ behind: true, acknowledged_settlement: null }]);
    expect(
      (
        await db.admin.query('SELECT source_home FROM search.public_filter_original_home(0,$1,$2,2)', [
          registration,
          bootstrap,
        ])
      ).rows,
    ).toEqual([]);
    const receiver = await db.admin.connect();
    try {
      await receiver.query('BEGIN');
      await receiver.query(intake, [birth, home, inputKey, original.captured_revision, cuts[home].privacy]);
      await f.hide(books[2]!);
      expect(
        (
          await db.pool.query('SELECT semantic.advance_subject_privacy_fanout_v1($1,$2,2,1) AS status', [
            home,
            inputKey,
          ])
        ).rows[0].status,
      ).toBe('pending');
      expect(await readPending()).toEqual({ ...original, through_position: '3' });
      await receiver.query('COMMIT');
    } finally {
      await receiver.query('ROLLBACK');
      receiver.release();
    }

    await maintain();
    expect(await readFanout()).toMatchObject([
      { complete: true },
      { complete: true, membership_revision: birth, after_birth: birth, through_position: '2' },
    ]);
    expect(await readPending()).toEqual({
      live: true,
      first_position: '3',
      through_position: '3',
      captured_revision: null,
    });
    await maintain();
    expect((await readFanout()).at(-1)).toMatchObject({
      enqueue_revision: '3',
      membership_revision: lateBirth,
      first_position: '3',
      complete: false,
    });
    expect(await readPending()).toMatchObject({ live: true, captured_revision: '3' });
    await db.admin.query('SELECT semantic.capture_subject_access_page_v1($1,0,2)', [lateBirth]);
    // The ordinary maintainer may already have delivered this exact intake.
    await db.pool.query('SELECT search.receive_subject_privacy_v1($1,$2,3,1)', [home, inputKey]);
    expect(
      (
        await db.admin.query(
          'SELECT home,epoch,through_position,change_generation FROM search.subject_receiver_dirty_v1 WHERE birth=$1',
          [birth],
        )
      ).rows,
    ).toEqual([{ home, epoch: 1, through_position: '3', change_generation: '2' }]);
    expect(
      (
        await db.admin.query(
          `SELECT (SELECT count(*) FROM search.public_filter_coverage_home) AS legacy_homes,
      (SELECT count(*) FROM semantic.public_filter_bootstrap_account) AS accounts,
      (SELECT count(*) FROM search.subject_privacy_intake_v1 WHERE birth=$1) AS intakes`,
          [birth],
        )
      ).rows[0],
    ).toEqual({ legacy_homes: '0', accounts: '0', intakes: '2' });
    const disposition = await db.admin.query('SELECT semantic.advance_subject_privacy_fanout_v1($1,$2,3,2) AS status', [
      home,
      inputKey,
    ]);
    expect(disposition.rows).toEqual([{ status: 'complete' }]);

    const producer = publicFilterSource({
      pool: db.pool,
      routeKey: new Uint8Array(32),
      access: f.access,
      clock: systemClock,
    });
    const readLog = (epoch: number) =>
      producer.readPrivacyReductionPage({
        retentionProtocol: 1,
        partition: home,
        epoch,
        after: 0n,
        through: 3n,
        inputLimit: 3,
        context: { deadline: Date.now() + 5000 },
      });
    expect(await readLog(1)).toMatchObject({ status: 'complete', after: 3n });
    await setNativePartitionEpochForFixture(db, home, 2);
    // Model a replacement head with the historical log still present.
    await db.admin.query(
      'UPDATE semantic.public_filter_privacy_head SET owner_epoch=2,population_fenced=false WHERE partition_no=$1',
      [home],
    );
    await expect(db.admin.query(oldClear, [home, inputKey])).rejects.toThrow(
      'Subject privacy interval has no current disposition',
    );
    expect(await readPending()).toMatchObject({ live: true, captured_revision: '3' });
    expect(await readLog(2)).toMatchObject({ status: 'changed' });
  } finally {
    await db.close();
  }
});
