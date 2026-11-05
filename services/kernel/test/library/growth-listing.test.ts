import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { CloudEvent } from '../../src/events/log.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import {
  checkGrowth,
  costOf,
  GrowthBoundError,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';

const sourceRoute = 0x6a31;
const subjectRoute = 0x7890;
const otherRoute = 0x8b40;
const routes = [sourceRoute, subjectRoute, otherRoute];
const at = '2026-10-27T04:00:00.000Z';
const historyPrefix = 'listing-growth-history:';
let db: GrowthDatabase;
let client: WorkClient;
let worker: Awaited<ReturnType<typeof composeWork>>;
let runPlans: unknown[] = [];
const runs: { scale: number; plans: unknown[] }[] = [];

// Observe each run as well as checkGrowth's median: a median alone could hide a sequential scan.
function observe(pool: Pool) {
  pool.on('connect', (connection) => {
    connection.on('notice', ({ message }) => {
      const marker = 'plan:\n';
      if (message?.startsWith('duration:') && message.includes(marker))
        runPlans.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)));
    });
  });
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  observe(db.pool);
  const runnerPool = db.openPool({ max: 10 });
  observe(runnerPool);
  // The client owns its ordinary SDK pool, as in work.test.ts; the runner pool is captured.
  client = await createWorkClient(db.url);
  worker = await composeWork([libraryWorkModule], { databaseUrl: db.url, pool: runnerPool, client, env: {} });
  await worker.launch();
  // Leave the seed's positions below every real command's fence position.
  await db.admin.query('UPDATE core.partition SET position = 1000000 WHERE partition_no = ANY($1::int[])', [
    routes.map(partitionOf),
  ]);
});

afterEach(async () => {
  // This file owns its test database. Keep the two checks' growing populations independent.
  // Include the installed source tables that reference Collection, even when empty.
  await db?.admin.query(`TRUNCATE library.canonical_source_fact, library.canonical_source_state,
    library.collection_member, library.collection,
    library.subject_collection, library.subject_listing, core.receipt, core.outbox, editorial.write_basis`);
  // DBOS retains input, output and operation rows independently of workflow_status.
  for (const relation of ['operation_outputs', 'workflow_input', 'workflow_output', 'workflow_status'])
    await db?.admin.query(`DELETE FROM dbos.${relation} WHERE workflow_uuid LIKE $1`, [`${historyPrefix}%`]);
});

afterAll(async () => {
  await worker?.shutdown();
  await client?.close();
  await db?.close();
});

// Route-bearing UUIDs of the same shape as production IDs; prefixes separate fixture relation kinds.
const sqlId = (prefix: string, route = 'r', ordinal = 'n') =>
  `('${prefix}-0000-7000-8000-' || lpad(to_hex(${route}), 4, '0') || lpad(to_hex(${ordinal}), 8, '0'))::uuid`;

