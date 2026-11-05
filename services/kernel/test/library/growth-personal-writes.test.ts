import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createAccess } from '../../src/access/permission.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import { createEntryCommands } from '../../src/library/entries.ts';
import { createFollowCommands } from '../../src/library/follows.ts';
import { createLoanCommands } from '../../src/library/loan-commands.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthReport } from '../support/growth.ts';
import { testRouteKey } from '../support/test-kernel.ts';

const ROWS_PER_SCALE = 500;
const RUNS_PER_SCALE = 6; // checkGrowth defaults: one warm-up and five measured runs.
const PROBE_OFFSET = 1_000_000;
const TIME = '2026-10-26T12:00:00.000Z';
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(71)]]) };

type PreparedGrowth = {
  readonly actor: AccountActor;
  readonly ownerRoute: number;
  readonly ownerPartition: number;
  readonly otherPartition: number;
  readonly targetRoute: number;
  readonly seedSalt: number;
};

let database: GrowthDatabase;
let commandPool: ReturnType<GrowthDatabase['openPool']>;
let activeSequentialScans: Map<string, number> | null = null;

function uuidExpression(route: string, suffix: string, prefix = '10000000'): string {
  return `('${prefix}-0000-7000-8000-' || lpad(to_hex(${route}), 4, '0') || lpad(to_hex((${suffix})::bigint), 8, '0'))::uuid`;
}

function routedId(route: number, suffix: number, prefix = '10000000'): string {
  return `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${suffix.toString(16).padStart(8, '0')}`;
}

function scaleRunStart(scale: number): number {
  if (scale === 1) return 0;
  if (scale === 4) return RUNS_PER_SCALE;
  if (scale === 16) return RUNS_PER_SCALE * 2;
  throw new RangeError(`Unexpected growth scale: ${scale}`);
}

function visitPlan(value: unknown, scans: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const child of value) visitPlan(child, scans);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (node['Node Type'] === 'Seq Scan' && node.Schema === 'library' && typeof node['Relation Name'] === 'string') {
    const relation = `library.${node['Relation Name']}`;
    scans.set(relation, (scans.get(relation) ?? 0) + 1);
  }
  for (const child of Object.values(node)) visitPlan(child, scans);
}

function recordPlanNotice(notice: { message: string | undefined }): void {
  if (!activeSequentialScans || !notice.message?.startsWith('duration:')) return;
  const marker = 'plan:\n';
  const offset = notice.message.indexOf(marker);
  if (offset < 0) return;
  visitPlan(JSON.parse(notice.message.slice(offset + marker.length)) as unknown, activeSequentialScans);
}

async function measuredRun<T>(work: () => Promise<T>): Promise<T> {
  const scans = new Map<string, number>();
  activeSequentialScans = scans;
  try {
    const result = await work();
    for (const [relation, count] of scans) {
      if (relation.startsWith('library.')) expect(count).toBe(0);
    }
    return result;
  } finally {
    activeSequentialScans = null;
  }
}

function assertReportHasNoSequentialScans(report: GrowthReport, relations: readonly string[]): void {
  for (const sample of report.samples) {
    for (const relation of relations) {
      expect(sample.cost.relations?.[relation]?.sequentialScans ?? 0).toBe(0);
    }
  }
}

