import { expect, test } from 'bun:test';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import { fixture, nativeProducer, readContext } from './support/public-filter-source.ts';

test('native public Source configuration and immutable meaning/read definition resolve without trusting caller identity', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = { sort: 'id' as const, size: 10, filterDocument: undefined, text: undefined };
    const result = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error(`Native Source binding ${result.reason}`);
    expect(result.definition.source.epoch).toBeGreaterThan(0);
    expect(result.definition.source.configuration.length).toBeGreaterThan(0);
    expect(result.definition.readDefinition.length).toBeGreaterThan(0);
    expect(result.definition.dependencyKeys).toContainEqual({ kind: 'field', field: 'id' });
    capture.size = 20;
    expect(result.definition.capture.size).toBe(10);
    expect(
      (await binding.resolve({ source: { ...source }, meaning: f.meaning, capture }, readContext())).status,
    ).not.toBe('resolved');
    expect(
      (await binding.resolve({ source, meaning: { ...f.meaning, digest: 'invented' }, capture }, readContext())).status,
    ).not.toBe('resolved');
    const foreign = createPublicFilterSourceBinding(f.db.pool, new Uint8Array(32).fill(12), f.config.access);
    expect((await foreign.resolve({ source, meaning: f.meaning, capture }, readContext())).status).not.toBe('resolved');
  } finally {
    await f.close();
  }
});

test('canonical retained observation execution joins preserve complete compiler keys', async () => {
  const { createPublicFilterCustody } = await import('../../src/search/public-filter-custody.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { parseText } = await import('../../src/search/text.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const index = `source-binding-${crypto.randomUUID()}`;
  const custody = createPublicFilterCustody(f.db.pool);
  let created = false;
  try {
    const person = await f.create();
    const book = await f.create('schema:Book');
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = {
      sort: 'name' as const,
      size: 10,
      filterDocument: {
        not: {
          statement: { property: 'schema:author', in: [person], qualifiers: [{ property: 'ex:left', in: [person] }] },
        },
      },
      text: parseText('native -excluded'),
    };
    const resolved = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    for (const key of [
      { kind: 'property', property: 'schema:author' },
      { kind: 'property', property: 'ex:left' },
      { kind: 'order', order: 'name' },
      { kind: 'field', field: 'id' },
      { kind: 'field', field: 'descriptions' },
    ] as const)
      expect(resolved.definition.dependencyKeys).toContainEqual(key);
    await search.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
    created = true;
    const registered = await custody.register(
      { definition: resolved.definition, physicalTarget: index, consumerGeneration: '1', projectionGeneration: '1' },
      search,
      readContext(),
    );
    expect(registered.status).toBe('registered');
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const begun = await binding.begin(
      { source, meaning: f.meaning, capture, consumer: registered.consumer, snapshot: 'prepared' },
      readContext(),
    );
    expect(begun.status).toBe('begun');
    if (begun.status !== 'begun') throw new Error(begun.reason);
    const retained = await custody.retainPrepared(
      {
        registration: registered.registration,
        covered: begun.bootstrap.covered,
        build: crypto.randomUUID(),
        generation: 1n,
        rows: [{ original: book, terminal: book }],
        expiresAt: Date.now() + 60000,
      },
      readContext(),
    );
    expect(retained.status).toBe('retained');
    if (retained.status !== 'retained') throw new Error(retained.reason);
    const adopted = await binding.adopt({ bootstrap: begun.bootstrap.id, queried: retained.queried }, readContext());
    expect(adopted.status).toBe('adopted');
    const acquired = await custody.acquire(retained.queried, readContext());
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error(acquired.reason);
    try {
      for (const ownRows of [[{ original: book, terminal: book }], []]) {
        const execution = { id: crypto.randomUUID(), start: begun.bootstrap.covered, ownRows };
        expect((await custody.appendExecution({ use: acquired.use, execution }, readContext())).status).toBe(
          'appended',
        );
        const joined = await binding.join({ queried: retained.queried, execution: execution.id }, readContext());
        expect(joined.status).toBe('joined');
        if (joined.status !== 'joined') throw new Error(joined.reason);
        expect(joined.execution).toEqual(execution);
        expect(joined.definition).toEqual(resolved.definition);
        expect(joined.covered).toEqual(begun.bootstrap.covered);
      }
    } finally {
      await custody.release(acquired.use, readContext());
    }
    const diagnostic = await binding.join({ queried: retained.queried }, readContext());
    expect(diagnostic.status === 'joined' && diagnostic.execution).toBeNull();
    expect(
      await binding.join({ queried: retained.queried, execution: crypto.randomUUID() }, readContext()),
    ).toMatchObject({ reason: 'execution_missing' });
    const recovered = await createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access).recover(
      { bootstrap: begun.bootstrap.id },
      readContext(),
    );
    expect(recovered.status).toBe('adopted');
    // Closing Search custody invalidates this immutable observation without borrowing another cut.
    await custody.closeObservation(retained.queried, search, readContext());
    expect((await binding.join({ queried: retained.queried }, readContext())).status).not.toBe('joined');
    expect(await binding.abort({ bootstrap: begun.bootstrap.id }, readContext())).toMatchObject({ status: 'pending' });
  } finally {
    await custody.close();
    if (created) await search.request('DELETE', `/${index}`);
    await f.close();
  }
});
