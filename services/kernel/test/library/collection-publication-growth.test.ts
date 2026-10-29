import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import type { CollectionView } from '../../src/library/collection-reads.ts';
import { applySubjectListing, syncSubjectListing } from '../../src/library/listing.ts';
import { observeListingSource } from '../../src/library/listing-source-observer.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { anchorRoute, routeOf } from '../../src/route/route.ts';
import { CREATE_SUBJECT } from '../../src/semantic/subject.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import { composeWork } from '../../src/work/registry.ts';
import { nativeFixture, cookies, password } from '../access/native-account-bindings-fixture.ts';
import { testKernel, registerTestClient } from '../support/test-kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase } from '../support/growth.ts';
import { decodeSession, type SessionComponent } from '../../src/tokens/session.ts';
import { testTokens, testRouteKey } from '../support/test-kernel.ts';

const db = await openGrowthDatabase();
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof testKernel>;
let bearer: string;
let ownerId: string;
const publicationPositions = new Map<string, SessionComponent>();
let client: Awaited<ReturnType<typeof createWorkClient>>;
let worker: Awaited<ReturnType<typeof composeWork>>;

async function call(method: string, path: string, body?: unknown, key = randomUUID()) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  expect(response.status, JSON.stringify(value)).toBeGreaterThanOrEqual(200);
  expect(response.status, JSON.stringify(value)).toBeLessThan(300);
  const collectionId =
    value?.collection?.id ?? (method === 'DELETE' ? /^\/v1\/collections\/([^/?]+)\?/.exec(path)?.[1] : undefined);
  if (collectionId) {
    const session = response.headers.get(SESSION_HEADER);
    const position =
      session &&
      decodeSession(testTokens(), `account:${ownerId}`, session)?.find(
        (component) => component.partition === routeOf(collectionId)! >> 4,
      );
    if (position) publicationPositions.set(collectionId, position);
  }
  return value;
}
async function subject(partition?: number) {
  let key = randomUUID();
  // Select native request routing, never insert or relocate a domain fact in a fixture.
  while (
    partition !== undefined &&
    anchorRoute(testRouteKey(), `${ownerId}\n${CREATE_SUBJECT}\n${key}`) >>> 4 !== partition
  )
    key = randomUUID();
  return (
    await call('POST', '/v1/subjects', { type: 'schema:Book', labels: { en: 'Native publication subject' } }, key)
  ).subject.id as string;
}
async function collection(visibility = 'public') {
  return (await call('POST', '/v1/collections', { title: 'Native publication Collection', visibility }))
    .collection as CollectionView;
}
async function add(collectionId: string, subjectId: string) {
  return (await call('POST', `/v1/collections/${collectionId}/members`, { subjectId })).member.id as string;
}
async function flip(row: CollectionView, visibility: string) {
  return (await call('PATCH', `/v1/collections/${row.id}`, { revision: row.revision, visibility }))
    .collection as CollectionView;
}
async function notification(collectionId: string): Promise<CloudEvent> {
  const position = publicationPositions.get(collectionId)!;
  const row = (
    await db.admin.query(
      "SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2 AND subject=$3 AND type='com.rezics.library.collection.listing.changed.v1'",
      [position.partition, position.position.toString(), collectionId],
    )
  ).rows[0]!;
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    subject: collectionId,
    time: row.recorded_at.toISOString(),
    sequence: String(row.position).padStart(19, '0'),
    datacontenttype: 'application/json',
    data: row.data,
  };
}
async function publish(event: CloudEvent) {
  await (
    await client.enqueue(
      {
        workflowName: 'effect',
        queueName: 'effects',
        queuePartitionKey: String(routeOf(event.subject!)! >> 4),
        workflowID: randomUUID(),
      },
      'library_collection_listing',
      event,
    )
  ).getResult({ pollingIntervalMs: 10 });
  await client.retrieveWorkflow(event.id).getResult({ pollingIntervalMs: 10 });
}
async function count(subjectId: string, expected: number) {
  const page = await call('GET', `/v1/subjects/${subjectId}/collections?limit=1`);
  expect(page.count).toEqual({ value: expected, exact: true });
  return page;
}

