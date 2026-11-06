import { expect, test } from 'bun:test';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { randomUUID } from 'node:crypto';
import {
  cancelIdentityEpochAdmission,
  stepIdentityEpochAdmission,
} from '../../src/semantic/identity-epoch-admission.ts';
import { release } from './support/identity-epoch.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { readIdentityRatingReview } from '../../src/semantic/identity-adapters/read.ts';
import { createIdentityRatingCommitParticipant } from '../../src/semantic/identity-rating-commit-participant.ts';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';
import {
  assertGrowthAccessPaths,
  capture,
  checkGrowth,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../support/growth.ts';

test('review and held identity costs stay fixed as unrelated native identities grow', async () => {
  const db = await openGrowthDatabase();
  const f = await createIdentityMappingFixture({ poolMax: 2, pool: db.pool, url: db.url });
  try {
    const route = 0x7010;
    const subjectId = (await f.create('Fixed reviewed rating subject', route)).subject.id;
    await f.bootstrapHomes([subjectId]);
    const home = partitionOf(routeOf(subjectId)!);
    const historyOriginal = (await f.create('Unrelated job original', route)).id;
    const historySurvivor = (await f.create('Unrelated job survivor', route)).id;
    const history = await f.prepare({
      kind: 'merge',
      redirected: historyOriginal,
      survivor: historySurvivor,
      release: release.digest,
    });
    await cancelIdentityEpochAdmission(db.pool, history);
    for (let step = 0; step < 16; step++) {
      if ((await stepIdentityEpochAdmission(db.pool, history)).state === 'cancelled') break;
      if (step === 15) throw new Error('Native history cancellation did not finish');
    }
    const participant = createIdentityRatingCommitParticipant();
    const operation = async () => {
      const review = await readIdentityRatingReview(db.pool, {
        requestedOriginalId: subjectId,
        canonicalTerminalId: subjectId,
        deadline: Date.now() + 5000,
      });
      if (review.state !== 'reviewed') throw new Error(`Expected a reviewed identity, received ${review.state}`);
      const prepared = participant.prepare(review.operand);
      return runCommand(db.pool, { partition: home }, async (tx) => noEffect(await participant.admit(tx, prepared)));
    };

    const sample = await capture(db, operation, { includeBackends: true });
    expect(sample.value.value.subjectId).toBe(subjectId);
    expect(sample.capture.statements.filter((statement) => /FOR UPDATE/i.test(statement))).toHaveLength(1);
    expect(sample.capture.requestBytes?.reduce((sum, size) => sum + size, 0)).toBeLessThan(16_384);
    expect(sample.capture.responseBytes?.reduce((sum, size) => sum + size, 0)).toBeLessThan(16_384);

    const report = await checkGrowth(db, {
      name: 'review and held identity costs across unrelated native identities',
      scales: [64, 512, 4096],
      repetitions: 3,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      async grow(_database: GrowthDatabase, scale, previous) {
        for (let n = previous; n < scale; n++) await f.create(`Unrelated rating identity ${n}`, route);
        // Retained noncurrent directory generations at the selected key must not
        // turn a point review into a history scan. Current evidence stays fixed.
        await db.admin.query(
          `INSERT INTO semantic.identity_epoch_original
          (partition_no,generation,original,terminal,source_partition,source_generation,present)
          SELECT $1,generation,$2,$2,$1,1,false FROM unnest($3::uuid[]) generation`,
          [home, subjectId, Array.from({ length: scale - previous }, () => randomUUID())],
        );
        // Clone a genuine cancelled record as imported retained history; no row
        // can claim a current group, native receipt or successful publication.
        await db.admin.query(
          `INSERT INTO semantic.identity_epoch_job
          SELECT (jsonb_populate_record(NULL::semantic.identity_epoch_job,
            to_jsonb(j) || jsonb_build_object('job_id',gen_random_uuid(),'epoch',n,
              'receipt_key',gen_random_uuid()::text,
              'erasure_key',nextval('semantic.erasure_record_key'),
              'recorded_transaction_id',gen_random_uuid()))).*
          FROM semantic.identity_epoch_job j CROSS JOIN generate_series($3::bigint,$4::bigint) n
          WHERE j.partition_no=$1 AND j.job_id=$2`,
          [home, history.jobId, 100000 + previous, 99999 + scale],
        );
      },
      operation,
      async verify(_database, _scale, _repetition, value) {
        expect(value).toMatchObject({ value: { ownerId: expect.any(String), subjectId } });
      },
    });
    assertGrowthAccessPaths('reviewed identity rating participant', report.samples, [
      ...new Set(report.samples.flatMap((entry) => Object.keys(entry.relationSizes))),
    ]);
    expect(report.samples.map((entry) => entry.scale)).toEqual([64, 512, 4096]);
    for (const entry of report.samples) {
      expect(entry.cost.rows).toBeLessThan(64);
      expect(entry.cost.requestBytes).toBeLessThan(16_384);
      expect(entry.cost.responseBytes).toBeLessThan(16_384);
      for (const backends of entry.backendRepetitions ?? []) expect(new Set(backends).size).toBeLessThanOrEqual(1);
    }
    console.info(
      'Native identity selected history costs',
      report.samples.map(({ scale, cost }) => ({ scale, ...cost })),
    );
  } finally {
    await f.close();
    await db.close();
  }
}, 600_000);
