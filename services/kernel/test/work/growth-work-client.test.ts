import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthReport } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [64, 512, 4096] as const;
const historyRowsPerUnit = 16;
const pageLimit = 10;
const seededStepCount = pageLimit + 2;
const deepStepCount = pageLimit * 8;
const repetitions = 1;
// Keep checkGrowth's default one warm-up; every warm-up and measured run gets its own probe.
const probesPerScale = repetitions + 1;
const fallbackPrefix = `work-client-fallback-growth:${crypto.randomUUID()}:`;
const readPrefix = `work-client-read-growth:${crypto.randomUUID()}:`;
const boundedFallbackPrefix = `work-client-bounded-fallback:${crypto.randomUUID()}:`;
const samePartition = `work-client-growth-partition:${crypto.randomUUID()}`;
const otherPartitionPrefix = `work-client-growth-other:${crypto.randomUUID()}:`;
const genericRealm = 'aaaaaaaa-0000-7000-8000-000000000001';
const genericMember = 'bbbbbbbb-0000-7000-8000-000000000002';
const serializedNull = JSON.stringify({ json: null, __dbos_serializer: 'superjson' });

type Probe = {
  readonly workflowID: string;
  readonly legacyWorkflowID: string;
  readonly parentWorkflowID: string;
  readonly realmID: string;
  readonly memberAccountID: string;
  readonly reservationID: string;
};

type PlanEvidence = { readonly query: string; readonly plan: unknown };
type RunEvidence = { readonly scale: number; readonly repetition: number; readonly plans: readonly PlanEvidence[] };

let db: GrowthDatabase;
let client: WorkClient;
const planDocuments: unknown[] = [];
const probesByPrefix = new Map<string, Map<number, Probe>>();

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  observePlans(db.pool);
  client = await createWorkClient(databaseUrl, db.pool);
});

afterAll(async () => {
  try {
    for (const prefix of [fallbackPrefix, readPrefix, boundedFallbackPrefix]) await deleteFixture(prefix);
  } finally {
    await client?.close();
    await db?.close();
  }
});

function observePlans(pool: Pool): void {
  pool.on('connect', (connection) => {
    connection.on('notice', ({ message }) => {
      const marker = 'plan:\n';
      if (!message?.startsWith('duration:') || !message.includes(marker)) return;
      try {
        planDocuments.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown);
      } catch {
        // Invalid notices are not plans and do not contribute evidence.
      }
    });
  });
}

function plansFrom(documents: readonly unknown[]): PlanEvidence[] {
  return documents.flatMap((document) => {
    const roots = Array.isArray(document) ? document : [document];
    return roots.flatMap((root) => {
      if (typeof root !== 'object' || root === null) return [];
      const entry = root as { readonly 'Query Text'?: unknown; readonly Plan?: unknown };
      return typeof entry['Query Text'] === 'string' && entry.Plan !== undefined
        ? [{ query: entry['Query Text'], plan: entry.Plan }]
        : [];
    });
  });
}

function probeFor(prefix: string, repetition: number): Probe {
  const probes = probesByPrefix.get(prefix) ?? new Map<number, Probe>();
  probesByPrefix.set(prefix, probes);
  const existing = probes.get(repetition);
  if (existing) return existing;

  const realmID = crypto.randomUUID();
  const memberAccountID = crypto.randomUUID();
  const reservationID = crypto.randomUUID();
  const probe = {
    workflowID: `${prefix}probe:workflow:${repetition}`,
    legacyWorkflowID: `realm:leave:${realmID}:${memberAccountID}`,
    parentWorkflowID: `${prefix}probe:parent:${repetition}`,
    realmID,
    memberAccountID,
    reservationID,
  };
  probes.set(repetition, probe);
  return probe;
}

function probesForScale(prefix: string, scale: number): Probe[] {
  const scaleIndex = scales.indexOf(scale as (typeof scales)[number]);
  if (scaleIndex < 0) throw new RangeError(`Unexpected work-client growth scale ${scale}`);
  const firstRepetition = scaleIndex * probesPerScale;
  return Array.from({ length: probesPerScale }, (_, index) => probeFor(prefix, firstRepetition + index));
}

function inputJson(value: unknown): string {
  return JSON.stringify({ json: [value], __dbos_serializer: 'superjson' });
}

