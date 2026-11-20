import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
      const physicalTarget = `privacy-fanout-${generation}`;
      await db.admin.query(
        'INSERT INTO search.public_filter_target(partition_no,physical_target,incarnation) VALUES(0,$1,$2)',
        [physicalTarget, incarnation],
      );
      await db.admin.query(
        `INSERT INTO search.generation_publication
         (job,physical_target,consumer,prefix,generation,family,native_incarnation,kinds,source_home,binding,activated_at)
         VALUES($1,$2,$3,'privacy-fanout-', $4,'subjects',$5,'{}',0,$6,now()::text)`,
        [
          job,
          physicalTarget,
          { readDefinition, meaningDigest: meaning.digest, physicalTarget, incarnation },
          generation,
          incarnation,
          { readDefinition, source, meaning },
        ],
      );
      return (await db.admin.query('SELECT core.open_subject_subscription_v1($1,$2) AS birth', [job, randomUUID()]))
        .rows[0]!.birth as string;
    }

    await db.admin.query('SELECT core.enable_subject_retention_v1()');
    const birth = await subscribe(1);
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
    const { cuts } = (await db.admin.query('SELECT core.capture_subject_retention_page_v1($1,0,2) AS cuts', [birth]))
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
    const lateBirth = await subscribe(2);
    const intake = `INSERT INTO search.subject_privacy_intake_v1
      (birth,partition_no,input_key,enqueue_revision,privacy_base) VALUES($1,$2,$3,$4,$5)`;
    const receiver = await db.admin.connect();
    try {
      await receiver.query('BEGIN');
      await receiver.query(intake, [birth, home, inputKey, original.captured_revision, cuts[home].privacy]);
      await f.hide(books[2]!);
      await maintain();
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
    await db.admin.query('SELECT core.capture_subject_retention_page_v1($1,0,2)', [lateBirth]);
    await db.admin.query(intake, [birth, home, inputKey, '3', cuts[home].privacy]);
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