function printSamples(report: GrowthReport): void {
  console.info(
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

async function prepareGrowth(scopes: readonly string[]): Promise<PreparedGrowth> {
  const ownerRoute = randomInt(0, 65_536);
  const actor: AccountActor = {
    kind: 'account',
    accountId: newId(ownerRoute),
    scopes,
    clientId: 'library-personal-write-growth',
    requestedBy: null,
    authnEpoch: 1,
  };
  const ownerPartition = partitionOf(ownerRoute);
  const otherPartition = ownerPartition === 4095 ? 4094 : ownerPartition + 1;
  await database.admin.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
     VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
    [ownerRoute, actor.accountId, newId(ownerRoute)],
  );
  return {
    actor,
    ownerRoute,
    ownerPartition,
    otherPartition,
    targetRoute: (ownerRoute + 1) % 65_536,
    seedSalt: randomInt(1, 1_000_000_000),
  };
}

async function seedSharedRows(prepared: PreparedGrowth, scale: number, previous: number): Promise<void> {
  const count = ROWS_PER_SCALE * (scale - previous);
  const previousRows = ROWS_PER_SCALE * previous;
  const generatedRoute = `(partition_no * 16 + ((n - 1) % 16))`;
  const generatedAccount = uuidExpression(generatedRoute, `$4::bigint + $5::bigint + n`, '50000000');
  const generatedTransaction = uuidExpression(generatedRoute, `$4::bigint + 50000 + $5::bigint + n`, '60000000');
  await database.admin.query(
    `WITH generated AS (
       SELECT ${generatedRoute} AS route, ${generatedAccount} AS account_id,
              ${generatedTransaction} AS transaction_id
       FROM generate_series(1, $3::int) AS n
       CROSS JOIN (VALUES ($1::int), ($2::int)) AS partitions(partition_no)
     )
     INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
     SELECT route, account_id, 'actor', 'active', transaction_id, false, 1
     FROM generated`,
    [prepared.ownerPartition, prepared.otherPartition, count, prepared.seedSalt, previousRows],
  );

  const partitionRoute = `(partition_no * 16 + ((n - 1) % 16))`;
  const principal = uuidExpression(partitionRoute, `$4::bigint + 100000 + $5::bigint + n`, '70000000');
  const receiptTransaction = uuidExpression(partitionRoute, `$4::bigint + 150000 + $5::bigint + n`, '71000000');
  await database.admin.query(
    `INSERT INTO core.receipt
       (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest, epoch,
        position, transaction_id, response)
     SELECT partition_no, 'account', ${principal}, 'library.growth.seed',
            'growth-seed-' || $4::text || '-' || $5::text || '-' || partition_no::text || '-' || n::text,
            decode(repeat('a5', 32), 'hex'), 1, $5::bigint + n + 1, ${receiptTransaction}, '{}'::jsonb
     FROM generate_series(1, $3::int) AS n
     CROSS JOIN (VALUES ($1::int), ($2::int)) AS partitions(partition_no)`,
    [prepared.ownerPartition, prepared.otherPartition, count, prepared.seedSalt, previousRows],
  );

  const outboxId = uuidExpression(partitionRoute, `$4::bigint + 200000 + $6::bigint + n`, '72000000');
  await database.admin.query(
    `INSERT INTO core.outbox
       (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
     SELECT partition_no, 2000000000::bigint + $4::bigint + $6::bigint + n, 0, 1, 1, ${outboxId},
            'com.rezics.library.entry.deleted.v1', $5::text,
            jsonb_build_object('subjectId', ${uuidExpression(partitionRoute, `$4::bigint + 250000 + $6::bigint + n`, '73000000')})
     FROM generate_series(1, $3::int) AS n
     CROSS JOIN (VALUES ($1::int), ($2::int)) AS partitions(partition_no)`,
    [
      prepared.ownerPartition,
      prepared.otherPartition,
      count,
      prepared.seedSalt,
      prepared.actor.accountId,
      previousRows,
    ],
  );

  const basisPrincipal = uuidExpression(partitionRoute, `$4::bigint + 300000 + $5::bigint + n`, '74000000');
  const basisTransaction = uuidExpression(partitionRoute, `$4::bigint + 350000 + $5::bigint + n`, '75000000');
  await database.admin.query(
    `INSERT INTO editorial.write_basis
       (partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, requested_by)
     SELECT partition_no, ${basisTransaction}, 1, 2000000000::bigint + $4::bigint + $5::bigint + n,
            'account', ${basisPrincipal}, 'library-personal-write-growth', NULL
     FROM generate_series(1, $3::int) AS n
     CROSS JOIN (VALUES ($1::int), ($2::int)) AS partitions(partition_no)`,
    [prepared.ownerPartition, prepared.otherPartition, count, prepared.seedSalt, previousRows],
  );
}

async function seedEntries(prepared: PreparedGrowth, scale: number, previous: number): Promise<void> {
  const count = ROWS_PER_SCALE * (scale - previous);
  const previousRows = ROWS_PER_SCALE * previous;
  const runStart = scaleRunStart(scale);
  const roleRoute = `CASE role WHEN 0 THEN $1::int WHEN 1 THEN $3::int * 16 + ((n - 1) % 16)
                     WHEN 2 THEN $4::int * 16 + ((n - 1) % 16) ELSE $1::int END`;
  const noiseAccount = uuidExpression('route', `$7::bigint + 100000 + role * 20000 + $10::bigint + n`);
  const subject = uuidExpression('$6::int', `$7::bigint + 200000 + $10::bigint + n`, '30000000');
  const probeSubject = uuidExpression(
    '$6::int',
    `$7::bigint + ${PROBE_OFFSET} + $8::bigint + n - $5::int - 1`,
    '30000000',
  );
  const transaction = uuidExpression('route', `$7::bigint + 400000 + role * 20000 + $10::bigint + n`, '40000000');
  await database.admin.query(
    `WITH generated AS (
       SELECT n, role, ${roleRoute} AS route
       FROM generate_series(1, $5::int + ${RUNS_PER_SCALE}) AS n
       CROSS JOIN LATERAL (
         SELECT role FROM (VALUES (0), (1), (2)) AS noise(role) WHERE n <= $5::int
         UNION ALL SELECT 3 WHERE n > $5::int
       ) AS selected
     )
     INSERT INTO library.entry
       (route, account_id, subject_id, requested_subject_id, state, revision, created_at, updated_at, transaction_id)
     SELECT route,
            CASE WHEN role IN (0, 3) THEN $2::uuid ELSE ${noiseAccount} END,
            CASE WHEN role = 3 THEN ${probeSubject} ELSE ${subject} END,
            NULL, 'planned', 1, $9::timestamptz, $9::timestamptz + n * interval '1 millisecond', ${transaction}
     FROM generated`,
    [
      prepared.ownerRoute,
      prepared.actor.accountId,
      prepared.ownerPartition,
      prepared.otherPartition,
      count,
      prepared.targetRoute,
      prepared.seedSalt,
      runStart,
      TIME,
      previousRows,
    ],
  );
}

async function seedCopies(prepared: PreparedGrowth, scale: number, previous: number): Promise<void> {
  const count = ROWS_PER_SCALE * (scale - previous);
  const previousRows = ROWS_PER_SCALE * previous;
  const runStart = scaleRunStart(scale);
  const roleRoute = `CASE role WHEN 0 THEN $1::int WHEN 1 THEN $3::int * 16 + ((n - 1) % 16)
                     WHEN 2 THEN $4::int * 16 + ((n - 1) % 16) ELSE $1::int END`;
  const noiseAccount = uuidExpression('route', `$7::bigint + 100000 + role * 20000 + $10::bigint + n`);
  const noiseCopy = uuidExpression('route', `$7::bigint + 250000 + role * 20000 + $10::bigint + n`, '20000000');
  const probeCopy = uuidExpression(
    '$1::int',
    `$7::bigint + ${PROBE_OFFSET} + $8::bigint + n - $5::int - 1`,
    '20000000',
  );
  const subject = uuidExpression('$6::int', `$7::bigint + 300000 + $10::bigint + n`, '30000000');
  const transaction = uuidExpression('route', `$7::bigint + 400000 + role * 20000 + $10::bigint + n`, '40000000');
  await database.admin.query(
    `WITH generated AS (
       SELECT n, role, ${roleRoute} AS route
       FROM generate_series(1, $5::int + ${RUNS_PER_SCALE}) AS n
       CROSS JOIN LATERAL (
         SELECT role FROM (VALUES (0), (1), (2)) AS noise(role) WHERE n <= $5::int
         UNION ALL SELECT 3 WHERE n > $5::int
       ) AS selected
     )
     INSERT INTO library.copy
       (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,
        created_at, updated_at, transaction_id)
     SELECT route,
            CASE WHEN role = 3 THEN ${probeCopy} ELSE ${noiseCopy} END,
            CASE WHEN role IN (0, 3) THEN $2::uuid ELSE ${noiseAccount} END,
            ${subject}, 'owned', NULL, NULL, NULL, NULL, NULL, 1, $9::timestamptz,
            $9::timestamptz + n * interval '1 millisecond', ${transaction}
     FROM generated`,
    [
      prepared.ownerRoute,
      prepared.actor.accountId,
      prepared.ownerPartition,
      prepared.otherPartition,
      count,
      prepared.targetRoute,
      prepared.seedSalt,
      runStart,
      TIME,
      previousRows,
    ],
  );
}

async function seedFollows(
  prepared: PreparedGrowth,
  scale: number,
  previous: number,
  targetType: 'collection' | 'space',
): Promise<void> {
  const count = ROWS_PER_SCALE * (scale - previous);
  const previousRows = ROWS_PER_SCALE * previous;
  const hasProbes = targetType === 'collection';
  const runStart = scaleRunStart(scale);
  const probeRows = hasProbes ? RUNS_PER_SCALE : 0;
  const roleRoute = `CASE role WHEN 0 THEN $1::int WHEN 1 THEN $3::int * 16 + ((n - 1) % 16)
                     WHEN 2 THEN $4::int * 16 + ((n - 1) % 16) ELSE $1::int END`;
  const noiseAccount = uuidExpression('route', `$7::bigint + 100000 + role * 20000 + $14::bigint + n`);
  const noiseTarget = uuidExpression('$6::int', `$7::bigint + 300000 + role * 20000 + $14::bigint + n`, '30000000');
  const probeTarget = uuidExpression(
    '$1::int',
    `$7::bigint + ${PROBE_OFFSET} + $8::bigint + n - $5::int - 1`,
    '30000000',
  );
  const transaction = uuidExpression('route', `$7::bigint + 400000 + role * 20000 + $14::bigint + n`, '40000000');
  await database.admin.query(
    `WITH generated AS (
       SELECT n, role, ${roleRoute} AS route
       FROM generate_series(1, $5::int + $9::int) AS n
       CROSS JOIN LATERAL (
         SELECT role FROM (VALUES (0), (1), (2)) AS noise(role) WHERE n <= $5::int
         UNION ALL SELECT 3 WHERE n > $5::int AND $10::boolean
       ) AS selected
     )
     INSERT INTO library.follow
       (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
     SELECT route,
            CASE WHEN role IN (0, 3) THEN $2::uuid ELSE ${noiseAccount} END,
            CASE WHEN role = 3 THEN ${probeTarget} ELSE ${noiseTarget} END,
            CASE WHEN role = 3 THEN 'collection' ELSE $11::text END,
            'following', CASE WHEN role = 3 THEN 'explicit' ELSE $12::text END,
            $13::timestamptz, $13::timestamptz + n * interval '1 millisecond', ${transaction}
     FROM generated`,
    [
      prepared.ownerRoute,
      prepared.actor.accountId,
      prepared.ownerPartition,
      prepared.otherPartition,
      count,
      prepared.targetRoute,
      prepared.seedSalt,
      runStart,
      probeRows,
      hasProbes,
      targetType,
      targetType === 'collection' ? 'explicit' : 'membership',
      TIME,
      previousRows,
    ],
  );
}

async function seedCollections(prepared: PreparedGrowth, scale: number, previous: number): Promise<void> {
  const count = ROWS_PER_SCALE * (scale - previous);
  const previousRows = ROWS_PER_SCALE * previous;
  const runStart = scaleRunStart(scale);
  const roleRoute = `CASE role WHEN 0 THEN $1::int WHEN 1 THEN $3::int * 16 + ((n - 1) % 16)
                     WHEN 2 THEN $4::int * 16 + ((n - 1) % 16) ELSE $1::int END`;
  const noiseAccount = uuidExpression('route', `$6::bigint + 100000 + role * 20000 + $9::bigint + n`);
  const noiseCollection = uuidExpression('route', `$6::bigint + 300000 + role * 20000 + $9::bigint + n`, '30000000');
  const probeCollection = uuidExpression(
    '$1::int',
    `$6::bigint + ${PROBE_OFFSET} + $7::bigint + n - $5::int - 1`,
    '30000000',
  );
  const transaction = uuidExpression('route', `$6::bigint + 400000 + role * 20000 + $9::bigint + n`, '40000000');
  await database.admin.query(
    `WITH generated AS (
       SELECT n, role, ${roleRoute} AS route
       FROM generate_series(1, $5::int + ${RUNS_PER_SCALE}) AS n
       CROSS JOIN LATERAL (
         SELECT role FROM (VALUES (0), (1), (2)) AS noise(role) WHERE n <= $5::int
         UNION ALL SELECT 3 WHERE n > $5::int
       ) AS selected
     )
     INSERT INTO library.collection
       (route, collection_id, curator_account_id, title, description, visibility, state, revision, member_count,
        order_epoch, created_at, updated_at, transaction_id)
     SELECT route,
            CASE WHEN role = 3 THEN ${probeCollection} ELSE ${noiseCollection} END,
            CASE WHEN role IN (0, 3) THEN $2::uuid ELSE ${noiseAccount} END,
            'Growth shelf', NULL, 'public', 'active', 1, 0, 0, $8::timestamptz,
            $8::timestamptz + n * interval '1 millisecond', ${transaction}
     FROM generated`,
    [
      prepared.ownerRoute,
      prepared.actor.accountId,
      prepared.ownerPartition,
      prepared.otherPartition,
      count,
      prepared.seedSalt,
      runStart,
      TIME,
      previousRows,
    ],
  );
}

async function growPersonalRows(
  prepared: PreparedGrowth,
  scale: number,
  previous: number,
  kind: 'entry' | 'copy' | 'unfollow' | 'membership' | 'loan',
): Promise<void> {
  await seedSharedRows(prepared, scale, previous);
  if (kind === 'entry') await seedEntries(prepared, scale, previous);
  if (kind === 'copy') await seedCopies(prepared, scale, previous);
  if (kind === 'loan') await seedReturnedLoans(prepared, scale, previous);
  if (kind === 'unfollow') {
    await seedCollections(prepared, scale, previous);
    await seedFollows(prepared, scale, previous, 'collection');
  }
  if (kind === 'membership') await seedFollows(prepared, scale, previous, 'space');
}

async function seedReturnedLoans(prepared: PreparedGrowth, scale: number, previous: number): Promise<void> {
  await database.admin.query(
    `WITH source AS (
       SELECT $1::int AS route, $2::uuid AS account_id, n,
         ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') ||
          lpad(to_hex($4::bigint + n), 8, '0'))::uuid AS loan_id
       FROM generate_series($3::int + 1, $5::int) AS n
     )
     INSERT INTO library.copy_loan
       (route,loan_id,account_id,copy_id,direction,counterparty_kind,counterparty_name,counterparty_person_id,
        started_on,due_on,returned_on,revision,created_at,updated_at,transaction_id)
     SELECT route,loan_id,account_id,loan_id,'lent','name','retained history',NULL,
            '2018-01-01','2018-02-01','2019-01-01',2,$6::timestamptz,$6::timestamptz,loan_id
       FROM source`,
    [
      prepared.ownerRoute,
      prepared.actor.accountId,
      previous * ROWS_PER_SCALE,
      prepared.seedSalt,
      scale * ROWS_PER_SCALE,
      TIME,
    ],
  );
}

function probeLoan(prepared: PreparedGrowth, repetition: number): string {
  return routedId(prepared.ownerRoute, prepared.seedSalt + PROBE_OFFSET + repetition, '80000000');
}

function probeLoanCopy(prepared: PreparedGrowth): string {
  return routedId(prepared.ownerRoute, prepared.seedSalt + 1, '20000000');
}

async function seedOpenLoan(prepared: PreparedGrowth, repetition: number): Promise<void> {
  const loanId = probeLoan(prepared, repetition);
  await commandPool.query(
    `INSERT INTO library.copy_loan
      (route,loan_id,account_id,copy_id,direction,counterparty_kind,counterparty_name,counterparty_person_id,
       started_on,due_on,returned_on,revision,created_at,updated_at,transaction_id)
     VALUES ($1,$2,$3,$4,'lent','name','loan write growth',NULL,'2018-01-01',NULL,NULL,1,$5,$5,$2)`,
    [prepared.ownerRoute, loanId, prepared.actor.accountId, probeLoanCopy(prepared), TIME],
  );
}

function probeEntry(prepared: PreparedGrowth, repetition: number): string {
  return routedId(prepared.targetRoute, prepared.seedSalt + PROBE_OFFSET + repetition, '30000000');
}

function probeCopy(prepared: PreparedGrowth, repetition: number): string {
  return routedId(prepared.ownerRoute, prepared.seedSalt + PROBE_OFFSET + repetition, '20000000');
}

function probeCollection(prepared: PreparedGrowth, repetition: number): string {
  return routedId(prepared.ownerRoute, prepared.seedSalt + PROBE_OFFSET + repetition, '30000000');
}

function assertLibraryRows(report: GrowthReport, relations: readonly string[]): void {
  assertReportHasNoSequentialScans(report, relations);
  printSamples(report);
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  commandPool = database.openPool();
  commandPool.on('connect', (client: PoolClient) => {
    client.on('notice', (notice) => recordPlanNotice(notice));
  });
});