async function seedScale(
  growth: GrowthDatabase,
  prefix: string,
  scale: number,
  previous: number,
  probes: readonly Probe[],
  fallback: boolean,
): Promise<void> {
  const probeRows = probes.flatMap((probe, index) => {
    const rows = fallback
      ? [
          {
            workflow_uuid: probe.parentWorkflowID,
            name: 'community.leave',
            created_at: 1_700_000_000_000 + index,
            queue_partition_key: samePartition,
            inputs: inputJson({
              realmId: probe.realmID,
              memberAccountId: probe.memberAccountID,
              reservationId: probe.reservationID,
            }),
            step_count: 1,
          },
          {
            workflow_uuid: `${prefix}probe:child:${scale}:${index}`,
            name: 'accounts.membership',
            created_at: 1_700_000_000_000 + index,
            queue_partition_key: samePartition,
            inputs: inputJson({
              principal: { id: probe.realmID },
              memberAccountId: probe.memberAccountID,
              reservationId: probe.reservationID,
            }),
            step_count: seededStepCount,
          },
        ]
      : [
          {
            workflow_uuid: probe.workflowID,
            name: 'work.client.growth.probe',
            created_at: 1_700_000_000_000 + index,
            queue_partition_key: samePartition,
            inputs: inputJson({ probe: probe.workflowID }),
            step_count: seededStepCount,
          },
        ];
    return rows;
  });

  const itemCte = `WITH history AS (
       SELECT n,
              $1 || 'history:parent:' || lpad(n::text, 8, '0') AS workflow_uuid,
              'community.leave'::text AS name,
              2000000000000::bigint + n AS created_at,
              CASE WHEN n % 10 = 0 THEN $5::text ELSE $6::text || (n % 31)::text END AS queue_partition_key,
              jsonb_build_object(
                'json', jsonb_build_array(jsonb_build_object(
                  'realmId', $7::text,
                  'memberAccountId', $8::text,
                  'reservationId', $1 || 'reservation:' || n::text
                )),
                '__dbos_serializer', 'superjson'
              )::text AS inputs,
              1::int AS step_count
       FROM generate_series($2::int, $3::int) AS history_item(n)
       UNION ALL
       SELECT n,
              $1 || 'history:child:' || lpad(n::text, 8, '0') AS workflow_uuid,
              'accounts.membership'::text AS name,
              2000000000000::bigint + n AS created_at,
              CASE WHEN n % 10 = 0 THEN $5::text ELSE $6::text || (n % 31)::text END AS queue_partition_key,
              jsonb_build_object(
                'json', jsonb_build_array(jsonb_build_object(
                  'principal', jsonb_build_object('id', $7::text),
                  'memberAccountId', $8::text,
                  'reservationId', $1 || 'reservation:' || n::text
                )),
                '__dbos_serializer', 'superjson'
              )::text AS inputs,
              1::int AS step_count
       FROM generate_series($2::int, $3::int) AS history_item(n)
     ), probes AS (
       SELECT *
       FROM jsonb_to_recordset($4::jsonb) AS p(
         workflow_uuid text,
         name text,
         created_at bigint,
         queue_partition_key text,
         inputs text,
         step_count integer
       )
     ), items AS (
       SELECT workflow_uuid, name, created_at, queue_partition_key, inputs, step_count FROM history
       UNION ALL
       SELECT workflow_uuid, name, created_at, queue_partition_key, inputs, step_count FROM probes
     )`;
  const parameters = [
    prefix,
    previous * historyRowsPerUnit + 1,
    scale * historyRowsPerUnit,
    JSON.stringify(probeRows),
    samePartition,
    otherPartitionPrefix,
    genericRealm,
    genericMember,
    serializedNull,
  ];

  await growth.admin.query(
    `${itemCte}
     INSERT INTO dbos.workflow_status (
       workflow_uuid, status, name, queue_name, authenticated_user, assumed_role, authenticated_roles,
       executor_id, application_id, created_at, updated_at, completed_at, recovery_attempts, inputs,
       queue_partition_key, serialization, application_name
     )
     SELECT workflow_uuid, 'SUCCESS', name, 'work-client-growth', '', '', '[]', '', 'rezics-kernel',
            created_at, created_at, created_at, 0, inputs, queue_partition_key, 'js_superjson', 'rezics-kernel'
     FROM items`,
    parameters.slice(0, 8),
  );
  await growth.admin.query(
    `${itemCte}
     INSERT INTO dbos.workflow_input (workflow_uuid, inputs)
     SELECT workflow_uuid, inputs FROM items`,
    parameters.slice(0, 8),
  );
  await growth.admin.query(
    `${itemCte}
     INSERT INTO dbos.workflow_output (workflow_uuid, output, error)
     SELECT workflow_uuid, $9::text, NULL FROM items`,
    parameters.slice(0, 9),
  );
  await growth.admin.query(
    `${itemCte}
     INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output, error)
     SELECT items.workflow_uuid, generated.step_id, 'growth.work_client.step', $9::text, NULL
     FROM items
     CROSS JOIN LATERAL generate_series(1, items.step_count) AS generated(step_id)`,
    parameters,
  );
}

