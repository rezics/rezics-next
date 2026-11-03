import { expect, test } from 'bun:test';
import { SOURCE_OBSERVATION_READ_MAX_BYTES } from '../../src/rating/source-observation-read.ts';
import { SOURCE_STATISTICS_MAX_BODY_BYTES } from '../../src/rating/source-figures.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
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
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((entry) => prefixPlans(entry, seen));
    else if (child && typeof child === 'object') prefixPlans(child, seen);
  }
}

test('fixed source slots and ten-bin bytes retain physical prefixes as native heads and immutable history grow independently', async () => {
  const fixture = await createSourceStatisticIsolationFixture();
  try {
    await fixture.grantImporter(fixture.actors.importer);
    const selected = await fixture.createSubject();
    const history = await fixture.createSubject();
    const empty = await fixture.createSubject();
    const write = (id: string, provider: string, value: unknown, key = crypto.randomUUID()) =>
      fixture.request('PUT', `${path(id)}/${provider}`, { actor: fixture.actors.importer, key, body: value });
    await json(await write(selected, 'bangumi', body));
    await json(await write(selected, 'vndb', { ...body, figures: undefined }));
    let historyHead: string | undefined;
    let historyFigures: unknown = body.figures;
    for (const dimension of ['heads', 'history']) {
      const name = `source figures fixed bins independent ${dimension}`;
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
          read: (value) => ({
            bodyBytes: (value as { bodyBytes: number }).bodyBytes,
            inspectionBytes: (value as { inspectionBytes: number }).inspectionBytes,
          }),
          limits: {
            bodyBytes: SOURCE_STATISTICS_MAX_BODY_BYTES,
            inspectionBytes: SOURCE_OBSERVATION_READ_MAX_BYTES * 2,
          },
          bounds: { bodyBytes: 'constant', inspectionBytes: 'constant' },
        },
        grow: async (_db, scale, previous) => {
          for (let i = previous; i < scale; i++) {
            if (dimension === 'heads') {
              const id = await fixture.createSubject();
              await json(await write(id, 'bangumi', body));
              await json(await write(id, 'vndb', { ...body, figures: undefined }));
            } else {
              const changed = {
                ...body,
                expectedObservation: historyHead,
                figures: { ...body.figures, rank: { unit: 'subjects', position: i + 1 } },
              };
              historyHead = (await json(await write(history, 'bangumi', changed))).observation.digest;
              historyFigures = changed.figures;
            }
          }
        },
        operation: async () => {
          const key = crypto.randomUUID();
          const current = await json(await write(selected, 'bangumi', body, key));
          expect(await json(await write(selected, 'bangumi', body, key))).toEqual(current);
          await json(await write(selected, 'bangumi', { ...body, asOf: '2026-10-31' }), 409);
          expect(await json(await fixture.request('GET', path(empty), { actor: null }))).toEqual([]);
          await json(
            await fixture.request('PUT', `${path(selected)}/bangumi`, {
              actor: fixture.actors.author,
              body,
              key: crypto.randomUUID(),
            }),
            403,
          );
          const response = await fixture.request('GET', path(selected), { actor: null });
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(JSON.parse(text)).toHaveLength(2);
          expect(JSON.parse(text)[0].figures).toEqual(body.figures);
          const inspectionSubject = dimension === 'history' ? history : selected;
          const expectedFigures = dimension === 'history' ? historyFigures : body.figures;
          const inspectionResponse = await fixture.request(
            'GET',
            observationPath(inspectionSubject) + '?history=true',
            {
              actor: fixture.actors.importer,
            },
          );
          expect(inspectionResponse.status).toBe(200);
          const inspectionText = await inspectionResponse.text();
          const inspection = JSON.parse(inspectionText);
          expect(inspection.head.state).toBe('published');
          expect(inspection.head.observation.payload.figures).toEqual(expectedFigures);
          expect(inspection.history.items).toHaveLength(1);
          let inspectionBytes = Buffer.byteLength(inspectionText, 'utf8');
          if (dimension === 'history') {
            const nextCursor = inspection.history.nextCursor;
            expect(nextCursor).toBeString();
            const nextResponse = await fixture.request(
              'GET',
              `${observationPath(inspectionSubject)}?cursor=${encodeURIComponent(nextCursor)}`,
              { actor: fixture.actors.importer },
            );
            expect(nextResponse.status).toBe(200);
            const nextText = await nextResponse.text();
            const next = JSON.parse(nextText);
            expect(next.history.items).toHaveLength(1);
            expect(BigInt(next.history.items[0].nativeOrder)).toBeLessThan(
              BigInt(inspection.history.items[0].nativeOrder),
            );
            inspectionBytes += Buffer.byteLength(nextText, 'utf8');
          }
          return {
            bodyBytes: Buffer.byteLength(text, 'utf8'),
            inspectionBytes,
          };
        },
      });
      const relations = [
        ...new Set(report.samples.flatMap((s) => s.repetitions.flatMap((r) => Object.keys(r.relations)))),
      ];
      assertGrowthAccessPaths(name, report.samples, relations);
      const seen = new Set<string>();
      for (const sample of report.samples)
        for (const run of sample.occurrenceRepetitions)
          for (const statement of run.statements)
            for (const document of statement.planDocuments) prefixPlans(document, seen);
      expect([...seen].sort()).toEqual(['source_statistic', 'source_statistic_head', 'source_statistic_observation']);
    }
  } finally {
    await fixture.close();
  }
}, 1_200_000);
