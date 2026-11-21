import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createWorkClient, DBOS_SCHEMA, WORK_APPLICATION } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { createPublicPreparation, type PublicPreparationOptions } from '../../src/search/public-preparation.ts';
import { createSearchServiceGate, registerPublicPreparationWork } from '../../src/search/work.ts';
import { subjectIndexName } from '../../src/search/indices.ts';
import { activeRelease, bootstrapRelease } from '../../src/semantic/definitions.ts';
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

function identity(id: string, revision: string, kind: 'repair' | 'population' = 'repair'): string {
  return `${PUBLIC_PREPARATION_WORKFLOW}:${id}:${revision}${kind === 'population' ? ':population' : ''}`;
}

async function read(owner: string, id: string) {
  const result = await pool.query<PreparationRecord & { kind: string; lease_until: string; due_at: string }>(
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
    await other.retain({ kind: 'repair', key: JSON.stringify(isolatedJob), job: isolatedJob }, Date.now() + 86_400_000),
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
  expect(await workflows(populationId)).toEqual([identity(populationId, populationBefore!.revision, 'population')]);
  await active.run(repairId, repairBefore!.revision);
  expect(settled).toBe(1);
  expect(await read(owner, repairId)).toBeNull();
  const claimed = await store.claim(populationId, populationBefore!.revision, Date.now() + 30_000);
  expect(claimed?.locator).toEqual(frontier);
  await store.advance(claimed!, { ...frontier, phase: 'replay' });
  expect((await read(owner, populationId))?.locator).toMatchObject({ kind: 'population', phase: 'replay' });
});

test('due discovery recovers a ready enrollment successor after an interrupted delivery', async () => {
  const owner = prefix();
  const store = createPublicPreparationStore(pool, work, owner);
  const frontier = population('enrollment');
  const id = track(await store.retain(frontier, Date.now() + 86_400_000));
  const original = (await read(owner, id))!;
  const claim = (await store.claim(id, original.revision, Date.now() + 30_000))!;
  const revision = await store.advance(claim, { ...frontier, phase: 'activate' }, 0, Date.now() + 30_000, true);
  expect(revision).not.toBeNull();
  expect(await workflows(id)).toEqual([identity(id, original.revision, 'population')]);
  await store.due();
  expect(await workflows(id)).toEqual([
    identity(id, original.revision, 'population'),
    identity(id, revision!, 'population'),
  ]);
  expect((await store.claim(id, revision!, Date.now() + 30_000))?.locator).toMatchObject({ phase: 'activate' });
  expect(await store.claim(id, revision!, Date.now() + 30_000)).toBeNull();
});

test('a terminal pre-claim population delivery gets one fresh claim after restart', async () => {
  const owner = prefix();
  const store = createPublicPreparationStore(pool, work, owner);
  const frontier = { ...population('restart'), publication: crypto.randomUUID(), phase: 'native' as const };
  const id = track(await store.retain(frontier, Date.now() + 86_400_000));
  const original = (await read(owner, id))!;
  const originalId = identity(id, original.revision, 'population');
  const unavailable = () => new Error('Search preparation service is not running');
  type Runner = Pick<ReturnType<typeof createPublicPreparation>, 'run'>;
  const stopped = createSearchServiceGate<Runner>(unavailable);
  stopped.stop();
  let claimed: PreparationRecord | null = null;
  const live = createSearchServiceGate<Runner>(unavailable);
  live.offer({
    async run(delivered, revision) {
      const current = await store.claim(delivered, revision, Date.now() + 30_000);
      if (delivered === id) claimed = current;
    },
  });
  let ready = stopped.ready;
  registerPublicPreparationWork(() => ready(), work);
  await work.registerQueue('workflows', WORK_QUEUES.workflows);
  const launch = async () => {
    DBOS.setConfig({
      name: WORK_APPLICATION,
      systemDatabaseUrl: databaseUrl,
      systemDatabaseSchemaName: DBOS_SCHEMA,
      runMigrations: false,
      logLevel: 'error',
    });
    await DBOS.launch();
  };
  try {
    await launch();
    await expect(DBOS.getResult(originalId, { pollingIntervalMs: 10 })).rejects.toThrow(
      'Search preparation service is not running',
    );
    await DBOS.shutdown();
    expect(await read(owner, id)).toEqual(original);
    const originalSteps = await work.listWorkflowSteps(originalId);
    expect(originalSteps?.some((step) => step.error)).toBe(true);

    // The stopped worker leaves older live maintenance deliveries at the front. An
    // unwitnessed terminal population behind a full discovery page must still recover.
    const queued = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const job = repairJob();
        return track(await store.retain({ kind: 'repair', key: job.job, job }, Date.now() + 86_400_000));
      }),
    );
    await pool.query(
      `UPDATE search.public_preparation SET due_at=$2 WHERE partition_no=0 AND prefix=$1 AND id=ANY($3::uuid[])`,
      [owner, BigInt(original.due_at) - 1n, queued],
    );
    const restarted = createPublicPreparationStore(pool, work, owner);
    await restarted.due();
    expect((await read(owner, id))?.revision).toBe(original.revision);
    await Promise.all([restarted.due(), restarted.due()]);
    const renewed = (await read(owner, id))!;
    expect(renewed).toEqual({ ...original, revision: String(BigInt(original.revision) + 1n) });
    const renewedId = identity(id, renewed.revision, 'population');
    await store.due();
    expect(await workflows(id)).toEqual([originalId, renewedId]);
    expect(await store.claim(id, original.revision, Date.now() + 30_000)).toBeNull();

    ready = live.ready;
    await launch();
    await DBOS.getResult(renewedId, { pollingIntervalMs: 10 });
    expect(claimed).toMatchObject({ id, locator: frontier });
    expect((await work.getWorkflow(renewedId))?.status).toBe('SUCCESS');
    expect((await work.getWorkflow(originalId))?.status).toBe('ERROR');
    expect(await work.listWorkflowSteps(originalId)).toEqual(originalSteps);
  } finally {
    await DBOS.shutdown({ deregister: true });
  }
}, 25_000);