async function deleteFixture(prefix: string): Promise<void> {
  for (const relation of ['operation_outputs', 'workflow_input', 'workflow_output', 'workflow_status']) {
    await db.admin.query(`DELETE FROM dbos.${relation} WHERE workflow_uuid LIKE $1`, [`${prefix}%`]);
  }
}

function logEvidence(
  name: string,
  report: GrowthReport,
  runs: readonly RunEvidence[],
  queryFilter: (sql: string) => boolean,
) {
  const sampledScales = new Set<number>();
  const plans = runs.flatMap(({ scale, repetition, plans: entries }) => {
    if (sampledScales.has(scale)) return [];
    const matching = entries
      .filter(({ query }) => queryFilter(query))
      .map(({ query, plan }) => ({ scale, repetition, query, plan }));
    if (matching.length > 0) sampledScales.add(scale);
    return matching;
  });
  console.log(
    `${name} ${JSON.stringify({
      series: report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
      })),
      plans,
    })}`,
  );
}

async function runFallback(probe: Probe): Promise<void> {
  const steps = await client.listWorkflowSteps(probe.legacyWorkflowID, { limit: pageLimit, offset: 0 });
  expect(steps).toHaveLength(pageLimit);
}

async function runStatusAndSteps(probe: Probe): Promise<void> {
  const status = await client.getWorkflow(probe.workflowID);
  expect(status).toMatchObject({ workflowID: probe.workflowID, status: 'SUCCESS' });
  const steps = await client.listWorkflowSteps(probe.workflowID, { limit: pageLimit, offset: 0 });
  expect(steps).toHaveLength(pageLimit);
}

test('Workflow step listing with the legacy leave fallback stays within its bound as workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  // The JSON-filtered fallback SQL scans status/input history before LIMIT, so rows and blocks grow with that history.
  const report = await checkGrowth(db, {
    name: 'legacy leave fallback workflow step listing',
    scales,
    repetitions,
    bounds: { rows: 'linear', blocks: 'linear', statements: 'constant' },
    async grow(growth, scale, previous) {
      await seedScale(growth, fallbackPrefix, scale, previous, probesForScale(fallbackPrefix, scale), true);
    },
    async warmup(_growth, _scale, repetition) {
      await runFallback(probeFor(fallbackPrefix, repetition));
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      await runFallback(probeFor(fallbackPrefix, repetition));
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
    },
  });

  expect(report.samples).toHaveLength(scales.length);
  logEvidence(
    'legacy fallback',
    report,
    runs,
    (sql) => sql.includes('parent_input.inputs::jsonb') && sql.includes('child_input.inputs::jsonb'),
  );
  await deleteFixture(fallbackPrefix);
}, 180_000);

test('Work client status and step reads stay within their bound as workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'work client status and step reads',
    scales,
    repetitions,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(growth, scale, previous) {
      await seedScale(growth, readPrefix, scale, previous, probesForScale(readPrefix, scale), false);
    },
    async warmup(_growth, _scale, repetition) {
      await runStatusAndSteps(probeFor(readPrefix, repetition));
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      await runStatusAndSteps(probeFor(readPrefix, repetition));
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
    },
  });

  expect(report.samples).toHaveLength(scales.length);
  logEvidence('work client reads', report, runs, () => false);
  await deleteFixture(readPrefix);
}, 180_000);

