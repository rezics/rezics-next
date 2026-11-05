import { afterAll, expect, test } from 'bun:test';
import { RELEASE_FORMAT, releaseDigest } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createPublicFilterCustody, stepRetainedObservationErasure } from '../../src/search/public-filter-custody.ts';
import type { CustodyDefinition } from '../../src/search/public-filter-custody-contract.ts';
import type { PublicFilterQueriedObservation } from '../../src/search/public-filter-consumer-contract.ts';

// Focused native copy outcomes. These do not substitute for sealed all-role participant acceptance.
const pool = createPool(process.env.DATABASE_URL!);
const search = createOpenSearch(process.env.OPENSEARCH_URL!);
const custody = createPublicFilterCustody(pool);
const indices: string[] = [];
const context = () => ({ deadline: Date.now() + 5000 });
afterAll(async () => {
  await custody.close();
  for (const index of indices) await search.request('DELETE', `/${index}`);
  await pool.end();
});

async function fixture() {
  const index = `erasure-copy-${crypto.randomUUID()}`;
  await search.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
  indices.push(index);
  const release: CustodyDefinition['meaning']['release'] = {
    format: RELEASE_FORMAT,
    catalogue: { id: 'boundary', version: '1' },
    generator: { name: 'fixture', version: '1' },
    prefixes: {},
    types: {},
    properties: {},
  };
  const registered = await custody.register(
    {
      physicalTarget: index,
      consumerGeneration: '1',
      projectionGeneration: '1',
      definition: {
        source: { id: crypto.randomUUID(), partition: 7, epoch: 1, configuration: 'native-boundary-fixture' },
        readDefinition: crypto.randomUUID(),
        meaning: { digest: releaseDigest(release), release, type: 'fixture' },
        capture: { filterDocument: undefined, text: undefined, sort: 'id', size: 20 },
        dependencyKeys: [{ kind: 'order', order: 'id' }],
      },
    },
    search,
    context(),
  );
  if (registered.status !== 'registered') throw new Error(registered.reason);
  const registration = registered.registration;
  function copy(q: PublicFilterQueriedObservation) {
    return {
      partition: registration.partition,
      registration: registration.id,
      observation: q.snapshot.observation,
      incarnation: q.consumer.incarnation,
    };
  }
  return { ...registered, copy };
}

test('located PIT executions and prepared duplicate payloads are physically removed, retaining reusable registration', async () => {
  const f = await fixture();
  const covered = { observation: crypto.randomUUID() };
  const pit = await custody.openPit({ registration: f.registration, covered, keepAliveMs: 300_000 }, search, context());
  if (pit.status !== 'retained') throw new Error(pit.reason);
  const prepared = await custody.retainPrepared(
    {
      registration: f.registration,
      covered,
      build: 'old',
      generation: 1n,
      rows: [{ original: 'erased-original', terminal: 'survivor' }],
      expiresAt: Date.now() + 300_000,
    },
    context(),
  );
  if (prepared.status !== 'retained') throw new Error(prepared.reason);
  for (const q of [pit.queried, prepared.queried]) {
    const use = await custody.acquire(q, context());
    if (use.status !== 'acquired') throw new Error(use.reason);
    const appended = await custody.appendExecution(
      {
        use: use.use,
        execution: {
          id: crypto.randomUUID(),
          start: covered,
          ownRows: [{ original: 'erased-original', terminal: 'survivor' }],
        },
      },
      context(),
    );
    expect(appended.status).toBe('appended');
    await custody.release(use.use, context());
    let removed = false;
    for (let step = 0; step < 8; step++) {
      const progress = await stepRetainedObservationErasure(pool, f.copy(q), search, context());
      expect(progress.state).not.toBe('pending');
      if (progress.state === 'removed') {
        removed = true;
        break;
      }
    }
    expect(removed).toBe(true);
    const children = await pool.query(
      `SELECT
      (SELECT count(*) FROM search.public_filter_observation WHERE observation=$1) +
      (SELECT count(*) FROM search.public_filter_execution WHERE observation=$1) +
      (SELECT count(*) FROM search.public_filter_pit WHERE observation=$1) AS count`,
      [q.snapshot.observation],
    );
    expect(Number(children.rows[0].count)).toBe(0);
  }
  const duplicate = await pool.query(
    `SELECT rows,state FROM search.public_filter_prepared
    WHERE (partition_no,registration,build,generation)=($1,$2,'old',1)`,
    [f.registration.partition, f.registration.id],
  );
  expect(duplicate.rows[0].state).toBe('erasing');
  expect(duplicate.rows[0].rows).not.toContain('erased-original');
  expect(
    (
      await pool.query('SELECT state FROM search.public_filter_registration WHERE (partition_no,id)=($1,$2)', [
        f.registration.partition,
        f.registration.id,
      ])
    ).rows[0].state,
  ).toBe('active');
});

