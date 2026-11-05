import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { routeOf } from '../../src/route/route.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { startWorker } from '../../src/worker.ts';
import { identityEpochStore as store, identityJobPartition } from '../../src/semantic/identity-epoch-store.ts';
import { resumeIdentityEpochJob, waitIdentityEpochPublished } from '../../src/semantic/identity-epoch-coordinator.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import type { IdentityJobRef } from '../../src/semantic/identity-epoch-contract.ts';
import { readSearchConfig } from '../../src/search/work.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { digest, globalResource, release } from './support/identity-epoch.ts';
import { cutoverFixture, libraryCutoverInput } from './support/identity-epoch-cutover.ts';

let f: Awaited<ReturnType<typeof cutoverFixture>>;
let db: GrowthDatabase;
let worker: Awaited<ReturnType<typeof startWorker>>;
let nativePool: Pool;
type Input = Awaited<ReturnType<typeof input>>;

beforeAll(async () => {
  f = await cutoverFixture();
  db = await openGrowthDatabase(f.pool.options.connectionString);
  db.pool.options.max = 1;
  nativePool = db.pool;
  await installIdentityEpochBootstrap(nativePool);
  const env = workerTestEnv({
    ...process.env,
    DATABASE_URL: db.url,
    KERNEL_SEARCH_PREFIX: `identity-${randomUUID().replaceAll('-', '')}`,
  });
  expect(readSearchConfig(env), 'Actual default fixed Search participant needs OPENSEARCH_URL').toBeDefined();
  // The existing trusted pool factory keeps the actual default worker, SDK, queues and relays in
  // shared growth capture. In particular, no child worker or foreign native pool escapes measurement.
  worker = await startWorker(
    {
      databaseUrl: db.url,
      poolSize: 1,
      kernelPool() {
        // Commands, native observations, SDK and relays share the SAME max-one pool.
        // A second observation pool would invalidate the original backend bound.
        // Both startWorker and GrowthDatabase own cleanup. Share their actual close operation.
        const end = nativePool.end.bind(nativePool);
        let closing: Promise<void> | undefined;
        nativePool.end = () => (closing ??= end());
        return nativePool;
      },
    },
    undefined,
    env,
  );
}, 180_000);

afterAll(async () => {
  try {
    await worker?.stop();
  } finally {
    try {
      await db?.close();
    } finally {
      await f?.close();
    }
  }
});

async function input(route = 0x7510) {
  const original = (await f.create('Coordinator original', route)).id;
  const terminal = (await f.create('Coordinator terminal', route + 0x10)).id;
  const library = await libraryCutoverInput(f, [original, terminal]);
  const occurrences = (
    await f.admin.query(
      'SELECT * FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY member_id',
      [routeOf(library.collection.id), library.collection.id],
    )
  ).rows;
  expect(occurrences).toHaveLength(2);
  return { original, terminal, library, occurrences };
}

async function publish(source: Input) {
  // Current real authorization uses the measured native pool and the original five-second deadline.
  const context = { pool: nativePool, deadline: Date.now() + 5000 };
  const actor = await f.access.authenticate(f.real.bearer('editor'), context);
  const authorization = await accessCommandAuthorization(
    f.access,
    actor,
    'subject:merge',
    globalResource,
    context,
    () => new Error('Native coordinator growth merge denied'),
  );
  const key = randomUUID();
  const job = await store().prepareAdmission(
    nativePool,
    {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization,
      deadline: context.deadline,
    },
    {
      intent: { kind: 'merge', redirected: source.original, survivor: source.terminal, release: release.digest },
      receipt: {
        kind: 'subject.merge',
        command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
      },
    },
  );
  for (let page = 0; page < 512; page++) {
    const progress = await stepIdentityEpochAdmission(nativePool, job);
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    if (progress.state === 'pending' || progress.state === 'published') break;
    expect(progress.state).toBe('preparing');
  }
  await resumeIdentityEpochJob(nativePool, job);
  await waitIdentityEpochPublished(nativePool, job);
  await custody(job, source);
  return job;
}

async function publication(job: IdentityJobRef) {
  // Publication updates job/control and emits its event in ONE native transaction. Matching xmin
  // distinguishes that commit from admission and later wakeups; row flags alone are insufficient.
  return (
    await db.pool.query(
      `SELECT j.xmin::text AS transaction,o.id,o.epoch,o.position::text
     FROM semantic.identity_epoch_job j
     JOIN semantic.identity_epoch_control c ON c.partition_no=j.partition_no
     JOIN core.outbox o ON o.partition_no=j.partition_no AND o.xmin=j.xmin
     JOIN core.partition p ON p.partition_no=j.partition_no AND p.epoch=o.epoch
     WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='published'
       AND c.published_epoch>=j.epoch AND c.pending_job IS DISTINCT FROM j.job_id
       AND o.type='com.rezics.semantic.identity-epoch.admitted.v1' AND o.data->>'jobId'=$2::text
       AND o.data->>'epoch'=$3::text AND p.write_state='active' AND p.position>=o.position`,
      [identityJobPartition(job), job.jobId, job.epoch.toString()],
    )
  ).rows;
}