async function grow(scale: number, previous: number, subjects: string[]) {
  const parameters = [previous * 500 + 1, scale * 500, routes, subjects, at];
  const source = `WITH source AS (
    SELECT n, r, ${sqlId('10000000')} AS collection_id,
      ${sqlId('30000000')} AS subject_id, ${sqlId('40000000')} AS transaction_id,
      ${sqlId('50000000', 'r', '0')} AS curator_id
    FROM generate_series($1::int, $2::int) n CROSS JOIN unnest($3::int[]) r
  )`;
  await db.admin.query(
    `${source} INSERT INTO library.collection
      (route, collection_id, curator_account_id, title, visibility, state, revision, member_count,
       order_epoch, created_at, updated_at, transaction_id)
     SELECT r, collection_id, curator_id, 'Other public shelf', 'public', 'active', 1,
       cardinality($4::uuid[]) + 1, 0, $5::timestamptz, $5::timestamptz, transaction_id FROM source`,
    parameters,
  );
  await db.admin.query(
    `${source} INSERT INTO library.collection_member
      (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
     SELECT r, collection_id, ${sqlId('20000000', 'r', 'n * 10 + s.ordinal::int')}, s.subject_id,
       NULL, 'a' || s.ordinal, $5::timestamptz, transaction_id
     FROM source CROSS JOIN LATERAL
       unnest(array_append($4::uuid[], source.subject_id)) WITH ORDINALITY s(subject_id, ordinal)`,
    parameters,
  );
  await db.admin.query(
    `${source} INSERT INTO library.subject_collection
      (route, subject_id, collection_id, collection_route, multiplicity, updated_at, transaction_id)
     SELECT get_byte(uuid_send(s.subject_id), 10) * 256 + get_byte(uuid_send(s.subject_id), 11),
       s.subject_id, collection_id, r, 1, $5::timestamptz, transaction_id
     FROM source CROSS JOIN LATERAL unnest(array_append($4::uuid[], source.subject_id)) s(subject_id)`,
    parameters,
  );
  // Include the fixed subjects in the same bulk insert, preserving counts from earlier probes.
  await db.admin.query(
    `${source}, listings AS (
       SELECT r, subject_id, 1 AS shelf_count, transaction_id FROM source
       UNION ALL
       SELECT ${subjectRoute}, subject_id, ($2::int - $1::int + 1) * cardinality($3::int[]), subject_id
       FROM unnest($4::uuid[]) subject_id
     )
     INSERT INTO library.subject_listing
       (route, subject_id, public_collection_count, revision, updated_at, transaction_id)
     SELECT r, subject_id, shelf_count, 1, $5::timestamptz, transaction_id FROM listings
     ON CONFLICT (route, subject_id) DO UPDATE
       SET public_collection_count = library.subject_listing.public_collection_count + EXCLUDED.public_collection_count`,
    parameters,
  );
  // Listing sync has no authorization callback and reads no Access rows or write basis.
  // Still populate the envelope relations, including write basis, in every growing partition.
  await db.admin.query(
    `${source} INSERT INTO core.receipt
      (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
       epoch, position, transaction_id, response)
     SELECT r >> 4, 'account', CASE WHEN r = ${subjectRoute} THEN ($4::uuid[])[1] ELSE curator_id END,
       'library.subject.listing.sync', repeat(md5(transaction_id::text), 2), decode(repeat('00', 32), 'hex'),
       1, n, transaction_id, '{"publicCollectionCount":1,"revision":1}'::jsonb FROM source
     WHERE $5::timestamptz IS NOT NULL`,
    parameters,
  );
  await db.admin.query(
    `${source} INSERT INTO core.outbox
      (partition_no, position, event_seq, event_count, epoch, id, type, subject, data, recorded_at)
     SELECT r >> 4, n, 0, 1, 1, transaction_id, 'com.rezics.library.subject.listed.v1',
       subject_id::text, jsonb_build_object('subjectId', subject_id), $5::timestamptz FROM source
     WHERE cardinality($4::uuid[]) > 0`,
    parameters,
  );
  await db.admin.query(
    `${source} INSERT INTO editorial.write_basis
      (partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, recorded_at)
     SELECT r >> 4, transaction_id, 1, n, 'account', curator_id, 'web', $5::timestamptz FROM source
     WHERE cardinality($4::uuid[]) > 0`,
    parameters,
  );
  // Completed history makes DBOS point lookups choose indexes under the same statistics as production.
  // Seed every history relation used by the effect and durable page step before the harness vacuums.
  await db.admin.query(
    `WITH history AS (
       SELECT n, $1 || n::text AS workflow_uuid
       FROM generate_series($2::int, $3::int) n
     ), inserted AS (
       INSERT INTO dbos.workflow_status
         (workflow_uuid, status, name, queue_name, authenticated_user, assumed_role, authenticated_roles,
          executor_id, application_id, created_at, updated_at, completed_at, recovery_attempts, inputs,
          queue_partition_key, serialization)
       SELECT workflow_uuid, 'SUCCESS', 'effect', 'effects', '', '', '[]', '', 'rezics-kernel',
         $4::bigint, $4::bigint, $4::bigint, 0, '[]', $5, 'JSON' FROM history
       RETURNING workflow_uuid
     ), inputs AS (
       INSERT INTO dbos.workflow_input (workflow_uuid, inputs)
       SELECT workflow_uuid, '[]' FROM inserted
     ), outputs AS (
       INSERT INTO dbos.workflow_output (workflow_uuid, output, error)
       SELECT workflow_uuid, 'null', '' FROM inserted
     )
     INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output, error)
     SELECT workflow_uuid, 1, 'effect.run', 'null', '' FROM inserted`,
    [historyPrefix, previous * 500 + 1, scale * 500, Date.parse(at), String(partitionOf(sourceRoute))],
  );
}

