import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createReportEffect } from '../../src/content/report-effect.ts';
import { requireReportInspection } from '../../src/content/report-admission.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';
import { observeSql } from './support/sql-observer.ts';
import { seedReportGrowth, type ReportGrowthRow } from './support/report-growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [64, 512, 4096] as const;
const repetitions = 3;
const warmups = 1;
const runsPerScale = repetitions + warmups;
const day = 24 * 60 * 60 * 1000;
const reportCreatedAt = '2026-10-27T00:00:00.000Z';
const reportCreatedEvent = 'com.rezics.content.report.created.v1';
const reportProjectedEvent = 'com.rezics.content.report-target.projected.v1';

let system: NativeContentSystem;
let growthDb: GrowthDatabase;
const growthPlans: string[] = [];

beforeAll(async () => {
  system = await createNativeContentSystem({ databaseUrl });
  growthDb = await openGrowthDatabase(system.database.pool.options.connectionString);
  growthDb.pool.on('connect', (client) =>
    client.on('notice', (notice) => {
      if (notice.message?.includes('plan:\n')) growthPlans.push(notice.message);
    }),
  );
}, 120_000);

afterAll(async () => {
  await growthDb?.close();
  await system?.close();
});

type GrantRow = {
  route: number;
  resourceId: string;
  subjectId: string;
  lower: string;
  upper: string | null;
  transactionId: string;
};

async function insertGrantHistory(db: GrowthDatabase, rows: readonly GrantRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     SELECT route,resource_id,subject_id,'moderation:read_reports',tstzrange(lower_at,upper_at,'[)'),transaction_id
     FROM unnest($1::integer[],$2::uuid[],$3::uuid[],$4::timestamptz[],$5::timestamptz[],$6::uuid[])
       AS row(route,resource_id,subject_id,lower_at,upper_at,transaction_id)`,
    [
      rows.map((row) => row.route),
      rows.map((row) => row.resourceId),
      rows.map((row) => row.subjectId),
      rows.map((row) => row.lower),
      rows.map((row) => row.upper),
      rows.map((row) => row.transactionId),
    ],
  );
}

function routedGrantRows(route: number, resourceIds: readonly string[], subjectId: string, at: string): GrantRow[] {
  return resourceIds.map((resourceId) => ({
    route,
    resourceId,
    subjectId,
    lower: at,
    upper: null,
    transactionId: randomUUID(),
  }));
}

async function insertAccessDistractors(db: GrowthDatabase, rows: readonly GrantRow[]): Promise<void> {
  if (rows.length === 0) return;
  const parameters = [
    rows.map((row) => row.route),
    rows.map((row) => row.resourceId),
    rows.map((row) => row.subjectId),
    rows.map((row) => row.lower),
    rows.map((row) => row.transactionId),
  ];
  await db.admin.query(
    `INSERT INTO access.resource_role_grant
       (route,resource_id,subject_id,grant_role,valid,transaction_id)
     SELECT route,resource_id,subject_id,'content.post.owner',tstzrange(lower_at,NULL,'[)'),transaction_id
     FROM unnest($1::integer[],$2::uuid[],$3::uuid[],$4::timestamptz[],$5::uuid[])
       AS row(route,resource_id,subject_id,lower_at,transaction_id)`,
    parameters,
  );
  await db.admin.query(
    `INSERT INTO access.resource_denial
       (route,resource_id,subject_id,action,reason,valid,transaction_id)
     SELECT route,resource_id,subject_id,'moderation:read_reports','resource',tstzrange(lower_at,NULL,'[)'),transaction_id
     FROM unnest($1::integer[],$2::uuid[],$3::uuid[],$4::timestamptz[],$5::uuid[])
       AS row(route,resource_id,subject_id,lower_at,transaction_id)`,
    parameters,
  );
}

async function seedAccountAndMembershipRows(db: GrowthDatabase, route: number, count: number): Promise<void> {
  if (count === 0) return;
  const accounts = Array.from({ length: count }, () => newId(route));
  const transactions = accounts.map(() => randomUUID());
  const groups = accounts.map(() => newId(0x3131));
  const reservations = accounts.map(() => randomUUID());
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     SELECT $1,account_id,'actor','active',transaction_id
     FROM unnest($2::uuid[],$3::uuid[]) AS row(account_id,transaction_id)`,
    [route, accounts, transactions],
  );
  await db.admin.query(
    `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     SELECT $1,account_id,'realm',group_id,reservation_id,transaction_id
     FROM unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::uuid[])
       AS row(account_id,group_id,reservation_id,transaction_id)`,
    [route, accounts, groups, reservations, transactions],
  );
}

function periodStart(activeStart: number, daysBefore: number): string {
  return new Date(activeStart - daysBefore * day).toISOString();
}

async function captureFailureEvidence<T>(db: GrowthDatabase, run: () => Promise<T>): Promise<T> {
  const observer = observeSql(db.pool);
  const planOffset = growthPlans.length;
  try {
    return await run();
  } catch (error) {
    const value = error as {
      name?: string;
      violations?: readonly unknown[];
      samples?: readonly unknown[];
    };
    if (value.name === 'GrowthBoundError')
      console.error(
        JSON.stringify({
          violations: value.violations,
          samples: value.samples,
          sql: observer.records.map(({ statement }) => statement),
          plans: growthPlans.slice(planOffset),
        }),
      );
    throw error;
  } finally {
    await observer.close();
  }
}

