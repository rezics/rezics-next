import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, seed, type Population } from '../support/growth.ts';
import { createCollectionListFactsFixture } from './support/collection-list-facts-fixture.ts';

test('FULL shelf viewer overlay and final page reread stay bounded as same-owner entries grow', async () => {
  const fixture = await createCollectionListFactsFixture();
  try {
    const book = await fixture.create('schema:Book', { 'schema:wordCount': { amount: '+123', unit: '1' } });
    await fixture.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'planned' }, 'editor');
    const editor = await fixture.deps('editor');
    const token = await fixture.credential(editor.actor.scopes);
    const ownerRoute = routeOf(fixture.accounts.editor)!;
    const population: Population = {
      name: 'unrelated-same-owner-shelf-entries',
      hotPartition: partitionOf(ownerRoute),
      hotShare: 1,
      rows({ ordinal }) {
        const subjectId = newId(ownerRoute);
        const created = new Date(Date.UTC(2000, 0, 1) + ordinal * 1000).toISOString();
        return {
          'library.entry': [
            {
              route: ownerRoute,
              account_id: fixture.accounts.editor,
              subject_id: subjectId,
              state: 'planned',
              revision: 1,
              created_at: created,
              updated_at: created,
              transaction_id: randomUUID(),
              incarnation_id: randomUUID(),
            },
          ],
        };
      },
    };
    const path = '/v1/libraryEntries?view=FULL&orderBy=createdAt&direction=desc&limit=1';
    const report = await checkGrowth(fixture.db, {
      name: 'FULL shelf viewer overlay and final page reread',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      counted: { read: () => ({}), limits: { connections: 1 }, bounds: { connections: 'constant' } },
      async grow(db, scale, previous) {
        await seed(db, population, { from: previous, to: scale });
      },
      async operation() {
        const response = await fixture.kernel.handle(
          new Request(`http://kernel.test${path}`, { headers: { authorization: `Bearer ${token}` } }),
        );
        expect(response.status).toBe(200);
        const page = (await response.json()) as {
          libraryEntries: Array<{ subjectId: string }>;
          viewerFacts: { state: string; rows?: unknown[] };
        };
        expect(page.libraryEntries).toMatchObject([{ subjectId: book }]);
        expect(page.viewerFacts.state).toBe('current');
        expect(page.viewerFacts.rows).toHaveLength(1);
        expect(fixture.maximumHeldBackends()).toBeLessThanOrEqual(1);
        return {};
      },
    });
    const relations = [
      ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((cost) => Object.keys(cost.relations)))),
    ];
    assertGrowthAccessPaths(report.name, report.samples, relations);
    for (const sample of report.samples) {
      expect(sample.cost.plans).toBeGreaterThan(0);
      for (const backends of sample.backendRepetitions) expect(new Set(backends).size).toBeLessThanOrEqual(1);
    }
  } finally {
    await fixture.close();
  }
}, 600_000);
