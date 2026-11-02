import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import {
  createPublicPreparation,
  type PublicPreparationOptions,
} from '../../src/search/public-preparation.ts';
import {
  PUBLIC_PREPARATION_WORKFLOW,
  createPublicPreparationStore,
  type PopulationFrontier,
  type PreparationRecord,
} from '../../src/search/public-preparation-store.ts';
import type { DefaultPublicFilterRuntime } from '../../src/search/public-runtime.ts';
import type { PublicFilterConsumerJob } from '../../src/search/public-filter-consumer-contract.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const pool = createPool(databaseUrl);
const work = await createWorkClient(databaseUrl);
const prefixes = new Set<string>();
const ids = new Set<string>();
const cost: PublicFilterCost = {
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};

beforeAll(async () => {
  await work.registerQueue('maintenance', WORK_QUEUES.maintenance);
});

afterAll(async () => {
  const owned = [...prefixes];
  if (owned.length > 0)
    await pool.query('DELETE FROM search.public_preparation WHERE partition_no = 0 AND prefix = ANY($1::text[])', [
      owned,
    ]);
  if (ids.size > 0) {
    const workflows = (
      await pool.query<{ workflow_uuid: string }>(
        `SELECT workflow_uuid FROM dbos.workflow_status
         WHERE workflow_uuid LIKE $1 AND split_part(workflow_uuid, ':', 2) = ANY($2::text[])`,
        [`${PUBLIC_PREPARATION_WORKFLOW}:%`, [...ids]],
      )
    ).rows.map((row) => row.workflow_uuid);
    if (workflows.length > 0) await work.deleteWorkflows(workflows, false);
  }
  await work.close();
  await pool.end();
});

function prefix(): string {
  const value = `pl-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.add(value);
  return value;
}

function track(id: string): string {
  ids.add(id);
  return id;
}

function repairJob(): PublicFilterConsumerJob {
  return {
    consumer: {
      physicalTarget: 'idx',
      incarnation: 'inc',
      consumerGeneration: '1',
      projectionGeneration: '1',
      meaningDigest: 'm',
      readDefinition: 'r',
    },
    job: crypto.randomUUID(),
  };
}

function population(key = '1'): PopulationFrontier {
  return {
    kind: 'population',
    key,
    generation: 1,
    uuid: crypto.randomUUID(),
    meaning: 'digest',
    publication: null,
    partition: 0,
    epoch: null,
    through: null,
    after: null,
    phase: 'scan',
    pending: null,
  };
}

function identity(id: string, revision: string): string {
  return `${PUBLIC_PREPARATION_WORKFLOW}:${id}:${revision}`;
}

async function read(owner: string, id: string) {
  const result = await pool.query<
    PreparationRecord & { kind: string; lease_until: string; due_at: string }
  >(
    `SELECT id, revision::text, kind, locator, expires_at::text, lease_until::text, due_at::text
     FROM search.public_preparation WHERE partition_no = 0 AND prefix = $1 AND id = $2`,
    [owner, id],
  );
  return result.rows[0] ?? null;
}

async function workflows(id: string): Promise<string[]> {
  const result = await pool.query<{ workflow_uuid: string }>(
    'SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid LIKE $1 ORDER BY workflow_uuid',
    [`${PUBLIC_PREPARATION_WORKFLOW}:${id}:%`],
  );
  return result.rows.map((row) => row.workflow_uuid);
}

function preparation(
  owner: string,
  repair: DefaultPublicFilterRuntime['repair'] = async (job) => ({ status: 'settled', job, cost }),
) {
  return createPublicPreparation({
    pool,
    work,
    prefix: owner,
    search: {} as OpenSearch,
    source: {} as PublicPreparationOptions['source'],
    listing: {} as PublicPreparationOptions['listing'],
    runtime: { repair } as DefaultPublicFilterRuntime,
  });
}

test('repeated due discovery keeps delayed repair and population deliveries dispatchable', async () => {
  const owner = prefix();
  const isolated = prefix();
  const job = repairJob();
  const isolatedJob = repairJob();
  const frontier = population();
  let settled = 0;
  const active = preparation(owner, async (received) => {
    settled += 1;
    return { status: 'settled', job: received, cost };
  });
  const store = createPublicPreparationStore(pool, work, owner);
  const other = createPublicPreparationStore(pool, work, isolated);
  const repairId = track(
    await store.retain({ kind: 'repair', key: JSON.stringify(job), job }, Date.now() + 86_400_000),
  );
  const populationId = track(await store.retain(frontier, Date.now() + 86_400_000));
  const otherId = track(
    await other.retain(
      { kind: 'repair', key: JSON.stringify(isolatedJob), job: isolatedJob },
      Date.now() + 86_400_000,
    ),
  );
  const repairBefore = await read(owner, repairId);
  const populationBefore = await read(owner, populationId);
  const otherBefore = await read(isolated, otherId);
  expect(repairBefore?.kind).toBe('repair');
  expect(populationBefore?.kind).toBe('population');
  for (let n = 0; n < 8; n++) await active.discover();
  expect(await read(owner, repairId)).toEqual(repairBefore);
  expect(await read(owner, populationId)).toEqual(populationBefore);
  expect(await read(isolated, otherId)).toEqual(otherBefore);
  expect(await workflows(repairId)).toEqual([identity(repairId, repairBefore!.revision)]);
  expect(await workflows(populationId)).toEqual([identity(populationId, populationBefore!.revision)]);
  await active.run(repairId, repairBefore!.revision);
  expect(settled).toBe(1);
  expect(await read(owner, repairId)).toBeNull();
  const claimed = await store.claim(populationId, populationBefore!.revision, Date.now() + 30_000);
  expect(claimed?.locator).toEqual(frontier);
  await store.advance(claimed!, { ...frontier, phase: 'replay' });
  expect((await read(owner, populationId))?.locator).toMatchObject({ kind: 'population', phase: 'replay' });
});

test('expired claims recover once and a stale claimed revision cannot overwrite the newer frontier', async () => {
  const owner = prefix();
  const store = createPublicPreparationStore(pool, work, owner);
  const frontier = population('recover');
  const id = track(await store.retain(frontier, Date.now() + 86_400_000));
  const original = await read(owner, id);
  const claimed = await store.claim(id, original!.revision, Date.now() - 1);
  expect(claimed).not.toBeNull();
  for (let n = 0; n < 5; n++) await store.due();
  const recovered = await read(owner, id);
  expect(Number(recovered!.revision)).toBeGreaterThan(Number(claimed!.revision));
  expect(recovered!.lease_until).toBe('0');
  expect(await workflows(id)).toEqual([identity(id, original!.revision), identity(id, recovered!.revision)]);
  await store.advance(claimed!, { ...frontier, phase: 'replay' });
  expect((await read(owner, id))?.locator).toEqual(frontier);
  const live = await store.claim(id, recovered!.revision, Date.now() + 30_000);
  expect(live).not.toBeNull();
  await store.advance(live!, { ...frontier, phase: 'native' });
  expect((await read(owner, id))?.locator).toMatchObject({ phase: 'native' });
});

test('an expired locator is dropped on claim without repair or population work', async () => {
  const owner = prefix();
  const job = repairJob();
  const store = createPublicPreparationStore(pool, work, owner);
  const active = preparation(owner, async () => {
    throw new Error('expired locators must not call repair');
  });
  const id = track(await store.retain({ kind: 'repair', key: JSON.stringify(job), job }, Date.now() - 1));
  const record = await read(owner, id);
  await active.run(id, record!.revision);
  expect(await read(owner, id)).toBeNull();
});
