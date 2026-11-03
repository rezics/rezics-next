import { expect, test } from 'bun:test';
import { SOURCE_STATISTICS_MAX_BODY_BYTES } from '../../src/rating/source-figures.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { createSourceStatisticIsolationFixture } from './source-statistic-isolation-fixture.ts';

// Every selected row has the maximum bin cardinality and fixed provenance byte sizes.
const body = {
  sourceRecordId: '9007199254740991', sourceAlias: 'permitted-bangumi', scale: { min: 0, max: 10 },
  mean: 10, count: 2147483647, asOf: '2026-11-01', licence: 'L'.repeat(1024), attribution: 'A'.repeat(2000),
  figures: { schemaVersion: 1, distribution: { unit: 'ratings', completeness: 'complete',
    bins: Array.from({ length: 10 }, (_, i) => ({ score: i + 1, count: i === 9 ? 2147483647 : 0 })) },
    rank: { unit: 'subjects', position: 1, population: Number.MAX_SAFE_INTEGER } },
};
const path = (id: string) => `/v1/subjects/${id}/source-statistics`;
async function json(response: Response, status = 200): Promise<any> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
// Inspect actual captured physical nodes, including examined/filtered tuples. Merely
// asserting the response length or allowing small sequential scans would miss a lost prefix.
function prefixPlans(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, any>;
  const relation = node['Relation Name'];
  if (['source_statistic', 'source_statistic_head', 'source_statistic_observation'].includes(relation) &&
      /Scan/.test(node['Node Type'] ?? '')) {
    expect(node['Node Type']).toMatch(/^Index (Only )?Scan$/);
    expect(node['Index Cond']).toContain('route');
    expect(node['Index Cond']).toContain('subject_id');
    if (relation !== 'source_statistic') expect(node['Index Cond']).toContain('source');
    if (relation === 'source_statistic_observation') expect(node['Index Cond']).toContain('digest');
    expect((node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']).toBeLessThanOrEqual(2);
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(prefixPlans);
    else if (child && typeof child === 'object') prefixPlans(child);
  }
}

test('fixed source slots and ten-bin bytes retain physical prefixes as native heads and immutable history grow independently', async () => {
  const fixture = await createSourceStatisticIsolationFixture();
  try {
    await fixture.grantImporter(fixture.actors.importer);
    const selected = await fixture.createSubject();
    const history = await fixture.createSubject();
    const write = (id: string, provider: string, value: unknown, key = crypto.randomUUID()) =>
      fixture.request('PUT', `${path(id)}/${provider}`, { actor: fixture.actors.importer, key, body: value });
    await json(await write(selected, 'bangumi', body));
    await json(await write(selected, 'vndb', { ...body, figures: undefined }));
    let historyHead: string | undefined;
    for (const dimension of ['heads', 'history']) {
      const name = `source figures fixed bins independent ${dimension}`;
      const report = await checkGrowth(fixture.database, {
        name, scales: [256, 1024, 4096], repetitions: 2, warmups: 1, includeBackends: true,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' }, indexProbes: 128,
        counted: { read: (value) => ({ bodyBytes: (value as { bodyBytes: number }).bodyBytes }),
          limits: { bodyBytes: SOURCE_STATISTICS_MAX_BODY_BYTES }, bounds: { bodyBytes: 'constant' } },
        grow: async (_db, scale, previous) => {
          for (let i = previous; i < scale; i++) {
            if (dimension === 'heads') {
              const id = await fixture.createSubject();
              await json(await write(id, 'bangumi', body));
              await json(await write(id, 'vndb', { ...body, figures: undefined }));
            } else {
              const changed = { ...body, expectedObservation: historyHead,
                figures: { ...body.figures, rank: { unit: 'subjects', position: i + 1 } } };
              historyHead = (await json(await write(history, 'bangumi', changed))).observation.digest;
            }
          }
        },
        operation: async () => {
          const key = crypto.randomUUID();
          const current = await json(await write(selected, 'bangumi', body, key));
          expect(await json(await write(selected, 'bangumi', body, key))).toEqual(current);
          await json(await write(selected, 'bangumi', { ...body, asOf: '2026-10-31' }), 409);
          const response = await fixture.request('GET', path(selected), { actor: null });
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(JSON.parse(text)).toHaveLength(2);
          expect(JSON.parse(text)[0].figures).toEqual(body.figures);
          return { bodyBytes: Buffer.byteLength(text, 'utf8') };
        },
      });
      const relations = [...new Set(report.samples.flatMap((s) => s.repetitions.flatMap((r) => Object.keys(r.relations))))];
      assertGrowthAccessPaths(name, report.samples, relations);
      let plans = 0;
      for (const sample of report.samples) for (const run of sample.occurrenceRepetitions)
        for (const statement of run.statements) for (const document of statement.planDocuments) { prefixPlans(document); plans++; }
      expect(plans).toBeGreaterThan(0);
    }
  } finally { await fixture.close(); }
}, 1_200_000);