beforeAll(async () => {
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'native-publication-growth-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 60 } } }),
    }),
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((action) => action !== 'media:complete');
  await registerTestClient(service, { clientId: 'publication', firstParty: true, scopes });
  const owner = await auth.person(`publication_${randomUUID().replaceAll('-', '')}`);
  ownerId = owner.accountId;
  await bootstrapGovernance(db.pool, owner.accountId);
  const signed = await auth.request('/signin', {
    account_id: owner.accountId,
    password,
    client_id: 'publication',
    scope: scopes,
  });
  expect(signed.status).toBe(200);
  const issued = await auth.request('/token', {}, cookies(signed));
  expect(issued.status).toBe(200);
  bearer = ((await issued.json()) as { access_token: string }).access_token;
  await bootstrapRelease(db.pool, bundledRelease);
  await call('POST', '/v1/platform/exposure/collections:open');
  await call('POST', '/v1/grants', {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'active_accounts' },
    actions: ['subject:create'],
    valid: '(,)',
  });
  // Capture the command module's actual second pool too, without changing its implementation.
  const NativePool = pg.Pool;
  pg.Pool = class extends NativePool {
    constructor(config?: pg.PoolConfig) {
      super(config);
      pg.Pool = NativePool;
      return db.openPool(config);
    }
  };
  try {
    await collection('private');
  } finally {
    pg.Pool = NativePool;
  }
  // Auth and Kernel each own the SDK in their process lifetime; registration has completed.
  await auth.stop();
  client = await createWorkClient(db.url);
  worker = await composeWork(KERNEL_WORK_MODULES, {
    databaseUrl: db.url,
    pool: db.openPool({ max: 10 }),
    client,
    env: workerTestEnv({ DATABASE_URL: db.url }),
  });
  await worker.launch();
}, 180_000);

afterAll(async () => {
  await worker?.shutdown();
  await client?.close();
  await auth?.close();
  await db.close();
});

test('native publication orders released observations across retries, duplicates, visibility cycles and deletion', async () => {
  const s = await subject();
  let c = await collection();
  const first = await add(c.id, s);
  await add(c.id, s);
  const oldPublic = await observeListingSource(db.pool, { collectionId: c.id, subjectId: s });
  // The observer's RR transaction has returned/released before the actual source command.
  c = await flip(c, 'private');
  const oldPrivate = await observeListingSource(db.pool, { collectionId: c.id, subjectId: s });
  await publish(await notification(c.id));
  await applySubjectListing({ pool: db.pool }, oldPublic);
  await count(s, 0);
  c = await flip(c, 'public');
  await publish(await notification(c.id));
  await applySubjectListing({ pool: db.pool }, oldPrivate);
  const page = await count(s, 1);
  expect(page.collections).toMatchObject([{ id: c.id, multiplicity: 2 }]);
  const current = await observeListingSource(db.pool, { collectionId: c.id, subjectId: s });
  await expect(applySubjectListing({ pool: db.pool }, { ...current, multiplicity: 1 })).rejects.toThrow('equal-stamp');
  await count(s, 1);
  await call('DELETE', `/v1/collections/${c.id}/members/${first}`);
  await syncSubjectListing({ pool: db.pool }, { collectionId: c.id, subjectId: s });
  expect((await count(s, 1)).collections[0].multiplicity).toBe(1);
  await call('DELETE', `/v1/collections/${c.id}?revision=${c.revision}`);
  const deleted = await notification(c.id);
  await publish(deleted);
  await applySubjectListing({ pool: db.pool }, oldPublic);
  await applySubjectListing({ pool: db.pool }, current);
  await publish(deleted);
  await publish({ ...deleted, id: randomUUID() });
  await count(s, 0);
  const version = (
    await db.admin.query(
      'SELECT multiplicity FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
      [routeOf(s), s, c.id],
    )
  ).rows;
  expect(version).toEqual([{ multiplicity: 0 }]);
}, 120_000);

test('a finite native workflow segment continues from its durable Collection locator', async () => {
  const c = await collection();
  const subjects: string[] = [];
  for (let i = 0; i < 201; i++) {
    const s = await subject();
    subjects.push(s);
    await add(c.id, s);
  }
  const event = await notification(c.id);
  await publish(event);
  const steps = await client.listWorkflowSteps(event.id);
  expect(steps?.filter((step) => step.name === 'library.syncCollectionPage')).toHaveLength(2);
  expect(steps?.filter((step) => step.name === 'library.continueCollectionListing')).toHaveLength(1);
  const after = [...subjects].sort()[199]!;
  await client.retrieveWorkflow(`${event.id}:${after}`).getResult({ pollingIntervalMs: 10 });
  await count(subjects[200]!, 1);
  const pairs = await db.admin.query(
    'SELECT subject_id FROM library.subject_collection WHERE collection_route=$1 AND collection_id=$2 ORDER BY route, subject_id',
    [routeOf(c.id), c.id],
  );
  expect(pairs.rows.map((row) => row.subject_id).sort()).toEqual([...subjects].sort());
}, 180_000);

test('a collapsed public-private-public cycle advances ordering without publishing a public change', async () => {
  const s = await subject();
  let c = await collection();
  await add(c.id, s);
  await publish(await notification(c.id));
  const publicState = async () => ({
    listing: (
      await db.admin.query('SELECT * FROM library.subject_listing WHERE route=$1 AND subject_id=$2', [routeOf(s), s])
    ).rows,
    events: (
      await db.admin.query(
        "SELECT * FROM core.outbox WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.library.subject.listed.v1' ORDER BY position,event_seq",
        [routeOf(s)! >> 4, s],
      )
    ).rows,
  });
  const before = await publicState();
  c = await flip(c, 'private');
  const delayedPrivate = await observeListingSource(db.pool, { collectionId: c.id, subjectId: s });
  c = await flip(c, 'public');
  const current = await observeListingSource(db.pool, { collectionId: c.id, subjectId: s });
  await publish(await notification(c.id));
  expect(await publicState()).toEqual(before);
  expect(
    (
      await db.admin.query(
        'SELECT source_epoch,source_position FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
        [routeOf(s), s, c.id],
      )
    ).rows,
  ).toEqual([{ source_epoch: current.stamp.epoch, source_position: current.stamp.position.toString() }]);
  await applySubjectListing({ pool: db.pool, client }, delayedPrivate);
  expect(await publicState()).toEqual(before);
  await count(s, 1);
}, 120_000);