afterAll(async () => {
  if (database) await database.close();
});

test('Entry delete has constant rows and statements as entries grow', async () => {
  const prepared = await prepareGrowth(['library_entry:delete']);
  const access = createAccess({ actions: new Map(), accountEvidence: () => null });
  const commands = createEntryCommands({ pool: commandPool, access, tokens });
  const run = (repetition: number) =>
    commands.deleteEntry(prepared.actor, probeEntry(prepared, repetition), 1, randomUUID());
  const report = await checkGrowth(database, {
    name: 'entry delete',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) => growPersonalRows(prepared, scale, previous, 'entry'),
    warmup: (_database, _scale, repetition) => run(repetition),
    operation: (_database, _scale, repetition) => measuredRun(() => run(repetition)),
  });
  assertLibraryRows(report, ['library.entry']);
}, 120_000);

test('Copy delete has constant rows and statements as copies grow', async () => {
  const prepared = await prepareGrowth(['copy:delete']);
  const access = createAccess({ actions: new Map(), accountEvidence: () => null });
  const commands = createCopyCommands({ pool: commandPool, access, tokens });
  const run = (repetition: number) =>
    commands.deleteCopy(prepared.actor, probeCopy(prepared, repetition), 1, randomUUID());
  const report = await checkGrowth(database, {
    name: 'copy delete',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) => growPersonalRows(prepared, scale, previous, 'copy'),
    warmup: (_database, _scale, repetition) => run(repetition),
    operation: (_database, _scale, repetition) => measuredRun(() => run(repetition)),
  });
  assertLibraryRows(report, ['library.copy']);
}, 120_000);