async function probes(subjects: string[]) {
  const collections = Array.from({ length: 18 }, () => newId(sourceRoute));
  const curator = newId(sourceRoute);
  await db.admin.query(
    `INSERT INTO library.collection
      (route, collection_id, curator_account_id, title, visibility, state, revision, member_count,
       created_at, updated_at, transaction_id)
     SELECT $1, id, $2, 'Probe', 'public', 'active', 1, cardinality($4::uuid[]), $5, $5, id
     FROM unnest($3::uuid[]) id`,
    [sourceRoute, curator, collections, subjects, at],
  );
  await db.admin.query(
    `INSERT INTO library.collection_member
      (route, collection_id, member_id, subject_id, ordinal_key, added_at, transaction_id)
     SELECT $1, c.id, ${sqlId('60000000', '$1::int', 'c.ordinal::int * 10 + s.ordinal::int')},
       s.id, 'a' || s.ordinal, $4, c.id
     FROM unnest($2::uuid[]) WITH ORDINALITY c(id, ordinal)
     CROSS JOIN unnest($3::uuid[]) WITH ORDINALITY s(id, ordinal)`,
    [sourceRoute, collections, subjects, at],
  );
  return collections;
}

async function run(
  collectionId: string,
  subjects: string[],
  workflow: boolean,
  scale: number,
  repetition: number,
  measured = true,
) {
  runPlans = [];
  const id = randomUUID();
  const event: CloudEvent = {
    specversion: '1.0',
    id,
    source: 'urn:rezics:log:1699.1',
    type: workflow
      ? 'com.rezics.library.collection.listing.changed.v1'
      : 'com.rezics.library.collection.member.changed.v1',
    subject: collectionId,
    time: at,
    sequence: '0000000000000000001',
    datacontenttype: 'application/json',
    data: workflow
      ? { collectionId }
      : {
          collectionId,
          subjectId: subjects[0]!,
          memberId: `60000000-0000-7000-8000-6a31${((repetition + 1) * 10 + 1).toString(16).padStart(8, '0')}`,
        },
  };
  const handle = await client.enqueue(
    {
      workflowName: 'effect',
      queueName: 'effects',
      queuePartitionKey: String(partitionOf(sourceRoute)),
      workflowID: randomUUID(),
    },
    workflow ? 'library_collection_listing' : 'library_member_listing',
    event,
  );
  await handle.getResult({ pollingIntervalMs: 10 });
  if (workflow) await client.retrieveWorkflow(event.id).getResult({ pollingIntervalMs: 10 });
  if (measured) {
    const cost = costOf({ statements: [], plans: runPlans });
    for (const relation of [
      'library.collection',
      'library.collection_member',
      'library.subject_collection',
      'library.subject_listing',
    ])
      expect(cost.relations[relation], relation).toBeDefined();
    for (const [relation, relationCost] of Object.entries(cost.relations))
      if (relation.startsWith('library.')) expect(relationCost.sequentialScans, relation).toBe(0);
    runs.push({ scale, plans: runPlans });
  }
  const result = await db.admin.query(
    `SELECT subject_id FROM library.subject_collection WHERE route=$1 AND collection_id=$2 AND multiplicity=1`,
    [subjectRoute, collectionId],
  );
  expect(result.rows.map((row) => row.subject_id).sort()).toEqual([...subjects].sort());
}

function reportSamples(report: { name: string; samples: readonly GrowthSample[] }) {
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
}

async function check(name: string, workflow: boolean) {
  const subjects = Array.from({ length: workflow ? 4 : 1 }, () => newId(subjectRoute));
  const collections = await probes(subjects);
  runs.length = 0;
  const operation = (_db: GrowthDatabase, scale: number, repetition: number) =>
    run(collections[repetition]!, subjects, workflow, scale, repetition);
  try {
    const report = await checkGrowth(db, {
      name,
      scales: [1, 4, 16],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (_db, scale, previous) => grow(scale, previous, subjects),
      operation,
      warmup: (_db, scale, repetition) => run(collections[repetition]!, subjects, workflow, scale, repetition, false),
    });
    reportSamples(report);
  } catch (error) {
    if (error instanceof GrowthBoundError) {
      reportSamples({ name, samples: error.samples });
      console.error(JSON.stringify({ message: error.message, runs }));
    }
    throw error;
  }
}

test("Member listing effect has constant rows and statements as unrelated Collections and the subject's other shelves grow", async () => {
  await check('Member listing effect', false);
}, 120_000);

test('Listing-change workflow step has constant rows and statements as unrelated Collections and subjects grow', async () => {
  await check('Listing-change workflow step', true);
}, 120_000);