for (const axis of ['Collections', 'subjects', 'member history', 'partitions'] as const) {
  test(`native visibility publication rows, blocks and statements ignore unrelated ${axis}`, async () => {
    const unrelatedSubject = await subject();
    const fixedPartition = routeOf(unrelatedSubject)! >> 4;
    const populatedPartitions = new Set<number>();
    const history = await collection('private');
    const targets: { collection: CollectionView; subjects: string[] }[] = [];
    // Every measured write/effect uses fresh real source truth, with a fixed four-subject page.
    for (let i = 0; i < 30; i++) {
      const c = await collection();
      const subjects = await Promise.all(Array.from({ length: 4 }, () => subject()));
      for (const s of subjects) await add(c.id, s);
      await add(c.id, subjects[0]!);
      await publish(await notification(c.id));
      targets.push({ collection: c, subjects });
    }
    const execute = async (_db: typeof db, _scale: number, repetition: number) => {
      const target = targets[repetition]!;
      const c = await flip(target.collection, 'private');
      const event = await notification(c.id);
      await publish(event);
      // Redelivery uses the actual effect and the workflow's existing durable identity.
      await publish(event);
    };
    const report = await checkGrowth(db, {
      name: `Collection visibility publication / unrelated ${axis}`,
      scales: [1, 4, 16],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (_db, scale, previous) => {
        for (let i = previous * 8; i < scale * 8; i++) {
          if (axis === 'Collections') {
            const c = await collection('private');
            await add(c.id, unrelatedSubject);
          } else if (axis === 'member history') {
            const m = await add(history.id, unrelatedSubject);
            await call('DELETE', `/v1/collections/${history.id}/members/${m}`);
          } else {
            const partition = axis === 'partitions' ? (fixedPartition + i + 1) % 4096 : fixedPartition;
            const s = await subject(partition);
            expect(routeOf(s)! >> 4).toBe(partition);
            populatedPartitions.add(partition);
            if (axis === 'partitions') {
              const c = await collection('private');
              await add(c.id, s);
            }
          }
        }
        if (axis === 'subjects') expect(populatedPartitions.size).toBe(1);
        if (axis === 'partitions') expect(populatedPartitions.size).toBe(scale * 8);
      },
      operation: execute,
      warmup: execute,
    });
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBeGreaterThan(0);
      expect(sample.cost.blocks).toBeGreaterThan(0);
      expect(sample.cost.statements).toBeGreaterThan(0);
      for (const relation of Object.keys(sample.cost.relations))
        expect(/library\.(entry|label|progress_session|copy|follow)/.test(relation)).toBe(false);
    }
    console.log(
      JSON.stringify({
        check: report.name,
        samples: report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
        })),
      }),
    );
    // Subject reads retain their fixed page budget and one maintained subject-key count.
    const read = await capture(db, () => count(targets[0]!.subjects[0]!, 0));
    const cost = costOf(read.capture);
    expect(cost.relations['library.subject_listing']?.rows).toBe(1);
    expect(read.capture.statements.filter((sql) => /public_collection_count/.test(sql))).toHaveLength(1);
  }, 180_000);
}

test('native visibility publication grows linearly only with the changed Collection subjects', async () => {
  let targets: { collection: CollectionView; subjects: string[] }[] = [];
  let index = 0;
  const report = await checkGrowth(db, {
    name: 'Collection visibility publication / affected subjects',
    scales: [1, 4, 16],
    bounds: { rows: 'linear', blocks: 'linear', statements: 'linear' },
    grow: async (_db, scale) => {
      targets = [];
      index = 0;
      for (let i = 0; i < 10; i++) {
        const c = await collection();
        const subjects: string[] = [];
        for (let j = 0; j < scale; j++) {
          const s = await subject();
          subjects.push(s);
          await add(c.id, s);
        }
        await publish(await notification(c.id));
        targets.push({ collection: c, subjects });
      }
    },
    operation: async () => {
      const target = targets[index++]!;
      const c = await flip(target.collection, 'private');
      await publish(await notification(c.id));
    },
  });
  console.log(
    JSON.stringify({
      check: report.name,
      samples: report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
      })),
    }),
  );
  for (const target of targets.slice(0, index)) for (const s of target.subjects) await count(s, 0);
}, 180_000);