test('Unfollow has constant rows and statements as follows grow', async () => {
  const prepared = await prepareGrowth(['follow:delete']);
  const access = createAccess({ actions: new Map(), accountEvidence: () => null });
  const commands = createFollowCommands({ pool: commandPool, access });
  const run = (repetition: number) =>
    commands.unfollow(
      prepared.actor,
      { targetId: probeCollection(prepared, repetition), targetType: 'collection' },
      randomUUID(),
    );
  const report = await checkGrowth(database, {
    name: 'unfollow',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) => growPersonalRows(prepared, scale, previous, 'unfollow'),
    warmup: (_database, _scale, repetition) => run(repetition),
    operation: (_database, _scale, repetition) => measuredRun(() => run(repetition)),
  });
  assertLibraryRows(report, ['library.collection', 'library.follow']);
}, 120_000);

test('Membership follow has constant rows and statements as follows grow', async () => {
  const prepared = await prepareGrowth([]);
  const commands = createFollowCommands({
    pool: commandPool,
    access: createAccess({ actions: new Map(), accountEvidence: () => null }),
  });
  const run = (repetition: number) =>
    commands.followForMembership({
      accountId: prepared.actor.accountId,
      spaceId: routedId(prepared.targetRoute, prepared.seedSalt + PROBE_OFFSET + repetition, '80000000'),
      stepKey: randomUUID(),
    });
  const report = await checkGrowth(database, {
    name: 'membership follow',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) => growPersonalRows(prepared, scale, previous, 'membership'),
    operation: (_database, _scale, repetition) => measuredRun(() => run(repetition)),
  });
  assertLibraryRows(report, ['library.follow']);
}, 120_000);

