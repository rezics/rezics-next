import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { normalizeCommandKey, principalCommandIdentity } from '../../src/command/command.ts';
import { createReport, type ReportTarget } from '../../src/content/reports.ts';
import { applyReportEffect } from '../../src/content/report-effect.ts';
import { readBatch, type CloudEvent } from '../../src/events/log.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
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
let authorActor: AccountActor;

beforeAll(async () => {
  system = await createNativeContentSystem({ databaseUrl });
  db = await openGrowthDatabase(system.database.pool.options.connectionString);
  await bootstrapRelease(system.database.pool, bundledRelease);
  const authenticatedAuthor = await system.access.authenticate(system.actors.author.bearer, {
    pool: db.pool,
    deadline: Date.now() + 600_000,
  });
  if (authenticatedAuthor.kind !== 'account') throw new Error('Fixture credential must authenticate an account');
  authorActor = authenticatedAuthor;
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
          'idempotency-key': JSON.stringify(randomUUID()),
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

function growthRows(reportRoute: number, reverse: boolean) {
  const targetRoute = routeOf(target.id)!;
  const reportId = newId(reportRoute);
  const createdAt = new Date('2026-10-27T00:00:00.000Z');
  return {
    'content.report': [
      {
        route: reportRoute,
        report_id: reportId,
        target_kind: target.kind,
        target_id: target.id,
        revision_id: null,
        reason: 'spam',
        evidence: null,
        reporter_account_id: null,
        created_at: createdAt,
        recorded_transaction_id: randomUUID(),
      },
    ],
    ...(reverse
      ? {
          'content.report_target': [
            {
              route: targetRoute,
              target_kind: target.kind,
              target_id: target.id,
              report_route: reportRoute,
              report_id: reportId,
              created_at: createdAt,
            },
          ],
        }
      : {}),
  };
}

function reportPopulation(sourceRoute: number, reverse = false): Population {
  const sourcePartition = partitionOf(sourceRoute);
  const targetPartition = partitionOf(routeOf(target.id)!);
  let reversePartition = (targetPartition + 1) % 4096;
  if (reversePartition === sourcePartition) reversePartition = (reversePartition + 1) % 4096;
  return {
    name: `report-effect-${sourceRoute}-${reverse ? 'reverse' : 'source'}`,
    hotPartition: reverse ? targetPartition : sourcePartition,
    hotShare: reverse ? 0 : 1,
    rows: (place) => growthRows(reverse ? reversePartition * 16 + (place.ordinal % 16) : sourceRoute, reverse),
  };
}

async function createReportEvents(
  db: GrowthDatabase,
  requiredRoute?: number,
): Promise<{ events: CloudEvent[]; route: number }> {
  const events: CloudEvent[] = [];
  const keys: string[] = [];
  const { principal } = principalCommandIdentity(authorActor);
  const targetPartition = partitionOf(routeOf(target.id)!);
  let sourceRoute = requiredRoute;
  // Route candidates locally; only the fixed number of retained keys issue commands.
  // Keeping one route also puts all N source rows in each measured report's key range.
  while (keys.length < runsPerScale) {
    const key = randomUUID();
    const name = JSON.stringify([
      principal.kind,
      principal.id,
      'content.report.create',
      normalizeCommandKey(principal, key),
    ]);
    const route = anchorRoute(system.routeKey, name);
    if (sourceRoute === undefined) {
      if (partitionOf(route) === targetPartition) continue;
      sourceRoute = route;
    }
    if (route === sourceRoute) keys.push(key);
  }
  if (sourceRoute === undefined) throw new Error('No report source route selected');
  const sourcePartition = partitionOf(sourceRoute);
  for (const key of keys) {
    const outcome = await createReport(
      { pool: db.pool, access: system.access, routeKey: system.routeKey },
      authorActor,
      { target, reason: 'other', evidence: 'Growth report evidence' },
      { idempotencyKey: key, requestId: randomUUID(), deadline: Date.now() + 30_000 },
    );
    const reportId = outcome.value.reportId;
    const reportPartition = partitionOf(routeOf(reportId)!);
    expect(reportPartition).toBe(sourcePartition);
    expect(routeOf(reportId)).toBe(sourceRoute);
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
  return { events, route: sourceRoute };
}

test('Report effect projection stays within its bound as source reports and target reverse-index history grow', async () => {
  const eventsByRun = new Map<number, CloudEvent>();
  const appliedReportIds: string[] = [];
  let runOffset = 0;
  let sourceRoute: number | undefined;
  const report = await checkGrowth(db, {
    name: 'Report effect projection stays within its bound as source reports and target reverse-index history grow',
    scales,
    repetitions,
    warmups,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(observed, scale, previous) {
      const created = await createReportEvents(observed, sourceRoute);
      sourceRoute = created.route;
      created.events.forEach((event) => eventsByRun.set(runOffset++, event));
      await seed(observed, reportPopulation(sourceRoute), { from: previous, to: scale });
      await seed(observed, reportPopulation(sourceRoute, true), { from: previous, to: scale });
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
  assertGrowthAccessPaths(
    'Report effect projection stays within its bound as source reports and target reverse-index history grow',
    report.samples,
    ['content.report', 'content.report_target'],
  );
  const appliedReportId = appliedReportIds[0]!;
  const reportTime = await db.admin.query<{ created_at: string }>(
    'SELECT created_at::text FROM content.report WHERE route=$1 AND report_id=$2',
    [routeOf(appliedReportId), appliedReportId],
  );
  const projection = await db.admin.query<{ rows: number; events: number; created_at: string }>(
    `SELECT (SELECT count(*)::int FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_route=$4 AND report_id=$5) AS rows,
            (SELECT count(*)::int FROM core.outbox WHERE partition_no=$6 AND type=$7 AND data->>'reportId'=$5::text) AS events,
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
});

test('Report effect replay stays within its bound and changes nothing as history grows', async () => {
  const eventsByRun = new Map<number, CloudEvent>();
  const replayResults: {
    before: { rows: number; events: number; position: string };
    after: { rows: number; events: number; position: string };
  }[] = [];
  let runOffset = 0;
  let sourceRoute: number | undefined;
  const report = await checkGrowth(db, {
    name: 'Report effect replay stays within its bound and changes nothing as history grows',
    scales,
    repetitions,
    warmups,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(observed, scale, previous) {
      const created = await createReportEvents(observed, sourceRoute);
      sourceRoute = created.route;
      for (const event of created.events) {
        await applyReportEffect(observed.pool, event);
        eventsByRun.set(runOffset++, event);
      }
      await seed(observed, reportPopulation(sourceRoute), { from: previous, to: scale });
      await seed(observed, reportPopulation(sourceRoute, true), { from: previous, to: scale });
    },
    async operation(observed, _scale, repetition) {
      const event = eventsByRun.get(repetition);
      if (!event) throw new Error(`Missing projected report event ${repetition}`);
      const reportId = event.subject!;
      const targetPartition = partitionOf(routeOf(target.id)!);
      const before = await observed.admin.query<{ rows: number; events: number; position: string }>(
        `SELECT (SELECT count(*)::int FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_route=$4 AND report_id=$5) AS rows,
                (SELECT count(*)::int FROM core.outbox WHERE partition_no=$6 AND type=$7 AND data->>'reportId'=$5::text) AS events,
                (SELECT position::text FROM core.partition WHERE partition_no=$6) AS position`,
        [routeOf(target.id), target.kind, target.id, routeOf(reportId), reportId, targetPartition, projectedType],
      );
      await applyReportEffect(observed.pool, event);
      const after = await observed.admin.query<{ rows: number; events: number; position: string }>(
        `SELECT (SELECT count(*)::int FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_route=$4 AND report_id=$5) AS rows,
                (SELECT count(*)::int FROM core.outbox WHERE partition_no=$6 AND type=$7 AND data->>'reportId'=$5::text) AS events,
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
  assertGrowthAccessPaths(
    'Report effect replay stays within its bound and changes nothing as history grows',
    report.samples,
    ['content.report', 'content.report_target'],
  );
  for (const result of replayResults) {
    expect(result.before.rows).toBe(1);
    expect(result.before.events).toBe(1);
    expect(result.after).toEqual(result.before);
  }
});
