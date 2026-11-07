import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { installSemanticCopyWork } from '../../src/composition/semantic-copy-work.ts';
import { createFacetPopulationSource } from '../../src/semantic/facet-population.ts';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import { anchorRoute, partitionOf, routeOf } from '../../src/route/route.ts';
import type { FacetPopulationRequest } from '../../src/semantic/facet-population-contract.ts';
import {
  fixture,
  nativeProducer,
  consumerFixture,
  capturedConsumer,
  complete,
  readContext,
  statement,
} from './support/public-filter-source.ts';

const plan = { filterDocument: undefined, text: undefined, sort: 'id' as const, size: 20 };
function keyAt(f: Awaited<ReturnType<typeof fixture>>, accept: (route: number) => boolean) {
  for (;;) {
    const key = randomUUID();
    const route = anchorRoute(f.config.routeKey, `${f.accounts.editor}\nsubject.create\n${key}`);
    if (accept(route)) return key;
  }
}

// Native owner configuration, capture and Source factories only. Provisional producer adapters must fail this case.
test('registered finite native population enumerates every anchored subject across its creation change bridge without truncating Source values or faking completeness', async () => {
  installSemanticCopyWork();
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  let consumer: Awaited<ReturnType<typeof consumerFixture>> | undefined;
  try {
    const authors: string[] = [];
    for (let index = 0; index < 23; index++)
      authors.push(
        await f.create(
          'schema:Person',
          {},
          keyAt(f, (route) => route > 0 && route < 16),
        ),
      );
    const book = await f.create('schema:Book', {
      'schema:author': authors.map((id) => statement('schema:author', id)),
    });
    const source = publicFilterSource(f.config);
    consumer = await consumerFixture(f, source);
    const captured = await capturedConsumer(f, consumer, plan, 'prepared');
    const joined = await createPublicFilterSourceBinding(f.config.pool, f.config.routeKey, f.config.access).join(
      { queried: captured.queried },
      readContext(),
    );
    expect(joined.status).toBe('joined');
    if (joined.status !== 'joined') throw new Error(`Native population binding ${joined.status}`);
    let request: FacetPopulationRequest = {
      population: joined.definition.readDefinition,
      frontier: null,
      inputLimit: 1,
      capture: { kind: 'population', queried: captured.queried, start: null, context: readContext() },
    };
    const found = new Set<string>();
    let inserted: string | undefined;
    let observation: string | undefined;
    let finished = false;
    // Recreate the factory every page: retained progress cannot live only in a JS object.
    for (let step = 0; step < 20000; step++) {
      const page = await createFacetPopulationSource(f.config).readFacetPopulationPage({
        ...request,
        capture: { ...request.capture, context: readContext() },
      });
      expect(['progress', 'complete']).toContain(page.status);
      if (page.status !== 'progress' && page.status !== 'complete') throw new Error(`Native population ${page.status}`);
      expect(page.cost.inputKeys).toBeLessThanOrEqual(request.inputLimit);
      expect(page.cost.frontierWrites).toBeLessThanOrEqual(1);
      expect(page.frontier).not.toBe(request.frontier);
      observation ??= page.observation;
      expect(page.observation).toBe(observation);
      for (const row of page.subjects) {
        expect(row.partition).toBe(partitionOf(routeOf(row.subject)!));
        found.add(row.subject);
      }
      if (!inserted && authors.some((id) => found.has(id))) {
        expect(page.status).toBe('progress');
        // Route zero sorts before every authored key already visited in home zero.
        inserted = await f.create(
          'schema:Person',
          {},
          keyAt(f, (route) => route === 0),
        );
      }
      if (page.status === 'complete') {
        finished = true;
        break;
      }
      request = { ...request, frontier: page.frontier };
    }
    expect(finished, 'Finite quiescent native population must exhaust, including genuinely empty homes').toBe(true);
    expect(inserted).toBeString();
    for (const id of [...authors, book, inserted!]) expect(found.has(id), `Missing anchored subject ${id}`).toBe(true);
    // Population is identities only. The consumer must independently exhaust complete Source projection.
    const projection = await complete(f, source, book);
    expect(
      projection.records
        .filter((row) => row.statement.property.id === 'schema:author')
        .map((row) => (row.statement.value.type === 'value' ? row.statement.value.content : null))
        .sort(),
    ).toEqual(authors.sort());
  } finally {
    await consumer?.close();
    await f.close();
  }
});

test('native rejected and empty homes advance while an unavailable owner never falsely completes', async () => {
  installSemanticCopyWork();
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  let consumer: Awaited<ReturnType<typeof consumerFixture>> | undefined;
  try {
    const hidden = await f.create(
      'schema:Book',
      {},
      keyAt(f, (route) => route < 16),
    );
    await f.post(`/v1/subjects/${hidden}:hide`, { reason: 'Population excluded input' });
    const source = publicFilterSource(f.config);
    consumer = await consumerFixture(f, source);
    const captured = await capturedConsumer(f, consumer, plan);
    const binding = await createPublicFilterSourceBinding(f.config.pool, f.config.routeKey, f.config.access).join(
      { queried: captured.queried },
      readContext(),
    );
    if (binding.status !== 'joined') throw new Error(`Native population binding ${binding.status}`);
    const request: FacetPopulationRequest = {
      population: binding.definition.readDefinition,
      frontier: null,
      inputLimit: 16,
      capture: { kind: 'population', queried: captured.queried, start: null, context: readContext() },
    };
    const first = await createFacetPopulationSource(f.config).readFacetPopulationPage(request);
    expect(first.status).toBe('progress');
    if (first.status !== 'progress') throw new Error('An empty/rejected first home is not full population exhaustion');
    expect(first.subjects.some((row) => row.subject === hidden)).toBe(false);
    // Infrastructure ownership change, not an invented Access grant or Source completion flag.
    const previous = await f.db.admin.query('SELECT write_state, moved_to FROM core.partition WHERE partition_no = 1');
    await f.db.admin.query(
      "UPDATE core.partition SET write_state = 'moved', moved_to = 'population-test-destination' WHERE partition_no = 1",
    );
    try {
      const blocked = await createFacetPopulationSource(f.config).readFacetPopulationPage({
        ...request,
        frontier: first.frontier,
      });
      expect(['unavailable', 'unready', 'changed']).toContain(blocked.status);
    } finally {
      await f.db.admin.query('UPDATE core.partition SET write_state = $1, moved_to = $2 WHERE partition_no = 1', [
        previous.rows[0].write_state,
      ]);
    }
  } finally {
    await consumer?.close();
    await f.close();
  }
});