test('Loan extend and return have constant work as retained returned history grows', async () => {
  const prepared = await prepareGrowth(['copy:update']);
  await commandPool.query(
    `INSERT INTO library.copy
       (route,copy_id,account_id,subject_id,status,revision,created_at,updated_at,transaction_id,kind)
     VALUES ($1,$2,$3,$4,'owned',1,$5,$5,$6,'physical')`,
    [
      prepared.ownerRoute,
      probeLoanCopy(prepared),
      prepared.actor.accountId,
      routedId(prepared.ownerRoute, prepared.seedSalt + 2, '30000000'),
      TIME,
      randomUUID(),
    ],
  );
  const access = createAccess({ actions: new Map(), accountEvidence: () => null });
  const commands = createLoanCommands({
    pool: commandPool,
    access,
    tokens,
    routeKey: testRouteKey(),
    clock: () => new Date(TIME),
  });
  const run = async (repetition: number) => {
    const loanId = probeLoan(prepared, repetition);
    const extended = await commands.extendLoan(
      prepared.actor,
      loanId,
      { revision: 1, dueOn: '2018-02-01' },
      randomUUID(),
    );
    expect(extended.value.revision).toBe(2);
    const returned = await commands.returnLoan(
      prepared.actor,
      loanId,
      { revision: 2, returnedOn: '2018-02-02' },
      randomUUID(),
    );
    expect(returned.value).toMatchObject({ revision: 3, dueOn: '2018-02-01', returnedOn: '2018-02-02' });
  };
  const report = await checkGrowth(database, {
    name: 'loan extend and return with retained history',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) => growPersonalRows(prepared, scale, previous, 'loan'),
    warmup: async (_database, _scale, repetition) => {
      await seedOpenLoan(prepared, repetition);
      await run(repetition);
    },
    prepare: (_database, _scale, repetition) => seedOpenLoan(prepared, repetition),
    operation: (_database, _scale, repetition) => measuredRun(() => run(repetition)),
  });
  assertLibraryRows(report, ['library.copy_loan', 'library.copy_loan_generation']);
}, 120_000);
