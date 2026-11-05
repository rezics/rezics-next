import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import type { IdentityEpochStep } from '../../src/semantic/identity-epoch-contract.ts';
import { identityEpochStore as store, identityJobPartition } from '../../src/semantic/identity-epoch-store.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { digest, epochFixture, release, type EpochFixture } from '../semantic/support/identity-epoch.ts';

const searchUrl = process.env.OPENSEARCH_URL;
if (!searchUrl) throw new Error('OPENSEARCH_URL must name the check node');
const search = createOpenSearch(searchUrl);
const prefix = `test-${randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const routeKey = crypto.getRandomValues(new Uint8Array(32));
let fixture: EpochFixture;
let created = false;

beforeAll(async () => {
  fixture = await epochFixture();
  await createSubjectIndex(search, prefix, 1);
  created = true;
});
afterAll(async () => {
  try {
    if (created) await search.request('DELETE', `/${index}`);
  } finally {
    await fixture?.close();
  }
});

async function participant(engine: OpenSearch): Promise<IdentityEpochStep> {
  // A missing production module is a failing delivery boundary, outside every
  // expected refusal below. No test participant or mapping implementation is used.
  const path = '../../src/search/identity-epoch-participant.ts';
  const implementation = await import(path);
  expect(implementation.createSearchIdentityEpochParticipant).toBeFunction();
  const create: (options: { search: OpenSearch; prefix: string; routeKey: Uint8Array }) => IdentityEpochStep =
    implementation.createSearchIdentityEpochParticipant;
  return create({ search: engine, prefix, routeKey });
}

test('Search rejects an unknown native job locator before any engine effect or completion receipt', async () => {
  let engineCalls = 0;
  const observed: OpenSearch = {
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      engineCalls++;
      return search.request<T>(...args);
    },
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      engineCalls++;
      return search.bulk<T>(...args);
    },
  };
  const step = await participant(observed);
  const job = { jobId: newId(0x7b10), epoch: 1n };
  expect(await store().readJob(fixture.pool, job)).toBeNull();
  await expect(step(fixture.pool, job)).rejects.toThrow();
  expect(engineCalls).toBe(0);
  expect(await store().readJob(fixture.pool, job)).toBeNull();
  const receipts = await fixture.admin.query(
    `SELECT transaction_id FROM semantic.identity_epoch_step
     WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND step='search-canonical-index'`,
    [identityJobPartition(job), job.jobId, job.epoch.toString()],
  );
  expect(receipts.rows).toEqual([]);
});

test('an admitted native job without authoritative mapping cannot complete Search or publish identity', async () => {
  const step = await participant(search);
  const redirected = (await fixture.create('Search pending original', 0x7b20)).subject.id;
  const survivor = (await fixture.create('Search pending terminal', 0x7b20)).subject.id;
  const actor = await fixture.actor();
  const key = randomUUID();
  const input = {
    intent: { kind: 'merge' as const, redirected, survivor, release: release.digest },
    receipt: {
      kind: 'subject.merge' as const,
      command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
    },
  };
  const job = await store().prepareAdmission(
    fixture.pool,
    {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await fixture.authorization('subject:merge'),
    },
    input,
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    const progress = await stepIdentityEpochAdmission(fixture.pool, job);
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    if (progress.state === 'pending') break;
  }
  const before = await store().readJob(fixture.pool, job);
  expect(before?.state).toBe('pending');
  expect(before?.mapping).toBeNull();
  expect(before?.participants['search-canonical-index']).toBeNull();
  expect(before?.participants['library-private-follow-counts']).toBeNull();

  // An unavailable prerequisite may refuse the step or retain real bounded work;
  // neither outcome is a Search completion or whole-publication certificate.
  try {
    const progress = await step(fixture.pool, job);
    expect(progress.job).toEqual(job);
    expect(progress.state).toBe('more');
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    await expect(store().reconcileStepReceipt(fixture.pool, progress.receipt)).rejects.toMatchObject({
      code: 'identity_step_receipt_invalid',
    });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'identity_epoch_unavailable') throw error;
  }
  const after = await store().readJob(fixture.pool, job);
  expect(after?.state).toBe('pending');
  expect(after?.mapping).toBeNull();
  expect(after?.participants['search-canonical-index']).toBeNull();
  expect(after?.participants['library-private-follow-counts']).toBeNull();
  await expect(
    runCommand(fixture.pool, { partition: identityJobPartition(job) }, (tx) => store().publish(tx, job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
});
