import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { runCommand } from '../../src/command/command.ts';
import { insertAcceptance, slotId } from '../../src/semantic/slots.ts';
import { startRelays } from '../../src/events/relays.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { providerReviewProjection, registerProviderReviewWork } from '../../src/semantic/provider-review-queue.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';
import {
  attributionFixture,
  cited,
  global,
  source,
  status,
  type AttributionFixture,
} from './support/source-record-attribution.ts';

let db: GrowthDatabase;
let f: AttributionFixture;
let worker: Awaited<ReturnType<typeof startWorker>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let relay: ReturnType<typeof startRelays>;
const provider = `queue_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
const endpoint = `/v1/review-candidates?source=${provider}`;
const books: { id: string; candidate: string; origin: ReturnType<typeof source> }[] = [];
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await attributionFixture(db);
  for (let index = 0; index < 3; index++) {
    const origin = source(crypto.randomUUID(), provider);
    const book = await f.create(origin);
    books.push({ id: book.id, candidate: await f.propose(book.id, origin, cited()), origin });
  }
});
async function startQueueWorker() {
  const env = workerTestEnv({ DATABASE_URL: db.url });
  // Same work registration and native relay as production, inside the existing worker lifecycle.
  worker = await startWorker(
    readWorkerConfig(env),
    [
      {
        name: 'semantic',
        register(context) {
          registerProviderReviewWork(context);
          context.addService(() => (relay = startRelays(context.pool, [providerReviewProjection(context.pool)])));
        },
      },
    ],
    env,
  );
  client = await createWorkClient(db.url);
}
afterAll(async () => {
  await worker?.stop();
  await client?.close();
  await db?.close();
});

test('explicit derived preparation builds a real native page; GET does no bootstrap and grants no adoption', async () => {
  status(await f.call('GET', endpoint), 503);
  expect(
    (await db.admin.query('SELECT 1 FROM semantic.provider_review_queue_bootstrap WHERE source=$1', [provider]))
      .rowCount,
  ).toBe(0);
  await startQueueWorker();
  status(await f.call('POST', '/v1/review-candidates:prepare', { source: provider, extra: true }), 422);
  expect(status(await f.call('POST', '/v1/review-candidates:prepare', { source: provider }), 202)).toEqual({
    preparing: true,
  });
  const [work] = await client.listWorkflows({ workflowName: 'semantic.provider-review.prepare', limit: 1 });
  expect(work).toBeDefined();
  await client.retrieveWorkflow(work!.workflowID).getResult({ pollingIntervalMs: 10 });
  const page = status(await f.call('GET', endpoint), 200);
  expect(Object.keys(page).sort()).toEqual(['candidates', 'freshness', 'next']);
  expect(page.candidates).toHaveLength(3);
  expect(page.candidates[0].candidate).toMatchObject({
    source: { source: provider },
    decision: null,
    head: null,
    rank: null,
    statement: { value: { type: 'value', content: 'ja' } },
  });
  await f.real.grant(global, 'ordinary', 'context:accept');
  expect(status(await f.call('GET', endpoint, undefined, 'ordinary'), 200).candidates).toHaveLength(3);
  status(
    await f.call(
      'POST',
      `/v1/subjects/${books[0]!.id}:adopt`,
      {
        context: GLOBAL_CONTEXT,
        property: 'schema:inLanguage',
        mode: 'replace',
        selection: [{ candidate: books[0]!.candidate, rank: 'normal' }],
        expected_head: null,
      },
      'ordinary',
    ),
    403,
  );
}, 240_000);

test('native scope-bound continuation rejects changed viewer/source/Context/status and remains opaque', async () => {
  const first = status(await f.call('GET', `${endpoint}&limit=1`), 200);
  expect(first.candidates).toHaveLength(1);
  expect(first.next).toBeString();
  expect(first.next).not.toContain(first.candidates[0].subject);
  const cursor = encodeURIComponent(first.next);
  const tail = status(await f.call('GET', `${endpoint}&limit=100&cursor=${cursor}`), 200);
  expect(tail.candidates).toHaveLength(2);
  for (const changed of [
    `${endpoint}&status=accepted_unselected`,
    `/v1/review-candidates?source=other_provider`,
    `${endpoint}&context=${newId(32100)}`,
  ])
    status(await f.call('GET', `${changed}&cursor=${cursor}`), 400);
  status(await f.call('GET', `${endpoint}&cursor=${cursor}`, undefined, 'ordinary'), 400);
  status(await f.call('GET', `${endpoint}&cursor=invalid`), 400);
  status(await f.call('GET', `${endpoint}&context=${newId(32100)}`), 404);
  status(await f.call('GET', '/v1/review-candidates?source=Bad%20Provider'), 422);
  await f.real.revoke(global, 'ordinary', 'context:accept');
  status(await f.call('GET', endpoint, undefined, 'ordinary'), 403);
});

test('contributor proposals preserve native decisions and pending abstentions', async () => {
  const reviewSource = `queue_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const reviewEndpoint = `/v1/review-candidates?source=${reviewSource}`;
  const proposals: { id: string; candidate: string }[] = [];
  for (let index = 0; index < 4; index++) {
    const origin = source(crypto.randomUUID(), reviewSource);
    const book = await f.create(origin);
    proposals.push({ id: book.id, candidate: await f.propose(book.id, origin, cited()) });
  }

  expect(status(await f.call('POST', '/v1/review-candidates:prepare', { source: reviewSource }), 202)).toEqual({
    preparing: true,
  });
  const [work] = await client.listWorkflows({ workflowName: 'semantic.provider-review.prepare', limit: 1 });
  expect(work).toBeDefined();
  await client.retrieveWorkflow(work!.workflowID).getResult({ pollingIntervalMs: 10 });

  const contributorPage = status(await f.call('GET', reviewEndpoint), 200);
  const reviewerPage = status(await f.call('GET', reviewEndpoint, undefined, 'editor'), 200);
  expect(contributorPage.candidates.map((row: any) => row.candidate.id).sort()).toEqual(
    proposals.map((proposal) => proposal.candidate).sort(),
  );
  expect(reviewerPage.candidates.map((row: any) => row.candidate.id).sort()).toEqual(
    proposals.map((proposal) => proposal.candidate).sort(),
  );

  const accepted = status(
    await f.call(
      'POST',
      `/v1/subjects/${proposals[0]!.id}/candidates/${proposals[0]!.candidate}:accept`,
      { context: GLOBAL_CONTEXT, expected_head: null },
      'editor',
    ),
    200,
  );
  const rejected = status(
    await f.call(
      'POST',
      `/v1/subjects/${proposals[1]!.id}/candidates/${proposals[1]!.candidate}:reject`,
      { context: GLOBAL_CONTEXT, expected_head: null },
      'editor',
    ),
    200,
  );
  expect(accepted.acceptance.decision).toBe('accept');
  expect(rejected.acceptance.decision).toBe('reject');
  const abstained = proposals[3]!;
  await runCommand(db.pool, { partition: partitionOf(routeOf(abstained.id)!) }, async (tx) => {
    const slot = slotId(abstained.id, 'schema:inLanguage');
    await insertAcceptance(tx, abstained.id, abstained.candidate, GLOBAL_CONTEXT, null, 'abstain', 2, slot);
    return { value: null, events: [] };
  });
  const native = status(await f.call('GET', `/v1/subjects/${abstained.id}/candidates?property=schema:inLanguage`), 200);
  expect(native.candidates[0]).toMatchObject({ id: abstained.candidate, decision: 'abstained', head: 1, rank: null });
  const rejectedSubject = status(await f.call('GET', `/v1/subjects/${proposals[1]!.id}`), 200);
  expect(rejectedSubject.statements['schema:inLanguage'][0].rank).toBe('deprecated');

  const acceptedPage = status(
    await f.call('GET', `${reviewEndpoint}&status=accepted_unselected`, undefined, 'editor'),
    200,
  );
  expect(acceptedPage.candidates).toHaveLength(1);
  expect(acceptedPage.candidates[0]).toMatchObject({
    candidate: { id: proposals[0]!.candidate, decision: 'accepted', rank: null },
  });
  const pendingPage = status(await f.call('GET', reviewEndpoint, undefined, 'editor'), 200);
  expect(pendingPage.candidates).toHaveLength(2);
  expect(pendingPage.candidates.find((row: any) => row.candidate.id === abstained.candidate).candidate).toEqual(
    native.candidates[0],
  );
  expect(pendingPage.candidates.find((row: any) => row.candidate.id === proposals[2]!.candidate)).toMatchObject({
    candidate: { id: proposals[2]!.candidate, decision: null, head: null, rank: null },
  });
});