test('preparation recovers both legacy first checkpoints and keeps delayed deliveries deterministic', async () => {
  const calls: string[] = [];
  const run = async (id: string) => {
    calls.push(id);
  };
  const originalStep = DBOS.registerStep(run, { name: 'search.publicPreparationStep' });
  const legacy = DBOS.registerWorkflow(
    async (input: { id: string; revision: string; notBefore: number }) => {
      const delay = input.notBefore - Date.now();
      if (delay > 0) await DBOS.sleep(delay);
      await originalStep(input.id);
    },
    { name: PUBLIC_PREPARATION_WORKFLOW },
  );
  const launch = async () => {
    DBOS.setConfig({
      name: WORK_APPLICATION,
      systemDatabaseUrl: databaseUrl,
      systemDatabaseSchemaName: DBOS_SCHEMA,
      runMigrations: false,
      logLevel: 'error',
    });
    await DBOS.launch();
  };
  const id = () => identity(track(crypto.randomUUID()), '1');
  const early = id(),
    late = id();
  try {
    await launch();
    const earlyDue = Date.now() + 500;
    const original = await DBOS.startWorkflow(legacy, { workflowID: early })({
      id: 'early',
      revision: '1',
      notBefore: earlyDue,
    });
    await original.getResult();
    await (
      await DBOS.startWorkflow(legacy, { workflowID: late })({
        id: 'late',
        revision: '1',
        notBefore: Date.now() - 1000,
      })
    ).getResult();
    const steps = async (wf: string) => (await work.listWorkflowSteps(wf))?.map((step) => step.name);
    expect(await steps(early)).toEqual(['DBOS.sleep', 'search.publicPreparationStep']);
    expect(await steps(late)).toEqual(['search.publicPreparationStep']);
    await DBOS.shutdown({ deregister: true });
    const current = registerPublicPreparationWork(async () => ({ run }), work);
    await launch();
    // Fork through the SDK with the original step zero intact. The original
    // delayed timer has elapsed and the immediate preparation already ran.
    for (const source of [early, late]) {
      const replay = await DBOS.forkWorkflow(source, 1, {
        newWorkflowID: id(),
        applicationVersion: DBOS.applicationVersion,
      });
      await replay.getResult({ pollingIntervalMs: 10 });
      expect(await steps(replay.workflowID)).toEqual(await steps(source));
    }
    expect(calls).toEqual(['early', 'late', 'early']);
    const due = Date.now() + 300;
    const delayed = await DBOS.startWorkflow(current, { workflowID: id() })({
      id: 'new-delay',
      revision: '1',
      notBefore: due,
    });
    await delayed.getResult();
    expect(Date.now()).toBeGreaterThanOrEqual(due);
    expect(await steps(delayed.workflowID)).toEqual([
      'DBOS.patch-search.publicPreparation.due',
      'DBOS.sleep',
      'search.publicPreparationStep',
    ]);
    const replay = await DBOS.forkWorkflow(delayed.workflowID, 2, { newWorkflowID: id() });
    await replay.getResult({ pollingIntervalMs: 10 });
    expect(await steps(replay.workflowID)).toEqual(await steps(delayed.workflowID));
    const immediate = await DBOS.startWorkflow(current, { workflowID: id() })({
      id: 'new-ready',
      revision: '1',
      notBefore: 0,
    });
    await immediate.getResult();
    expect(await steps(immediate.workflowID)).toEqual(['search.publicPreparationStep']);
  } finally {
    await DBOS.shutdown({ deregister: true });
  }
}, 30_000);

