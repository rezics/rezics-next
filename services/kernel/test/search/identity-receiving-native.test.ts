import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { stepIdentityEpochMapping } from '../../src/semantic/identity-epoch-mapping.ts';
import type { IdentityJobRef, IdentityStepProgress } from '../../src/semantic/identity-epoch-contract.ts';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import { createSearchIdentityEpochParticipant } from '../../src/search/identity-epoch-participant.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { digest, epochFixture, release, type EpochFixture } from '../semantic/support/identity-epoch.ts';
import { interruptNativeStatement, libraryCutoverInput } from '../semantic/support/identity-epoch-cutover.ts';

// Native production composition only. These cases are authored for integrated acceptance;
// the minimal workspace compiler is not evidence that this suite has run or passed.
const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error('OPENSEARCH_URL must name the check node');
const search = createOpenSearch(url);
const prefix = `receiving-${randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const routeKey = crypto.getRandomValues(new Uint8Array(32));
let f: EpochFixture;
let created = false;

beforeAll(async () => {
  f = await epochFixture();
  await createSubjectIndex(search, prefix, 1);
  created = true;
  await search.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});
afterAll(async () => {
  try {
    if (created) await search.request('DELETE', `/${index}`);
  } finally {
    await f?.close();
  }
});

function writer(engine = search) {
  return createSearchWriterGuard({
    pool: f.pool,
    search: engine,
    index,
    consumer: subjectConsumer(prefix, 1),
    source: subjectSource(f.pool, routeKey),
    listing: subjectListingSource(f.pool),
  });
}

async function originals(route: number) {
  const original = (await f.create('Native receiving original', route)).id;
  const terminal = (await f.create('Native receiving terminal', route + 0x10)).id;
  await libraryCutoverInput(f, [original, terminal]);
  return { original, terminal };
}

async function admitted(original: string, terminal: string) {
  const actor = await f.actor();
  const key = randomUUID();
  const job = await store.prepareAdmission(
    f.pool,
    {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:merge'),
    },
    {
      intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
      receipt: {
        kind: 'subject.merge',
        command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
      },
    },
  );
  for (let attempt = 0; attempt < 128; attempt++) {
    if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'pending') break;
  }
  expect((await store.readJob(f.pool, job))?.state).toBe('pending');
  for (let attempt = 0; attempt < 128; attempt++) {
    if ((await stepIdentityEpochMapping(f.pool, job)).state === 'complete') break;
  }
  expect((await store.readJob(f.pool, job))?.mapping?.state).toBe('complete');
  return job;
}

async function complete(job: IdentityJobRef, engine = search): Promise<IdentityStepProgress> {
  const step = createSearchIdentityEpochParticipant({ search: engine, prefix, routeKey });
  for (let attempt = 0; attempt < 128; attempt++) {
    const progress = await step(f.pool, job);
    expect(progress.job).toEqual(job);
    expect(progress.receipt.step).toBe('search-canonical-index');
    expect(progress.receipt.version).toBe(1);
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    if (progress.state === 'complete') return progress;
  }
  throw new Error('Finite native Search receiving did not complete');
}

async function records(job: IdentityJobRef) {
  return (
    await f.admin.query(
      `SELECT r.partition_no,r.original::text,r.effect_key,r.transaction_id,
        r.binding,r.source_hold,e.transaction_id AS applied_transaction_id,e.frontier,
        ac.purpose AS accepted_purpose,ec.purpose AS applied_purpose,
        (e.xmin=ec.xmin AND s.xmin=ec.xmin) AS same_applied_transaction
       FROM semantic.identity_epoch_receiving_record r
       LEFT JOIN semantic.identity_epoch_native_commit ac
         ON (ac.partition_no,ac.transaction_id)=(r.partition_no,r.transaction_id) AND ac.xmin=r.xmin
       LEFT JOIN semantic.identity_epoch_receiving_effect e
         ON (e.partition_no,e.job_id,e.effect_key)=(r.partition_no,r.job_id,r.effect_key)
       LEFT JOIN semantic.identity_epoch_native_commit ec
         ON (ec.partition_no,ec.transaction_id)=(e.partition_no,e.transaction_id)
       LEFT JOIN semantic.identity_epoch_step s
         ON (s.partition_no,s.transaction_id)=(e.partition_no,e.transaction_id)
         AND s.job_id=r.job_id AND s.job_epoch=r.job_epoch AND s.step='search-canonical-index'
         AND s.version=1 AND s.frontier=e.frontier AND s.scope_digest=r.binding->>'scopeDigest'
         AND s.native_epoch=ec.epoch AND s.native_position=ec.position
       WHERE r.job_id=$1 AND r.job_epoch=$2 AND r.binding->>'step'='search-canonical-index'
       ORDER BY r.partition_no,r.effect_key`,
      [job.jobId, job.epoch.toString()],
    )
  ).rows;
}

test('the fixed Search participant uses genuine native original receiving custody and same-transaction acceptance applied recording and release while uncertain copies prevent completion', async () => {
  const { original, terminal } = await originals(0xb110);
  const guard = writer();
  await guard.write(subjectPartition(original), [original], 0n);
  // The terminal has no previous visible copy: completion must include genuine first-apply preparation.
  const job = await admitted(original, terminal);
  const progress = await complete(job);
  const saved = await records(job);
  expect(saved.length).toBeGreaterThan(0);
  expect(new Set(saved.map((row) => row.original))).toEqual(new Set([original, terminal]));
  expect(saved.some((row) => row.binding.source.disposition === 'OLD')).toBe(true);
  expect(saved.some((row) => row.binding.source.disposition === 'first-apply')).toBe(true);
  for (const row of saved) {
    expect(row.accepted_purpose).toBe('identity-receiving-record');
    expect(row.source_hold.transactionId).toBe(row.transaction_id);
    expect(row.binding.source.locator.kind).toBe('search-canonical-index');
    expect(row.binding.source.locator.partition).toBe(row.partition_no);
    expect(row.binding.source.plan.transactionId).not.toBe(row.transaction_id);
    expect(row.binding.source.owner).toBe(row.binding.source.documentId);
    expect(row.binding.source.sourceId).toBe(row.binding.source.documentId);
    expect(row.binding.source.native).toBeUndefined(); // Library identity/capture/hold is a separate branch.
    expect(row.applied_purpose).toBe('search-canonical-index');
    expect(row.same_applied_transaction).toBe(true);
  }
  const replay = await complete(job);
  expect(replay.receipt).toEqual(progress.receipt);
  expect(await records(job)).toEqual(saved);
  const state = await store.readJob(f.pool, job);
  expect(state?.state).toBe('pending');
  expect(state?.participants['library-private-follow-counts']).toBeNull();
  // Search completion never manufactures the independent Library ACK or whole-job publication.
});

test('missing common applied registration rolls back the actual native final settlement', async () => {
  const { original, terminal } = await originals(0xb210);
  await writer().write(subjectPartition(original), [original], 0n);
  const job = await admitted(original, terminal);
  // Interrupt the real common record after owner application, rather than supplying a success callback.
  await interruptNativeStatement(f, /INSERT INTO semantic\.identity_epoch_receiving_effect/i, () => complete(job));
  expect((await records(job)).every((row) => row.applied_transaction_id === null)).toBe(true);
  expect((await store.readJob(f.pool, job))?.participants['search-canonical-index']).toBeNull();
  await complete(job);
  expect((await records(job)).every((row) => row.same_applied_transaction === true)).toBe(true);
});

test('lost original dispatch remains draining after actual refresh and cannot produce a Search completion', async () => {
  const { original, terminal } = await originals(0xb310);
  const lost = new Error('native receiving regression: bulk response lost after actual dispatch');
  let dispatched = false;
  const interrupted: OpenSearch = {
    request: search.request.bind(search),
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      await search.bulk<T>(...args);
      dispatched = true;
      throw lost;
    },
  };
  await expect(writer(interrupted).write(subjectPartition(original), [original], 0n)).rejects.toBe(lost);
  expect(dispatched).toBe(true);
  const before = await f.admin.query(
    `SELECT writer_token,dispatch_state FROM search.identity_writer
     WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
    [subjectPartition(original), index, original],
  );
  expect(before.rows[0]?.dispatch_state).toBe('dispatched');
  expect(before.rows[0]?.writer_token).not.toBeNull();
  await search.request('POST', `/${index}/_refresh`);
  const job = await admitted(original, terminal);
  const step = createSearchIdentityEpochParticipant({ search, prefix, routeKey });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      expect((await step(f.pool, job)).state).toBe('more');
    } catch (error) {
      expect(error).toMatchObject({ code: 'identity_epoch_unavailable' });
    }
    expect((await store.readJob(f.pool, job))?.participants['search-canonical-index']).toBeNull();
  }
  const after = await f.admin.query(
    `SELECT writer_token,dispatch_state FROM search.identity_writer
     WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
    [subjectPartition(original), index, original],
  );
  expect(after.rows).toEqual(before.rows);
  expect((await store.readJob(f.pool, job))?.state).toBe('pending');
});

test('fixed Search progresses past released scopes through OLD and NEW without losing native applied replay', async () => {
  const { original, terminal } = await originals(0xb410);
  const guard = writer();
  await guard.write(subjectPartition(original), [original], 0n);
  await guard.write(subjectPartition(terminal), [terminal], 0n);
  const job = await admitted(original, terminal);
  const done = await complete(job);
  const saved = await records(job);
  expect(new Set(saved.map((row) => row.binding.source.disposition))).toEqual(new Set(['OLD', 'NEW']));
  expect(
    (
      await f.admin.query(
        'SELECT 1 FROM search.identity_receiving_native_scope_pending WHERE job_id=$1 AND job_epoch=$2',
        [job.jobId, String(job.epoch)],
      )
    ).rowCount,
  ).toBe(0);
  const replay = await complete(job);
  expect(replay.receipt).toEqual(done.receipt);
  expect(replay.frontier).toEqual(done.frontier);
  expect(await records(job)).toEqual(saved);
});

test('a crash before durable scope retirement preserves its queue key and resumes the original applied transaction', async () => {
  const { original, terminal } = await originals(0xb510);
  await writer().write(subjectPartition(original), [original], 0n);
  const job = await admitted(original, terminal);
  await interruptNativeStatement(f, /DELETE FROM search\.identity_receiving_native_scope_pending/i, () =>
    complete(job),
  );
  const applied = (await records(job)).filter((row) => row.applied_transaction_id !== null);
  expect(applied.length).toBeGreaterThan(0);
  for (const row of applied) {
    expect(
      (
        await f.admin.query(
          'SELECT 1 FROM search.identity_receiving_native_scope_pending WHERE job_id=$1 AND job_epoch=$2 AND effect_key=$3',
          [job.jobId, String(job.epoch), row.effect_key],
        )
      ).rowCount,
    ).toBe(1);
  }
  await complete(job);
  const resumed = await records(job);
  for (const row of applied)
    expect(resumed.find((entry) => entry.effect_key === row.effect_key)?.applied_transaction_id).toBe(
      row.applied_transaction_id,
    );
  expect(
    (
      await f.admin.query(
        'SELECT 1 FROM search.identity_receiving_native_scope_pending WHERE job_id=$1 AND job_epoch=$2',
        [job.jobId, String(job.epoch)],
      )
    ).rowCount,
  ).toBe(0);
});

test('failure of the fixed step rolls back both common application and native frontier before resuming', async () => {
  const { original, terminal } = await originals(0xb610);
  await writer().write(subjectPartition(original), [original], 0n);
  const job = await admitted(original, terminal);
  await interruptNativeStatement(f, /INSERT INTO semantic\.identity_epoch_step/i, () => complete(job));
  expect((await records(job)).every((row) => row.applied_transaction_id === null)).toBe(true);
  expect(
    (
      await f.admin.query(
        `SELECT o.plan_id FROM search.identity_receiving_native_operation o
     JOIN search.identity_receiving_native_plan p USING(partition_no,plan_id)
     WHERE p.job_id=$1 AND p.job_epoch=$2 AND (o.state='applied' OR o.frontier IS NOT NULL)`,
        [job.jobId, String(job.epoch)],
      )
    ).rowCount,
  ).toBe(0);
  await complete(job);
  expect((await records(job)).every((row) => row.same_applied_transaction === true)).toBe(true);
});

test('post-control release rollback retries through fresh terminal reconciliation with the original applied custody', async () => {
  const { original, terminal } = await originals(0xb710);
  await writer().write(subjectPartition(original), [original], 0n);
  const job = await admitted(original, terminal);
  await interruptNativeStatement(f, /UPDATE search\.identity_receiving_native_hold SET released_transaction_id/i, () =>
    complete(job),
  );
  const retained = (await records(job)).filter((row) => row.applied_transaction_id !== null);
  expect(retained.length).toBeGreaterThan(0);
  expect(
    (await f.admin.query('SELECT 1 FROM semantic.identity_epoch_receiving_custody WHERE job_id=$1', [job.jobId]))
      .rowCount,
  ).toBeGreaterThan(0);
  const before = await f.admin.query(
    `SELECT h.plan_id FROM search.identity_receiving_native_hold h
     JOIN search.identity_receiving_native_plan p USING(partition_no,plan_id)
     WHERE p.job_id=$1 AND h.released_transaction_id IS NULL`,
    [job.jobId],
  );
  expect(before.rowCount).toBeGreaterThan(0);
  await complete(job);
  const resumed = await records(job);
  for (const row of retained)
    expect(resumed.find((entry) => entry.effect_key === row.effect_key)?.applied_transaction_id).toBe(
      row.applied_transaction_id,
    );
  expect(
    (
      await f.admin.query(
        `SELECT h.plan_id FROM search.identity_receiving_native_hold h
     JOIN search.identity_receiving_native_plan p USING(partition_no,plan_id)
     WHERE p.job_id=$1 AND h.released_transaction_id IS NULL`,
        [job.jobId],
      )
    ).rowCount,
  ).toBe(0);
});
