import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createReport, type ReportTarget } from '../../src/content/reports.ts';
import { applyReportEffect } from '../../src/content/report-effect.ts';
import { readBatch, type CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [32, 256, 2048] as const;
const repetitions = 3;
const warmups = 1;
const runsPerScale = repetitions + warmups;
const sourceType = 'com.rezics.content.report.created.v1';
const projectedType = 'com.rezics.content.report-target.projected.v1';

let system: NativeContentSystem;
let db: GrowthDatabase;
let target: ReportTarget;
let growOrdinal = 0;

beforeAll(async () => {
  system = await createNativeContentSystem({ databaseUrl });
  db = await openGrowthDatabase(system.database.pool.options.connectionString);
  await bootstrapRelease(system.database.pool, bundledRelease);
  const command = async <T>(
    method: string,
    path: string,
    body: unknown,
    bearer = system.actors.moderator.bearer,
    extraHeaders: Record<string, string> = {},
  ) => {
    const { response } = await system.transport.capture(
      new Request(`https://content.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) throw new Error(`Fixture command ${method} ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
  const scheme = await command<{ subject: { id: string } }>('POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Report effect fixture scheme' },
  });
  const concept = await command<{ subject: { id: string } }>('POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Report effect fixture concept' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
    },
  });
  const space = await command<{ space: { spaceId: string } }>('POST', '/v1/spaces', {
    title: 'Report effect fixture space',
    summary: 'Report effect fixture space',
  });
  const realm = await command<{ realm: { realmId: string; headRevisionId: string } }>('POST', '/v1/realms', {
    spaceId: space.space.spaceId,
    title: 'Report effect fixture realm',
    summary: 'Report effect fixture realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  await command(
    'PUT',
    `/v1/realms/${realm.realm.realmId}/boardScheme`,
    { schemeId: scheme.subject.id },
    system.actors.moderator.bearer,
    { 'if-match': JSON.stringify(realm.realm.headRevisionId) },
  );
  const board = await command<{ board: { id: string } }>('POST', `/v1/realms/${realm.realm.realmId}/boards`, {
    conceptId: concept.subject.id,
    title: 'Report effect fixture board',
    visibility: 'published',
  });
  target = { kind: 'board', id: board.board.id };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await system?.close();
});

function growthRows(population: Population, placement: { ordinal: number; route: number; partition: number }) {
  const reportId = newId(placement.route);
  const targetRoute = routeOf(target.id)!;
  return {
    'content.report': [
      {
        route: placement.route,
        report_id: reportId,
        target_kind: target.kind,
        target_id: target.id,
        revision_id: null,
        reason: 'spam',
        evidence: null,
        reporter_account_id: null,
        created_at: new Date('2026-10-27T00:00:00.000Z'),
        recorded_transaction_id: randomUUID(),
      },
    ],
    ...(population.name.endsWith('reverse')
      ? {
          'content.report_target': [
            {
              route: targetRoute,
              target_kind: target.kind,
              target_id: target.id,
              report_route: placement.route,
              report_id: reportId,
              created_at: new Date('2026-10-27T00:00:00.000Z'),
            },
          ],
        }
      : {}),
  };
}

async function createReportEvents(
  db: GrowthDatabase,
  requiredPartition?: number,
): Promise<{ events: CloudEvent[]; partition: number }> {
  const actor = await system.access.authenticate(system.actors.author.bearer, {
    pool: db.pool,
    deadline: Date.now() + 30_000,
  });
  const events: CloudEvent[] = [];
  let attempts = 0;
  let sourcePartition = requiredPartition;
  while (events.length < runsPerScale && attempts < 4096) {
    attempts++;
    const outcome = await createReport(
      { pool: db.pool, access: system.access, routeKey: system.routeKey },
      actor,
      { target, reason: 'other', evidence: 'Growth report evidence' },
      { idempotencyKey: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 30_000 },
    );
    const reportId = outcome.value.reportId;
    const reportPartition = partitionOf(routeOf(reportId)!);
    if (sourcePartition === undefined) {
      if (reportPartition === partitionOf(routeOf(target.id)!)) continue;
      sourcePartition = reportPartition;
    }
    if (reportPartition !== sourcePartition) continue;
    const partition = reportPartition;
    const consumer = `growth_report_effect_${partition}`;
    let found: CloudEvent | undefined;
    for (let batch = 0; batch < 100 && !found; batch++) {
      const result = await readBatch(db.pool, {
        consumer,
        partition,
        envelopes: 64,
        apply: async (envelopes) => {
          for (const envelope of envelopes)
            for (const event of envelope.events)
              if (event.type === sourceType && event.subject === reportId) found = event;
        },
      });
      if (result.status !== 'read' || result.envelopes === 0) break;
    }
    if (!found) throw new Error(`Kernel event reader did not return report ${reportId}`);
    events.push(found);
  }
  if (events.length !== runsPerScale)
    throw new Error(`Could not create enough reports in partition ${sourcePartition}`);
  return { events, partition: sourcePartition! };
}

test('Report effect projection stays within its bound as source reports and target reverse-index history grow', async () => {
  const eventsByRun = new Map<number, CloudEvent>();
  const appliedReportIds: string[] = [];
  let runOffset = 0;
  let sourcePartition: number | undefined;
  const sourcePopulation = (partition: number): Population => ({
    name: `report-effect-source-${partition}`,
    hotPartition: partition,
    hotShare: 1,
    rows: (place) => growthRows(sourcePopulation(partition), place),
  });
  const reversePopulation = (partition: number): Population => ({
    name: `report-effect-reverse-${partition}`,
    hotPartition: partition,
    hotShare: 0,
    rows: (place) => growthRows(reversePopulation(partition), place),
  });
  const report = await checkGrowth(db, {
    name: 'Report effect projection stays within its bound as source reports and target reverse-index history grow',
    scales,
    repetitions,
    warmups,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(observed, scale, previous) {
      if (sourcePartition === undefined) {
        const created = await createReportEvents(observed);
        sourcePartition = created.partition;
        created.events.forEach((event) => eventsByRun.set(runOffset++, event));
      } else {
        const created = await createReportEvents(observed, sourcePartition);
        created.events.forEach((event) => eventsByRun.set(runOffset++, event));
      }
      const amount = scale - previous;
      await seed(observed, sourcePopulation(sourcePartition), { from: growOrdinal, to: growOrdinal + amount });
      const targetPartition = partitionOf(routeOf(target.id)!);
      await seed(observed, reversePopulation(targetPartition), { from: growOrdinal, to: growOrdinal + amount });
      growOrdinal += amount;
    },
    async operation(observed, _scale, repetition) {
      const event = eventsByRun.get(repetition);
      if (!event) throw new Error(`Missing fresh report event ${repetition}`);
      await applyReportEffect(observed.pool, event);
      appliedReportIds.push(event.subject!);
    },
    async warmup(observed, _scale, repetition) {
      const event = eventsByRun.get(repetition);
      if (!event) throw new Error(`Missing warmup report event ${repetition}`);
      await applyReportEffect(observed.pool, event);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  const appliedReportId = appliedReportIds[0]!;
  const reportTime = await db.admin.query<{ created_at: string }>(
    'SELECT created_at::text FROM content.report WHERE route=$1 AND report_id=$2',
    [routeOf(appliedReportId), appliedReportId],
  );
  const projection = await db.admin.query<{ rows: number; events: number; created_at: string }>(
    `SELECT (SELECT count(*)::int FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_route=$4 AND report_id=$5) AS rows,
            (SELECT count(*)::int FROM core.outbox WHERE partition_no=$6 AND type=$7 AND data->>'reportId'=$5) AS events,
            (SELECT created_at::text FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_route=$4 AND report_id=$5) AS created_at`,
    [
      routeOf(target.id),
      target.kind,
      target.id,
      routeOf(appliedReportId),
      appliedReportId,
      partitionOf(routeOf(target.id)!),
      projectedType,
    ],
  );
  expect(projection.rows[0]).toEqual({ rows: 1, events: 1, created_at: reportTime.rows[0]!.created_at });
  for (const sample of report.samples)
    for (const relation of ['content.report', 'content.report_target'])
      expect(sample.cost.relations[relation]?.sequentialScans ?? 0, `${relation} at ${sample.scale}`).toBe(0);
});

test('Report effect replay stays within its bound and changes nothing as history grows', async () => {
  const eventsByRun = new Map<number, CloudEvent>();
  const replayResults: {
    before: { rows: number; events: number; position: string };
    after: { rows: number; events: number; position: string };
  }[] = [];
  let runOffset = 0;
  let sourcePartition: number | undefined;
  let ordinal = 0;
  const report = await checkGrowth(db, {
    name: 'Report effect replay stays within its bound and changes nothing as history grows',
    scales,
    repetitions,
    warmups,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(observed, scale, previous) {
      const created = await createReportEvents(observed, sourcePartition);
      sourcePartition = created.partition;
      for (const event of created.events) {
        await applyReportEffect(observed.pool, event);
        eventsByRun.set(runOffset++, event);
      }
      const amount = scale - previous;
      const population: Population = {
        name: `report-effect-replay-${sourcePartition}`,
        hotPartition: sourcePartition,
        hotShare: 1,
        rows: (place) => growthRows(population, place),
      };
      await seed(observed, population, { from: ordinal, to: ordinal + amount });
      ordinal += amount;
    },
    async operation(observed, _scale, repetition) {
      const event = eventsByRun.get(repetition);
      if (!event) throw new Error(`Missing projected report event ${repetition}`);
      const reportId = event.subject!;
      const targetPartition = partitionOf(routeOf(target.id)!);
      const before = await observed.admin.query<{ rows: number; events: number; position: string }>(
        `SELECT (SELECT count(*)::int FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_route=$4 AND report_id=$5) AS rows,
                (SELECT count(*)::int FROM core.outbox WHERE partition_no=$6 AND type=$7 AND data->>'reportId'=$5) AS events,
                (SELECT position::text FROM core.partition WHERE partition_no=$6) AS position`,
        [routeOf(target.id), target.kind, target.id, routeOf(reportId), reportId, targetPartition, projectedType],
      );
      await applyReportEffect(observed.pool, event);
      const after = await observed.admin.query<{ rows: number; events: number; position: string }>(
        `SELECT (SELECT count(*)::int FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_route=$4 AND report_id=$5) AS rows,
                (SELECT count(*)::int FROM core.outbox WHERE partition_no=$6 AND type=$7 AND data->>'reportId'=$5) AS events,
                (SELECT position::text FROM core.partition WHERE partition_no=$6) AS position`,
        [routeOf(target.id), target.kind, target.id, routeOf(reportId), reportId, targetPartition, projectedType],
      );
      replayResults.push({ before: before.rows[0]!, after: after.rows[0]! });
    },
    async warmup(observed, _scale, repetition) {
      const event = eventsByRun.get(repetition);
      if (!event) throw new Error(`Missing projected warmup event ${repetition}`);
      await applyReportEffect(observed.pool, event);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const result of replayResults) expect(result.after).toEqual(result.before);
  for (const sample of report.samples)
    for (const relation of ['content.report', 'content.report_target'])
      expect(sample.cost.relations[relation]?.sequentialScans ?? 0, `${relation} at ${sample.scale}`).toBe(0);
});