test('paused projection cannot revive decisions, selection, retraction or current account denial; private progress is 202', async () => {
  await relay.pause();
  const book = books[0]!;
  status(
    await f.call('POST', `/v1/subjects/${book.id}/candidates/${book.candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    }),
    200,
  );
  const pending = status(await f.call('GET', endpoint), 200);
  expect(pending.candidates.some((row: any) => row.candidate.id === book.candidate)).toBe(false);
  const accepted = status(await f.call('GET', `${endpoint}&status=accepted_unselected`), 200);
  expect(accepted.candidates.map((row: any) => row.candidate.id)).toEqual([book.candidate]);
  expect(accepted.freshness.caught_up).toBe(false);
  const withdrawn = books[1]!;
  expect(
    (
      await f.batch({
        op: 'retract',
        key: crypto.randomUUID(),
        subject: withdrawn.id,
        candidate: withdrawn.candidate,
        source: withdrawn.origin,
        references: cited().references,
      })
    ).status,
  ).toBe(200);
  expect(
    status(await f.call('GET', endpoint), 200).candidates.some((row: any) => row.candidate.id === withdrawn.candidate),
  ).toBe(false);
  await f.adopt(book.id, [book.candidate]);
  const progressed = status(await f.call('GET', `${endpoint}&status=accepted_unselected`), 202);
  expect(Object.keys(progressed)).toEqual(['next']);
  status(
    await f.call('GET', `${endpoint}&status=accepted_unselected&cursor=${encodeURIComponent(progressed.next)}`),
    503,
  );
  // Current producer suspension is checked by hydration even though the discovery relay is paused.
  await suspendAccount(db.pool, f.accounts.importer);
  const concealed = status(await f.call('GET', endpoint, undefined, 'editor'), 202);
  expect(Object.keys(concealed)).toEqual(['next']);
});