function childWorkflowIDForProbe(prefix: string, probe: Probe): string {
  const repetition = Number(probe.parentWorkflowID.slice(probe.parentWorkflowID.lastIndexOf(':') + 1));
  const scaleIndex = Math.floor(repetition / probesPerScale);
  const scale = scales[scaleIndex];
  if (scale === undefined) throw new RangeError(`Unexpected work-client probe ${probe.parentWorkflowID}`);
  const probeIndex = repetition - scaleIndex * probesPerScale;
  return `${prefix}probe:child:${scale}:${probeIndex}`;
}

async function runBoundedFallback(prefix: string, probe: Probe): Promise<void> {
  const childWorkflowID = childWorkflowIDForProbe(prefix, probe);
  const expectedName = `growth.work_client.step:${childWorkflowID}`;
  expect(await client.getWorkflow(childWorkflowID)).toMatchObject({ workflowID: childWorkflowID, status: 'SUCCESS' });
  const list = (offset: number) => client.listWorkflowSteps(probe.legacyWorkflowID, { limit: pageLimit, offset });
  const first = await list(0);
  expect(first).toHaveLength(pageLimit);
  expect(first?.map(({ functionID }) => functionID)).toEqual(
    Array.from({ length: pageLimit }, (_, index) => index + 1),
  );
  expect(first?.every(({ name }) => name === expectedName)).toBe(true);

  const continuation = await list(pageLimit);
  const continuationCount = Math.min(pageLimit, deepStepCount - pageLimit);
  expect(continuation?.map(({ functionID }) => functionID)).toEqual(
    Array.from({ length: continuationCount }, (_, index) => pageLimit + index + 1),
  );
  expect(continuation?.every(({ name }) => name === expectedName)).toBe(true);
  expect(await list(pageLimit)).toEqual(continuation);

  const deepOffset = pageLimit * 4;
  const deep = await list(deepOffset);
  const deepCount = Math.min(pageLimit, deepStepCount - deepOffset);
  expect(deep?.map(({ functionID }) => functionID)).toEqual(
    Array.from({ length: deepCount }, (_, index) => deepOffset + index + 1),
  );
  expect(deep?.every(({ name }) => name === expectedName)).toBe(true);
  expect(await list(deepOffset)).toEqual(deep);
  expect(await list(deepStepCount)).toEqual([]);

  const absent = `realm:leave:${crypto.randomUUID()}:${crypto.randomUUID()}`;
  expect(await client.getWorkflow(absent)).toBeNull();
  expect(await client.listWorkflowSteps(absent, { limit: pageLimit, offset: 0 })).toEqual([]);
}

test('Legacy leave fallback discovery stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'legacy leave fallback bounded discovery',
    scales,
    repetitions,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(growth, scale, previous) {
      const probes = probesForScale(boundedFallbackPrefix, scale);
      await seedScale(growth, boundedFallbackPrefix, scale, previous, probes, true);
      for (const probe of probes) {
        const childWorkflowID = childWorkflowIDForProbe(boundedFallbackPrefix, probe);
        const expectedName = `growth.work_client.step:${childWorkflowID}`;
        await growth.admin.query('UPDATE dbos.operation_outputs SET function_name=$1 WHERE workflow_uuid=$2', [
          expectedName,
          childWorkflowID,
        ]);
        await growth.admin.query(
          `INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output, error)
           SELECT $1, generated.step_id, $2, $3, NULL
             FROM generate_series($4::int + 1, $5::int) AS generated(step_id)`,
          [childWorkflowID, expectedName, serializedNull, seededStepCount, deepStepCount],
        );
        await growth.admin.query('UPDATE dbos.workflow_status SET step_count=$2 WHERE workflow_uuid=$1', [
          childWorkflowID,
          deepStepCount,
        ]);
      }
    },
    async warmup(_growth, _scale, repetition) {
      await runBoundedFallback(boundedFallbackPrefix, probeFor(boundedFallbackPrefix, repetition));
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      await runBoundedFallback(boundedFallbackPrefix, probeFor(boundedFallbackPrefix, repetition));
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
    },
  });

  expect(report.samples).toHaveLength(scales.length);
  logEvidence('legacy fallback bounded', report, runs, (sql) => sql.toLowerCase().includes('workflow'));
  await deleteFixture(boundedFallbackPrefix);
}, 180_000);