test('Report inspection admission stays within its bound as report and grant history grows', async () => {
  const route = 0x6701;
  const samePartitionRoute = 0x6702;
  const otherPartitionRoute = 0x6711;
  const actorRoute = routeOf(system.actors.moderator.actor.accountId)!;
  const actorId = system.actors.moderator.actor.accountId;
  const targetByRun = new Map<number, string>();
  let nextRun = 0;
  let bearer = system.actors.moderator.bearer;
  const activeStart = Date.now() - day;

  await captureFailureEvidence(growthDb, async () => {
    const report = await checkGrowth(growthDb, {
      name: 'Report inspection admission',
      scales,
      repetitions,
      warmups,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(db, scale, previous) {
        const ids = Array.from({ length: runsPerScale }, () => newId(route));
        const runOffset = nextRun;
        ids.forEach((id, index) => targetByRun.set(runOffset + index, id));
        nextRun += ids.length;

        const history: GrantRow[] = [];
        for (const resourceId of ids) {
          for (let index = previous; index < scale; index++) {
            history.push({
              route,
              resourceId,
              subjectId: actorId,
              lower: periodStart(activeStart, index + 2),
              upper: periodStart(activeStart, index + 1),
              transactionId: randomUUID(),
            });
          }
          history.push({
            route,
            resourceId,
            subjectId: actorId,
            lower: new Date(activeStart).toISOString(),
            upper: null,
            transactionId: randomUUID(),
          });
        }
        await insertGrantHistory(db, history);

        const backgroundFrom = previous === 0 ? 0 : 4096 + previous;
        const backgroundTo = 4096 + scale;
        const backgroundCount = backgroundTo - backgroundFrom;
        const reportHistory = ids.flatMap((id) => reportRows(scale - previous, 0x4421, route, id));
        const unrelatedReportTarget = newId(route);
        const otherPartitionReportTarget = newId(otherPartitionRoute);
        const reportDistractors = [
          ...reportRows(backgroundCount, 0x4422, route, unrelatedReportTarget),
          ...reportRows(backgroundCount, 0x4431, otherPartitionRoute, otherPartitionReportTarget),
        ];
        await seedReportGrowth(db.admin, [...reportHistory, ...reportDistractors]);

        const sameResources = Array.from({ length: backgroundCount }, () => newId(samePartitionRoute));
        const otherResources = Array.from({ length: backgroundCount }, () => newId(otherPartitionRoute));
        const sameRows = routedGrantRows(
          samePartitionRoute,
          sameResources,
          actorId,
          new Date(activeStart).toISOString(),
        );
        const otherRows = routedGrantRows(
          otherPartitionRoute,
          otherResources,
          actorId,
          new Date(activeStart).toISOString(),
        );
        await insertGrantHistory(db, [...sameRows, ...otherRows]);
        await insertAccessDistractors(db, [...sameRows, ...otherRows]);
        await seedAccountAndMembershipRows(db, actorRoute, backgroundCount);

        bearer = (
          await system.auth.issue({
            accountId: actorId,
            clientId: system.actors.moderator.actor.clientId,
            scopes: [...system.actors.moderator.actor.scopes],
          })
        ).bearer;
      },
      async operation(db, _scale, repetition) {
        const targetId = targetByRun.get(repetition);
        if (!targetId) throw new Error(`Missing fresh inspection target for run ${repetition}`);
        const deadline = Date.now() + 30_000;
        const actor = await system.access.authenticate(bearer, { pool: db.pool, deadline });
        await requireReportInspection({ pool: db.pool, access: system.access, routeKey: system.routeKey }, targetId, {
          actor,
          deadline,
        });
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  });
}, 600_000);

type ReportOutboxRow = {
  partition_no: number;
  position: string;
  epoch: number;
  id: string;
  type: string;
  subject: string;
  data: unknown;
};

async function seedOutboxHistory(
  db: GrowthDatabase,
  partition: number,
  reportRoute: number,
  targetRoute: number,
  count: number,
): Promise<void> {
  if (count === 0) return;
  const { rows: states } = await db.admin.query<{ position: string; epoch: number }>(
    'SELECT position::text,epoch FROM core.partition WHERE partition_no=$1',
    [partition],
  );
  const state = states[0];
  if (!state) throw new Error(`Missing outbox partition ${partition}`);
  const start = BigInt(state.position);
  const positions = Array.from({ length: count }, (_, index) => (start + BigInt(index + 1)).toString());
  const ids = positions.map(() => randomUUID());
  const reportIds = positions.map(() => newId(reportRoute));
  const targetIds = positions.map(() => newId(targetRoute));
  await db.admin.query(
    `INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
     SELECT $1,position::bigint,0,1,$2,event_id,'${reportProjectedEvent}',report_id::text,
            jsonb_build_object('reportId',report_id,'targetKind','post','targetId',target_id)
     FROM unnest($3::bigint[],$4::uuid[],$5::uuid[],$6::uuid[])
       AS row(position,event_id,report_id,target_id)`,
    [partition, state.epoch, positions, ids, reportIds, targetIds],
  );
  await db.admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
    partition,
    (start + BigInt(count)).toString(),
  ]);
}

function reportRows(count: number, reportRoute: number, targetRoute: number, targetId: string): ReportGrowthRow[] {
  return Array.from({ length: count }, () => ({
    reportId: newId(reportRoute),
    reportRoute,
    targetKind: 'post',
    targetId,
    targetRoute,
    createdAt: reportCreatedAt,
    transactionId: randomUUID(),
    idempotencyKey: `growth-${randomUUID()}`,
    reporterAccountId: system.actors.author.actor.accountId,
  }));
}

async function makeInputEvents(db: GrowthDatabase, rows: readonly ReportGrowthRow[]): Promise<CloudEvent[]> {
  await seedReportGrowth(db.admin, rows, [], {
    projectTargets: false,
    commandEvents: {
      principalId: system.actors.author.actor.accountId,
      principalKind: 'account',
      clientId: system.actors.author.actor.clientId,
    },
  });
  const ids = rows.map(({ reportId }) => reportId);
  const { rows: outbox } = await db.admin.query<ReportOutboxRow>(
    `SELECT partition_no,position::text,epoch,id,type,subject,data
     FROM core.outbox WHERE type=$1 AND subject=ANY($2::text[])`,
    [reportCreatedEvent, ids],
  );
  const createdAt = new Map(rows.map(({ reportId, createdAt: time }) => [reportId, time]));
  if (outbox.length !== rows.length) throw new Error('Growth reports did not produce their source events');
  return outbox.map((row) => ({
    specversion: '1.0',
    id: row.id,
    type: row.type,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    sequence: BigInt(row.position).toString().padStart(19, '0'),
    subject: row.subject,
    time: createdAt.get(row.subject)!,
    datacontenttype: 'application/json',
    data: row.data,
  }));
}

test('Report effects stay within their bound as report history grows', async () => {
  const targetRoute = 0x6a01;
  const otherTargetRoute = 0x6a11;
  const sourceRoute = 0x3221;
  const samePartitionSourceRoute = 0x3222;
  const otherPartitionSourceRoute = 0x3231;
  const targetId = newId(targetRoute);
  const inputEvents = new Map<number, CloudEvent>();
  let nextRun = 0;
  const targetPartition = partitionOf(targetRoute);
  const otherTargetPartition = partitionOf(otherTargetRoute);

  await captureFailureEvidence(growthDb, async () => {
    const report = await checkGrowth(growthDb, {
      name: 'Report effect',
      scales,
      repetitions,
      warmups,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(db, scale, previous) {
        const history = reportRows(scale - previous, sourceRoute, targetRoute, targetId);
        const samePartitionCount = previous === 0 ? 4096 + scale : scale - previous;
        const otherPartitionCount = previous === 0 ? 4096 + scale : scale - previous;
        const samePartitionTargetId = newId(targetRoute);
        const otherPartitionTargetId = newId(otherTargetRoute);
        const samePartition = reportRows(
          samePartitionCount,
          samePartitionSourceRoute,
          targetRoute,
          samePartitionTargetId,
        );
        const otherPartition = reportRows(
          otherPartitionCount,
          otherPartitionSourceRoute,
          otherTargetRoute,
          otherPartitionTargetId,
        );
        await seedReportGrowth(db.admin, [...history, ...samePartition, ...otherPartition]);

        const freshInputs = reportRows(runsPerScale, sourceRoute, targetRoute, targetId).map((row) => ({
          ...row,
          createdAt: new Date().toISOString(),
        }));
        const events = await makeInputEvents(db, freshInputs);
        events.forEach((event, index) => inputEvents.set(nextRun + index, event));
        nextRun += events.length;

        const backgroundCount = previous === 0 ? 4096 + scale : scale - previous;
        await seedOutboxHistory(db, targetPartition, sourceRoute, targetRoute, backgroundCount);
        await seedOutboxHistory(db, otherTargetPartition, sourceRoute, otherTargetRoute, backgroundCount);
      },
      async operation(db, _scale, repetition) {
        const event = inputEvents.get(repetition);
        if (!event) throw new Error(`Missing fresh report event for run ${repetition}`);
        const effect = createReportEffect(db.pool);
        await effect.run(event);
        await effect.run(event);
        const { rows } = await db.admin.query<{ projected: number; events: number }>(
          `SELECT
             (SELECT count(*)::integer FROM content.report_target
               WHERE route=$1 AND target_kind='post' AND target_id=$2 AND report_route=$3 AND report_id=$4) AS projected,
             (SELECT count(*)::integer FROM core.outbox
               WHERE partition_no=$5 AND type=$6 AND data->>'reportId'=$4::text) AS events`,
          [targetRoute, targetId, sourceRoute, event.subject, targetPartition, reportProjectedEvent],
        );
        expect(rows[0]).toEqual({ projected: 1, events: 1 });
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  });
}, 600_000);