test('no configuration leaves a retained native PIT pending, and a live use delays cleanup', async () => {
  const f = await fixture();
  const pit = await custody.openPit(
    { registration: f.registration, covered: { observation: crypto.randomUUID() }, keepAliveMs: 300_000 },
    search,
    context(),
  );
  if (pit.status !== 'retained') throw new Error(pit.reason);
  const use = await custody.acquire(pit.queried, context());
  if (use.status !== 'acquired') throw new Error(use.reason);
  expect((await stepRetainedObservationErasure(pool, f.copy(pit.queried), search, context())).reason).toBe('in-use');
  await custody.release(use.use, context());
  const pending = await stepRetainedObservationErasure(pool, f.copy(pit.queried), undefined, context());
  expect(pending.state).toBe('pending');
  expect(pending.reason).toBe('configuration-unavailable');
  expect(
    (
      await pool.query('SELECT state FROM search.public_filter_pit WHERE observation=$1', [
        pit.queried.snapshot.observation,
      ])
    ).rows[0].state,
  ).toBe('owned');
  expect((await custody.acquire(pit.queried, context())).status).not.toBe('acquired');
});

test('a late prepared capture cannot resurrect the erased immutable generation', async () => {
  const f = await fixture();
  const input = {
    registration: f.registration,
    covered: { observation: crypto.randomUUID() },
    build: 'late',
    generation: 1n,
    rows: [{ original: 'erased-original', terminal: 'survivor' }],
    expiresAt: Date.now() + 300_000,
  };
  const prepared = await custody.retainPrepared(input, context());
  if (prepared.status !== 'retained') throw new Error(prepared.reason);
  expect((await stepRetainedObservationErasure(pool, f.copy(prepared.queried), search, context())).state).toBe(
    'removed',
  );
  expect((await custody.retainPrepared(input, context())).status).not.toBe('retained');
  expect((await stepRetainedObservationErasure(pool, f.copy(prepared.queried), search, context())).state).toBe(
    'removed',
  );
});

test('a prepared payload survives observation close only until bounded registration erasure scrubs its independent copy', async () => {
  const { stepRetainedTargetErasure } = await import('../../src/search/public-filter-custody.ts');
  const f = await fixture();
  const prepared = await custody.retainPrepared(
    {
      registration: f.registration,
      covered: { observation: crypto.randomUUID() },
      build: 'orphan',
      generation: 1n,
      rows: [{ original: 'erased-original', terminal: 'survivor' }],
      expiresAt: Date.now() + 300_000,
    },
    context(),
  );
  if (prepared.status !== 'retained') throw new Error(prepared.reason);
  await custody.closeObservation(prepared.queried, search, context());
  let after: string | null = null;
  let complete = false;
  for (let n = 0; n < 12; n++) {
    const result = await stepRetainedTargetErasure(
      pool,
      { partition: f.registration.partition, physicalTarget: f.consumer.physicalTarget, after },
      search,
      context(),
    );
    expect(result.state).not.toBe('pending');
    after = result.after;
    if (result.state === 'complete') {
      complete = true;
      break;
    }
  }
  expect(complete).toBe(true);
  const rows = await pool.query(
    `SELECT rows,state FROM search.public_filter_prepared
    WHERE (partition_no,registration,build,generation)=($1,$2,'orphan',1)`,
    [f.registration.partition, f.registration.id],
  );
  expect(rows.rows[0].state).toBe('erasing');
  expect(rows.rows[0].rows).not.toContain('erased-original');
});

test('new native captures advance retained-copy admission even when the public result is empty', async () => {
  const f = await fixture();
  const revision = async () =>
    (
      await pool.query(
        `SELECT copy_revision::text FROM search.public_filter_target
    WHERE (partition_no,physical_target)=($1,$2)`,
        [f.registration.partition, f.consumer.physicalTarget],
      )
    ).rows[0].copy_revision;
  const before = await revision();
  const prepared = await custody.retainPrepared(
    {
      registration: f.registration,
      covered: { observation: crypto.randomUUID() },
      build: 'excluded',
      generation: 1n,
      rows: [],
      expiresAt: Date.now() + 300_000,
    },
    context(),
  );
  expect(prepared.status).toBe('retained');
  expect(BigInt(await revision())).toBeGreaterThan(BigInt(before));
});
