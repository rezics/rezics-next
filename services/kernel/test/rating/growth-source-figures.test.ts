import { expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { SOURCE_OBSERVATION_READ_MAX_BYTES } from '../../src/rating/source-observation-read.ts';
import { SOURCE_OBSERVATION_MAX_BYTES } from '../../src/rating/source-figures.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, type GrowthDatabase } from '../support/growth.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { createSourceStatisticIsolationFixture } from './source-statistic-isolation-fixture.ts';

// Every selected row has the maximum bin cardinality and fixed provenance byte sizes.
const body = {
  sourceRecordId: '9007199254740991',
  sourceAlias: 'permitted-bangumi',
  scale: { min: 0, max: 10 },
  mean: 10,
  count: 2147483647,
  asOf: '2026-11-01',
  licence: 'L'.repeat(1024),
  attribution: 'A'.repeat(2000),
  figures: {
    schemaVersion: 1,
    distribution: {
      unit: 'ratings',
      completeness: 'complete',
      bins: Array.from({ length: 10 }, (_, i) => ({ score: i + 1, count: i === 9 ? 2147483647 : 0 })),
    },
    rank: { unit: 'subjects', position: 1, population: Number.MAX_SAFE_INTEGER },
  },
};
const path = (id: string) => `/v1/subjects/${id}/source-statistics`;
const observationPath = (id: string) => `${path(id)}/bangumi/observations`;
const historySources: ReadonlyArray<{ alias: string; record: string; home: number }> = (() => {
  const sources: Array<{ alias: string; record: string; home: number }> = [];
  const homes = new Set<number>();
  for (let n = 1; sources.length < 3; n++) {
    const alias = `growth-${n}`;
    const record = String(n);
    const home = partitionOf(tupleRoute(testRouteKey(), alias, record));
    if (homes.has(home)) continue;
    homes.add(home);
    sources.push({ alias, record, home });
  }
  return sources;
})();
let fixture: Awaited<ReturnType<typeof createSourceStatisticIsolationFixture>>;
async function json(response: Response, status = 200): Promise<any> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
// Inspect actual captured physical nodes, including examined/filtered tuples. Merely
// asserting the response length or allowing small sequential scans would miss a lost prefix.
function prefixPlans(value: unknown, seen: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, any>;
  const relation = node['Relation Name'];
  if (
    ['source_statistic', 'source_statistic_head', 'source_statistic_observation'].includes(relation) &&
    /Scan/.test(node['Node Type'] ?? '')
  ) {
    seen.add(relation);
    expect(node['Node Type']).toMatch(/^Index (Only )?Scan$/);
    expect(node['Index Cond']).toContain('route');
    expect(node['Index Cond']).toContain('subject_id');
    if (relation !== 'source_statistic') expect(node['Index Cond']).toContain('source');
    if (relation === 'source_statistic_observation') {
      const index = String(node['Index Name']);
      if (index === 'source_statistic_observation_legacy_order_idx') {
        expect(node['Index Cond']).toContain('source');
      } else {
        expect(node['Index Cond']).toMatch(/digest|local_order/);
      }
    }
    expect((node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']).toBeLessThanOrEqual(2);
  }
  const qualifiedRelation = `${node.Schema}.${node['Relation Name']}`;
  const prefixes: Readonly<Record<string, readonly string[]>> = {
    'access.resource_denial': ['route', 'resource_id', 'subject_id', 'action'],
    'core.partition': ['partition_no'],
    'semantic.revision': ['route', 'subject_id'],
  };
  if (prefixes[qualifiedRelation] && /Scan/.test(node['Node Type'] ?? '')) {
    expect(node['Node Type']).toMatch(/^Index (Only )?Scan$/);
    const condition = String(node['Index Cond']);
    for (const key of prefixes[qualifiedRelation]!) expect(condition).toContain(key);
    const examined = (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'];
    expect(examined).toBeLessThanOrEqual(qualifiedRelation === 'access.resource_denial' ? 1 : 2);
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((entry) => prefixPlans(entry, seen));
    else if (child && typeof child === 'object') prefixPlans(child, seen);
  }
}

async function seedSubjectRevisionHistory(
  db: GrowthDatabase,
  subjectId: string,
  scale: number,
  previous: number,
): Promise<void> {
  const route = routeOf(subjectId);
  if (route === null) throw new Error('Selected Subject has no route');
  const result = await db.admin.query(
    `INSERT INTO semantic.revision
       (route, subject_id, revision, kind, release, recorded_transaction_id, source)
     SELECT $1, $2, n + 1, 'propose', base.release, $2, base.source
     FROM generate_series($3::integer, $4::integer) AS n
     CROSS JOIN semantic.revision AS base
     WHERE base.route = $1 AND base.subject_id = $2 AND base.revision = 1`,
    [route, subjectId, previous + 1, scale],
  );
  expect(result.rowCount).toBe(scale - previous);
}

async function seedClosedWriteAuthority(
  db: GrowthDatabase,
  importerId: string,
  scale: number,
  previous: number,
): Promise<void> {
  const result = await db.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     SELECT $1, $2, $3, '', 'source_statistic:write', 'resource',
            tstzrange('2000-01-01T00:00:00Z'::timestamptz + n * interval '2 days',
                      '2000-01-02T00:00:00Z'::timestamptz + n * interval '2 days', '[)'),
            ('90000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid
     FROM generate_series($4::integer, $5::integer) AS n`,
    [GLOBAL_CONTEXT.route, GLOBAL_CONTEXT.id, importerId, previous + 1, scale],
  );
  expect(result.rowCount).toBe(scale - previous);
}

async function inspectPage(id: string, query: string) {
  const response = await fixture.request('GET', `${observationPath(id)}${query}`, {
    actor: fixture.actors.importer,
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const result = JSON.parse(text);
  const items = [result.head.observation, ...(result.history?.items ?? [])].filter(Boolean);
  const uniqueItems = [...new Map(items.map((item) => [item.digest, item])).values()];
  return {
    result,
    materializedPayloadBytes: uniqueItems.reduce(
      (total, item) => total + Buffer.byteLength(JSON.stringify(item.payload), 'utf8'),
      0,
    ),
    retainedItemBytes: uniqueItems.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0),
    responseBytes: Buffer.byteLength(text, 'utf8'),
  };
}

test('source inspection keeps fixed physical and byte costs as source, Subject revision and authority history grow independently', async () => {
  fixture = await createSourceStatisticIsolationFixture({ withRatingWorker: false, sourceFences: true });
  try {
    await fixture.grantImporter(fixture.actors.importer);
    const selected = await fixture.createSubject();
    const history = await fixture.createSubject();
    const write = (id: string, provider: string, value: unknown, key = crypto.randomUUID()) =>
      fixture.request('PUT', `${path(id)}/${provider}`, { actor: fixture.actors.importer, key, body: value });
    await json(await write(selected, 'bangumi', body));
    let historyHead: string | undefined;
    const dimensions = [
      'unrelated source heads',
      'selected source history',
      'Subject revision history',
      'closed write denials',
    ] as const;
    for (const dimension of dimensions) {
      const name = `source observation under ${dimension}`;
      const report = await checkGrowth(fixture.database, {
        name,
        scales: [256, 1024, 4096],
        repetitions: 2,
        warmups: 1,
        includeBackends: true,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        indexProbes: 128,
        counted: {
          read: (value) => value as Record<string, number>,
          limits: {
            connections: 1,
            pages: 2,
            materializedPayloadBytes: SOURCE_OBSERVATION_MAX_BYTES * 2,
            retainedItemBytes: SOURCE_OBSERVATION_READ_MAX_BYTES,
            pageBytes: SOURCE_OBSERVATION_READ_MAX_BYTES,
            responseBytes: SOURCE_OBSERVATION_READ_MAX_BYTES * 2,
          },
          bounds: {
            connections: 'constant',
            pages: 'constant',
            materializedPayloadBytes: 'constant',
            retainedItemBytes: 'constant',
            pageBytes: 'constant',
            responseBytes: 'constant',
          },
        },
        grow: async (_db, scale, previous) => {
          for (let i = previous; i < scale; i++) {
            if (dimension === 'unrelated source heads') {
              const id = await fixture.createSubject();
              await json(await write(id, 'bangumi', body));
            } else if (dimension === 'selected source history') {
              const source = historySources[i % historySources.length]!;
              const changed = {
                ...body,
                sourceAlias: source.alias,
                sourceRecordId: source.record,
                expectedObservation: historyHead,
                figures: { ...body.figures, rank: { unit: 'subjects', position: i + 1 } },
              };
              historyHead = (await json(await write(history, 'bangumi', changed))).observation.digest;
            }
          }
          if (dimension === 'Subject revision history')
            await seedSubjectRevisionHistory(_db, selected, scale, previous);
          if (dimension === 'closed write denials')
            await seedClosedWriteAuthority(_db, fixture.actors.importer.actor.accountId, scale, previous);
        },
        operation: async (_db, scale) => {
          const inspectionSubject = dimension === 'selected source history' ? history : selected;
          const first = await inspectPage(inspectionSubject, '?history=true');
          expect(first.result.head.state).toBe('published');
          expect(first.result.head.observation.payload.figures).toEqual(
            dimension === 'selected source history'
              ? { ...body.figures, rank: { unit: 'subjects', position: scale } }
              : body.figures,
          );
          expect(first.result.history.items).toHaveLength(1);
          const pages = [first];
          if (dimension === 'selected source history') {
            expect(first.result.history.nextCursor).toBeString();
            const second = await inspectPage(
              inspectionSubject,
              `?cursor=${encodeURIComponent(first.result.history.nextCursor)}`,
            );
            expect(second.result.head.digest).toBe(first.result.head.digest);
            expect(second.result.history.items).toHaveLength(1);
            expect(BigInt(second.result.history.items[0].nativeOrder)).toBeLessThan(
              BigInt(first.result.history.items[0].nativeOrder),
            );
            pages.push(second);
          } else {
            expect(first.result.history.nextCursor).toBeNull();
          }
          return {
            pages: pages.length,
            materializedPayloadBytes: Math.max(
              ...pages.map(({ materializedPayloadBytes }) => materializedPayloadBytes),
            ),
            retainedItemBytes: Math.max(...pages.map(({ retainedItemBytes }) => retainedItemBytes)),
            pageBytes: Math.max(...pages.map(({ responseBytes }) => responseBytes)),
            responseBytes: pages.reduce((total, { responseBytes }) => total + responseBytes, 0),
          };
        },
      });
      const relations = [
        ...new Set(report.samples.flatMap((s) => s.repetitions.flatMap((r) => Object.keys(r.relations)))),
      ];
      expect(relations).toEqual(
        expect.arrayContaining([
          'rating.source_statistic',
          'rating.source_statistic_head',
          'rating.source_statistic_observation',
          'semantic.revision',
          'access.resource_denial',
          'core.partition',
        ]),
      );
      if (dimension === 'Subject revision history') expect(relations).toContain('semantic.revision');
      if (dimension === 'closed write denials') expect(relations).toContain('access.resource_denial');
      assertGrowthAccessPaths(name, report.samples, relations);
      const seen = new Set<string>();
      for (const sample of report.samples)
        for (const run of sample.occurrenceRepetitions)
          for (const statement of run.statements)
            for (const document of statement.planDocuments) prefixPlans(document, seen);
      expect([...seen].sort()).toEqual(['source_statistic', 'source_statistic_head', 'source_statistic_observation']);
      for (const sample of report.samples) {
        expect(sample.backendRepetitions).toHaveLength(2);
        for (const run of sample.backendRepetitions!) expect(new Set(run).size).toBe(1);
        for (const cost of sample.repetitions) {
          expect(cost.statements).toBeGreaterThan(0);
          expect(cost.controlStatements).toBeGreaterThan(0);
          expect(cost.rows).toBeGreaterThan(0);
          expect(cost.sharedHit + cost.sharedRead).toBe(cost.blocks);
          expect(cost.limitations ?? []).toEqual([]);
          expect(cost.failedStatements ?? {}).toEqual({});
          expect(cost.backgroundStatements ?? 0).toBe(0);
        }
      }
    }
  } finally {
    await fixture.close();
  }
}, 1_200_000);