async function custody(job: IdentityJobRef, source: Input) {
  const saved = await store().readJob(db.pool, job);
  expect(saved?.ref).toEqual(job);
  expect(saved?.state).toBe('published');
  const steps = [
    saved?.mapping,
    saved?.participants['search-canonical-index'],
    saved?.participants['library-private-follow-counts'],
  ];
  expect(steps.map((progress) => progress?.receipt.step)).toEqual([
    'mapping',
    'search-canonical-index',
    'library-private-follow-counts',
  ]);
  for (const progress of steps) {
    expect(progress?.state).toBe('complete');
    if (!progress) throw new Error('Native publication lacks a fixed participant receipt');
    expect(progress.job).toEqual(job);
    expect(progress.receipt.version).toBe(1);
    expect(progress.frontier.after.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(progress.frontier))).toBeLessThanOrEqual(2048);
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    expect(await store().reconcileStepReceipt(nativePool, progress.receipt)).toEqual(progress);
  }
  expect(await store().readMapping(db.pool, source.original)).toMatchObject({
    state: 'mapped',
    original: source.original,
    terminal: source.terminal,
  });
  const redirect = await db.pool.query(
    'SELECT target FROM semantic.redirect WHERE route=$1 AND subject_id=$2 ORDER BY sequence DESC LIMIT 1',
    [routeOf(source.original), source.original],
  );
  expect(redirect.rows).toEqual([{ target: source.terminal }]);
  expect(
    (
      await db.pool.query(
        'SELECT * FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY member_id',
        [routeOf(source.library.collection.id), source.library.collection.id],
      )
    ).rows,
  ).toEqual(source.occurrences);
  expect(await publication(job)).toHaveLength(1);
}

test('actual fixed coordinator publication and receipt replay stay bounded across unrelated identity job input and receiving history', async () => {
  let current: Input;
  const report = await checkGrowth(db, {
    name: 'native fixed identity coordinator publication across unrelated retained history',
    scales: [64, 512, 4096],
    rule: 'series',
    warmups: 1,
    repetitions: 3,
    includeBackends: true,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(_database, scale, previous) {
      for (let row = previous; row < scale; row++) {
        // Each retained history entry goes through the SAME native producers and all receipt guards.
        // No cancelled-only/count-only substitute, imported ACK, or fabricated input/receiving row.
        const unrelated = await input(0x7710);
        await publish(unrelated);
      }
    },
    async prepare() {
      current = await input();
    },
    async warmup() {
      await publish(await input());
    },
    async operation() {
      const job = await publish(current);
      const committed = await publication(job);
      const saved = await store().readJob(db.pool, job);
      // Lost caller results redeliver the original job, never a second epoch or publication.
      await resumeIdentityEpochJob(nativePool, job);
      await waitIdentityEpochPublished(nativePool, job);
      expect(await publication(job)).toEqual(committed);
      expect(await store().readJob(db.pool, job)).toEqual(saved);
      await custody(job, current);
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    for (const cost of sample.repetitions) {
      expect(cost.plans).toBeGreaterThan(0);
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.blocks).toBeGreaterThan(0);
      for (const table of [
        'semantic.identity_epoch_job',
        'semantic.identity_epoch_input',
        'semantic.identity_epoch_step',
        'semantic.identity_epoch_ack',
        'semantic.identity_epoch_native_commit',
        'semantic.identity_epoch_receiving_record',
        'semantic.identity_epoch_receiving_effect',
        'semantic.identity_epoch_receiving_custody',
        'core.partition',
        'dbos.operation_outputs',
      ]) {
        expect(cost.relations[table]?.rows, table).toBeGreaterThan(0);
      }
      expect(cost.requestBytes).toBeGreaterThan(0);
      expect(cost.responseBytes).toBeGreaterThan(0);
      // checkGrowth keeps background plans/rows/blocks and applies its own background bound.
      // Do not filter SDK, control, catalogue, failed-attempt or another participant's statements.
    }
    expect(sample.statementRepetitions).toHaveLength(3);
    expect(sample.backendRepetitions).toHaveLength(3);
    for (const backends of sample.backendRepetitions ?? []) {
      expect(backends.length).toBeGreaterThan(0);
      expect(backends.length).toBeLessThanOrEqual(1);
    }
  }
}, 600_000);
