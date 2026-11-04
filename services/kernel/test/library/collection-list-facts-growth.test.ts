import { expect, test } from 'bun:test';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { fullMembers } from '../../src/library/views.ts';
import { testTokens } from '../support/test-kernel.ts';
import { assertGrowthAccessPaths, checkGrowth, seed } from '../support/growth.ts';
import {
  createCollectionListFactsFixture,
  collectionListFactsPopulation,
} from './support/collection-list-facts-fixture.ts';

test('FULL native fixed Collection page bounds all helpers, fences, failures and bytes at 64/512/4096 unrelated facts and history', async () => {
  const f = await createCollectionListFactsFixture();
  try {
    const book = await f.create('schema:Book', { 'schema:wordCount': { amount: '+123', unit: '1' } });
    const author = await f.create('schema:Person', {}, { en: 'Hidden growth author' });
    const related = await f.create('schema:Book', { 'schema:author': author });
    const hidden = await f.create('schema:Book', { 'schema:wordCount': { amount: '+999', unit: '1' } });
    const sparse = await f.create('schema:Book');
    const imported = await f.imported('schema:wordCount', { amount: '+99', unit: '1' });
    const collection = await f.collection([book, related, hidden, sparse, imported.id, book]);
    await f.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'planned' }, 'editor');
    await f.hide(author);
    await f.hide(hidden);
    await f.checked('POST', '/v1/sourceFences:takedown', {
      source: imported.source.source,
      externalId: imported.source.external_id,
      fieldGroup: 'facts',
      reason: 'Collection growth source withdrawal',
    });
    const a = await f.create('schema:Book');
    const b = await f.create('schema:Book');
    const redirected = await f.collection([a, b]);
    await f.checked('POST', '/v1/subjects:merge', { subjects: [a, b] });
    const population = collectionListFactsPopulation(f, book);
    const report = await checkGrowth(f.db, {
      name: 'FULL Collection native facts with all actual helpers and current source guards',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      counted: { read: () => ({}), limits: { connections: 1 }, bounds: { connections: 'constant' } },
      async grow(db, scale, previous) {
        await seed(db, population, { from: previous, to: scale });
      },
      async operation(_db, _scale, repetition) {
        const response = await f.get(collection.id, 'FULL', null);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const result = await response.json();
        expect(result.members.map((m: { subjectId: string }) => m.subjectId)).toEqual([
          book,
          related,
          sparse,
          imported.id,
          book,
        ]);
        expect(result.members[0].facts).toEqual({ 'schema:wordCount': [{ kind: 'quantity', amount: 123, unit: '1' }] });
        for (const index of [1, 2, 3]) expect(result.members[index].facts).toEqual({});
        expect(JSON.stringify(result)).not.toContain('Hidden growth author');
        const admitted = await f.get(collection.id, 'FULL');
        expect(admitted.status).toBe(200);
        const admittedPage = await admitted.json();
        expect(admittedPage.members).toHaveLength(5);
        expect(admittedPage.viewerFacts.rows).toHaveLength(5);
        expect(admittedPage.viewerFacts.rows.map((row: { rowKey: string }) => row.rowKey)).toEqual(
          admittedPage.members.map((member: { id: string }) => member.id),
        );
        expect((await f.get(redirected.id, 'FULL', null)).status).toBe(503);
        // Private Library changes cannot alter public Type facts. Their native work is included in this capture.
        const privateEntry = await f.call('GET', `/v1/libraryEntries/${book}`);
        expect([200, 404]).toContain(privateEntry.status);
        await f.checked('PUT', `/v1/libraryEntries/${book}`, {
          state: repetition % 2 ? 'planned' : 'in_progress',
          ...(privateEntry.status === 200 ? { revision: privateEntry.body.libraryEntry.revision } : {}),
        });
        const deps = await f.deps('editor');
        let reads = 0;
        const access = deriveAccess(deps.access, {
          async prepare(actor, action, resource, context) {
            if (action === 'collection:read' && resource.id === collection.id && ++reads === 2) {
              const current = await f.checked('GET', `/v1/collections/${collection.id}`);
              await f.checked('PATCH', `/v1/collections/${collection.id}`, {
                revision: current.collection.revision,
                title: `Native bounded source change ${repetition % 2}`,
              });
            }
            return deps.access.prepare!(actor, action, resource, context);
          },
        });
        await expect(
          fullMembers({ ...deps, access, tokens: testTokens() }, deps.actor, collection.id, {}, deps.deadline),
        ).rejects.toMatchObject({ code: 'semantic_not_ready' });
        expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
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
    console.info(`GROWTH_SAMPLES ${JSON.stringify(report)}`);
  } finally {
    await f.close();
  }
}, 600_000);