test('expired claims recover once and a stale claimed revision cannot overwrite the newer frontier', async () => {
  const owner = prefix();
  const store = createPublicPreparationStore(pool, work, owner);
  const frontier = population('recover');
  const id = track(await store.retain(frontier, Date.now() + 86_400_000));
  const original = await read(owner, id);
  const claimed = await store.claim(id, original!.revision, Date.now() + 30_000);
  expect(claimed).not.toBeNull();
  await pool.query(
    `UPDATE search.public_preparation SET lease_until = $4
     WHERE partition_no = 0 AND prefix = $1 AND id = $2 AND revision = $3`,
    [owner, id, claimed!.revision, Date.now() - 1],
  );
  for (let n = 0; n < 5; n++) await store.due();
  const recovered = await read(owner, id);
  expect(Number(recovered!.revision)).toBeGreaterThan(Number(claimed!.revision));
  expect(recovered!.lease_until).toBe('0');
  expect(await workflows(id)).toEqual([
    identity(id, original!.revision, 'population'),
    identity(id, recovered!.revision, 'population'),
  ]);
  await store.advance(claimed!, { ...frontier, phase: 'replay' });
  expect((await read(owner, id))?.locator).toEqual(frontier);
  const live = await store.claim(id, recovered!.revision, Date.now() + 30_000);
  expect(live).not.toBeNull();
  await store.advance(live!, { ...frontier, phase: 'native' });
  expect((await read(owner, id))?.locator).toMatchObject({ phase: 'native' });
  const current = { ...frontier, meaning: 'current-release' };
  expect(await store.retain(current, Date.now() + 86_400_000)).toBe(id);
  const rebound = await read(owner, id);
  expect(rebound?.locator).toEqual(current);
  expect(Number(rebound!.revision)).toBeGreaterThan(Number(live!.revision));
  await store.advance(live!, { ...frontier, phase: 'replay' });
  expect((await read(owner, id))?.locator).toEqual(current);
  const admitted = await store.claim(id, rebound!.revision, Date.now() + 30_000);
  await store.advance(admitted!, { ...current, publication: 'native-publication' });
  const pinned = await read(owner, id);
  await store.retain({ ...current, meaning: 'later-release' }, Date.now() + 86_400_000);
  expect((await read(owner, id))?.locator).toEqual(pinned?.locator);
});

test('stale unpublished population advances to the active native release before preparation', async () => {
  await bootstrapRelease(pool, bundledRelease);
  const owner = prefix();
  const frontier = { ...population('active-release-change'), meaning: 'stale-release' };
  const store = createPublicPreparationStore(pool, work, owner);
  const id = track(await store.retain(frontier, Date.now() + 86_400_000));
  const release = await activeRelease(pool);
  expect(release).not.toBeNull();

  const index = subjectIndexName(owner, frontier.generation);
  const search = {
    async request(_method: string, path: string) {
      if (path.endsWith('/_mapping')) return { status: 200, body: { [index]: { mappings: { properties: {} } } } };
      if (path.endsWith('/_settings'))
        return { status: 200, body: { [index]: { settings: { index: { uuid: frontier.uuid } } } } };
      throw new Error(`Unexpected Search request ${path}`);
    },
  } as unknown as OpenSearch;
  const preparation = createPublicPreparation({
    pool,
    work,
    prefix: owner,
    search,
    source: {} as PublicPreparationOptions['source'],
    listing: {} as PublicPreparationOptions['listing'],
    runtime: {
      async preparePublication() {
        throw new Error('A stale release must not register native preparation');
      },
    } as unknown as DefaultPublicFilterRuntime,
  });

  try {
    await preparation.run(id, (await read(owner, id))!.revision);
    const current = await read(owner, id);
    expect(current?.locator).toMatchObject({ meaning: release!.digest, publication: null, phase: 'native' });
    expect(Number(current!.revision)).toBeGreaterThan(1);
  } finally {
    await preparation.stop();
  }
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
