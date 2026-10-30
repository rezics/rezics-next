import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest } from '@rezics/definitions';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import type { PublicFilterSourceCaptureInput } from '../../src/semantic/public-filter-source-binding.ts';
import type { PublicFilterDependencyKey } from '../../src/semantic/public-filter-source-contract.ts';
import { createPublicFilterCustody } from '../../src/search/public-filter-custody.ts';
import type { PublicFilterConsumerCaptureInput } from '../../src/search/public-filter-consumer-contract.ts';
import { parseText } from '../../src/search/text.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, capture, checkGrowth, costOf, seed } from '../support/growth.ts';
import {
  assertPageCapture,
  consumerFixture,
  fixture,
  nativeProducer,
  readContext,
} from './support/public-filter-source.ts';

// These are Source metadata/retained-custody measurements, not evidence of a query-ready index.
// In particular, a committed execution record cannot supply the missing Search settle authority.
test('native Source binding lookups stay bounded as unrelated subjects, history, definitions and executions grow independently', async () => {
  const f = await fixture();
  const { publicFilterSource } = await nativeProducer();
  const source = publicFilterSource(f.config);
  const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
  const custody = createPublicFilterCustody(f.db.pool);
  const consumer = await consumerFixture(f, source);
  try {
    const person = await f.create();
    const book = await f.create('schema:Book');
    const unrelated = await f.create('schema:Book');
    const root: PublicFilterConsumerCaptureInput = {
      sort: 'name',
      size: 10,
      pageSize: 10,
      filterDocument: {
        not: {
          statement: {
            property: 'schema:author',
            in: [person],
            qualifiers: [{ property: 'ex:left', in: [person] }],
          },
        },
      },
      text: parseText('native -excluded'),
    };
    const resolved = await binding.resolve({ source, meaning: f.meaning, capture: root }, readContext());
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    const definition = structuredClone(resolved.definition);
    expect(definition.meaning.digest).toBe(releaseDigest(definition.meaning.release));
    const expectedDependencies = [
      { kind: 'property', property: 'schema:author' },
      { kind: 'property', property: 'ex:left' },
      { kind: 'order', order: 'name' },
      { kind: 'order', order: 'relevance' },
      { kind: 'field', field: 'id' },
      { kind: 'field', field: 'descriptions' },
    ] satisfies PublicFilterDependencyKey[];
    for (const key of expectedDependencies) expect(definition.dependencyKeys).toContainEqual(key);
    const registered = await custody.register(
      {
        definition,
        physicalTarget: consumer.physicalTarget,
        consumerGeneration: '1',
        projectionGeneration: '1',
      },
      consumer.transport,
      readContext(),
    );
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const begun = await binding.begin(
      {
        source,
        meaning: f.meaning,
        capture: root,
        consumer: registered.consumer,
        snapshot: 'pit',
      },
      readContext(),
    );
    expect(begun.status).toBe('begun');
    if (begun.status !== 'begun') throw new Error(begun.reason);
    const retained = await custody.openPit(
      {
        registration: registered.registration,
        covered: begun.bootstrap.covered,
        keepAliveMs: 300_000,
      },
      consumer.transport,
      readContext(),
    );
    if (retained.status !== 'retained') throw new Error(retained.reason);
    let queried = retained.queried;
    try {
      expect(await binding.adopt({ bootstrap: begun.bootstrap.id, queried: queried }, readContext())).toMatchObject({
        status: 'adopted',
        bootstrap: begun.bootstrap,
      });
      const acquired = await custody.acquire(queried, readContext());
      if (acquired.status !== 'acquired') throw new Error(acquired.reason);
      try {
        // Narrow custody primitives retain actual native cuts/rows; this is deliberately NOT a
        // successful engine query or an ACK. Full native dispatch is exercised separately below.
        const execution = {
          id: randomUUID(),
          start: begun.bootstrap.covered,
          ownRows: [{ original: book, terminal: book }],
        };
        expect(await custody.appendExecution({ use: acquired.use, execution }, readContext())).toMatchObject({
          status: 'appended',
        });
        const empty = { id: randomUUID(), start: begun.bootstrap.covered, ownRows: [] };
        expect(await custody.appendExecution({ use: acquired.use, execution: empty }, readContext())).toMatchObject({
          status: 'appended',
        });
        for (const axis of ['subjects', 'history', 'definitions', 'executions']) {
          const report = await checkGrowth(f.db, {
            name: `public Source native binding independent ${axis}`,
            scales: [64, 512, 4096],
            bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
            byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
            includeBackends: true,
            async grow(database, scale, previous) {
              if (axis === 'subjects')
                await seed(
                  database,
                  {
                    name: `public-source-binding-subjects-${book}`,
                    hotPartition: 0,
                    rows: ({ route }) => ({
                      'semantic.subject': [
                        {
                          route,
                          subject_id: newId(route),
                          type: 'schema:Book',
                          recorded_transaction_id: randomUUID(),
                          current_release: f.meaning.digest,
                        },
                      ],
                    }),
                  },
                  { from: previous, to: scale },
                );
              if (axis === 'history')
                await seed(
                  database,
                  {
                    name: `public-source-binding-history-${unrelated}`,
                    hotPartition: 0,
                    rows: ({ ordinal }) => ({
                      'semantic.revision': [
                        {
                          route: routeOf(unrelated)!,
                          subject_id: unrelated,
                          revision: ordinal + 2,
                          kind: 'propose',
                          release: f.meaning.digest,
                          recorded_transaction_id: randomUUID(),
                        },
                      ],
                    }),
                  },
                  { from: previous, to: scale },
                );
              if (axis === 'definitions')
                for (let i = previous; i < scale; i++) {
                  if ((i - previous) % 64 === 0) {
                    const renewed = await custody.renewPit(queried, 300_000, consumer.transport, readContext());
                    if (renewed.status !== 'retained') throw new Error(renewed.reason);
                    expect(renewed.queried.snapshot.observation).toBe(queried.snapshot.observation);
                    queried = renewed.queried;
                  }
                  const capture: PublicFilterConsumerCaptureInput = { ...root, after: [`Unrelated ${i}`, newId(16)] };
                  const other = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
                  if (other.status !== 'resolved') throw new Error(other.reason);
                  const registration = await custody.register(
                    {
                      definition: other.definition,
                      physicalTarget: consumer.physicalTarget,
                      consumerGeneration: '1',
                      projectionGeneration: '1',
                    },
                    consumer.transport,
                    readContext(),
                  );
                  if (registration.status !== 'registered') throw new Error(registration.reason);
                }
              if (axis === 'executions')
                for (let i = previous; i < scale; i++) {
                  if ((i - previous) % 64 === 0) {
                    const renewed = await custody.renewPit(queried, 300_000, consumer.transport, readContext());
                    if (renewed.status !== 'retained') throw new Error(renewed.reason);
                    expect(renewed.queried.snapshot.observation).toBe(queried.snapshot.observation);
                    queried = renewed.queried;
                  }
                  const lease = await custody.acquire(queried, readContext());
                  if (lease.status !== 'acquired') throw new Error(lease.reason);
                  try {
                    const appended = await custody.appendExecution(
                      {
                        use: lease.use,
                        execution: {
                          id: randomUUID(),
                          start: begun.bootstrap.covered,
                          ownRows: [],
                        },
                      },
                      readContext(),
                    );
                    if (appended.status !== 'appended') throw new Error(appended.reason);
                  } finally {
                    expect(await custody.release(lease.use, readContext())).toMatchObject({ status: 'released' });
                  }
                }
            },
            async operation() {
              const current = await binding.resolve({ source, meaning: f.meaning, capture: root }, readContext());
              expect(current.status === 'resolved' && current.definition).toEqual(definition);
              const joined = await binding.join({ queried: queried, execution: execution.id }, readContext());
              expect(joined.status).toBe('joined');
              if (joined.status !== 'joined') throw new Error(joined.reason);
              expect(joined.definition).toEqual(definition);
              expect(joined.queried).toEqual(queried);
              expect(joined.covered).toEqual(begun.bootstrap.covered);
              expect(joined.execution).toEqual(execution);
            },
          });
          expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
          assertGrowthAccessPaths(`public Source ${axis}`, report.samples, [
            'semantic.public_filter_source',
            'semantic.public_filter_read_definition',
            'semantic.public_filter_bootstrap',
            'search.public_filter_registration',
            'search.public_filter_observation',
            'search.public_filter_execution',
          ]);
          if (axis === 'definitions')
            expect(
              report.samples[2]!.relationSizes['semantic.public_filter_read_definition']?.relpages,
            ).toBeGreaterThan(8);
          if (axis === 'executions')
            expect(report.samples[2]!.relationSizes['search.public_filter_execution']?.relpages).toBeGreaterThan(8);
          for (const sample of report.samples)
            for (const work of sample.repetitions) {
              // ALL metadata and the refused lookup remain in this inclusive maintenance measurement.
              expect(work.requestBytes).toBeDefined();
              expect(work.responseBytes).toBeDefined();
              expect(work.failedStatements ?? {}).toEqual({});
              expect(work.rows).toBeLessThanOrEqual(64 + 16 * 256);
              expect(work.blocks).toBeLessThanOrEqual(6 * (64 + 16 * 256));
              expect(work.responseBytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
              expect(work.statements).toBeLessThanOrEqual(16);
            }
        }
        const second = await binding.join({ queried: queried, execution: empty.id }, readContext());
        expect(second.status === 'joined' && second.execution).toEqual(empty);
        const refused = await capture(
          f.db,
          () =>
            binding.join(
              {
                queried: queried,
                execution: 'absent-execution',
              },
              readContext(),
            ),
          { includeBackends: true },
        );
        expect(refused.value).toMatchObject({ status: 'unready', reason: 'execution_missing' });
        expect(costOf(refused.capture).statements).toBeGreaterThan(0);
        const diagnostic = await binding.join({ queried: queried }, readContext());
        expect(diagnostic.status === 'joined' && diagnostic.execution).toBeNull();
        expect(
          await binding.settle(
            {
              bootstrap: begun.bootstrap.id,
              queried: queried,
              execution: execution.id,
            },
            readContext(),
          ),
        ).toMatchObject({ status: 'unavailable', reason: 'owner_unavailable' });
        // The exact Search dispatch/visible-winner/retained-copy settlement reader is absent.
        // Native custody and a Source repair receipt cannot manufacture that foreign authority.
      } finally {
        expect(await custody.release(acquired.use, readContext())).toMatchObject({ status: 'released' });
      }
      const recovered = await createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access).recover(
        { bootstrap: begun.bootstrap.id },
        readContext(),
      );
      expect(recovered).toMatchObject({ status: 'adopted', queried: queried, bootstrap: begun.bootstrap });
    } finally {
      expect(await custody.closeObservation(queried, consumer.transport, readContext())).toMatchObject({
        status: 'closed',
      });
    }
    expect(await binding.join({ queried: queried }, readContext())).toMatchObject({ reason: 'observation_lost' });
    expect(await binding.abort({ bootstrap: begun.bootstrap.id }, readContext())).toMatchObject({ status: 'pending' });
  } finally {
    await custody.close();
    await consumer.close();
    await f.close();
  }
}, 600_000);

// Preserve full Search-owned dispatch/window acceptance without supplying a synthetic ready Source.
// Missing native privacy/settlement owners stay observable failures/refusals, not successful empty queries.
test('original capture survives native derived execution windows and exact release changes without borrowing rebuild output', async () => {
  const f = await fixture();
  const { publicFilterSource } = await nativeProducer();
  const source = publicFilterSource(f.config);
  const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
  const consumer = await consumerFixture(f, source);
  try {
    const term = `native${randomUUID().replaceAll('-', '')}`;
    const root: PublicFilterConsumerCaptureInput = {
      sort: 'name',
      size: 3,
      pageSize: 2,
      filterDocument: undefined,
      text: parseText(`${term} -excluded`),
    };
    const book: string = (await f.post('/v1/subjects', { type: 'schema:Book', labels: { en: term }, statements: {} }))
      .subject.id;
    const captured = await consumer.operations.capture({ plan: root, snapshot: 'pit' }, readContext());
    if (captured.status === 'preparing') {
      const repair = await consumer.operations.repairStep(captured.repair, readContext());
      // Source settle cannot certify Search engine-visible repair. Do not inject completion.
      expect(repair).toMatchObject({ status: 'unavailable', reason: 'source_pending' });
      return;
    }
    expect(captured.status).toBe('captured');
    if (captured.status !== 'captured') throw new Error(captured.reason);
    const original = await binding.join({ queried: captured.queried }, readContext());
    if (original.status !== 'joined') throw new Error(original.reason);
    const release = structuredClone(f.meaning.release);
    release.catalogue = { id: 'https://example.test/public-filter', version: 'growth-next' };
    await f.post('/v1/definitions/releases', { release });
    const { activeRelease } = await import('../../src/semantic/definitions.ts');
    const active = await activeRelease(f.db.pool);
    await f.post(`/v1/definitions/releases/${releaseDigest(release)}:activate`, {
      expected_head: active?.head ?? null,
    });
    const context = readContext();
    const whole = await capture(
      f.db,
      async () => {
        const first = await consumer.operations.query(captured.queried, context);
        expect(first.status).toBe('queried');
        if (first.status !== 'queried')
          throw new Error('Native execution unavailable; no substitute query is admitted');
        expect(first.result.hits.map((hit) => hit.id)).toContain(book);
        expect(first.window.examined).toBeGreaterThan(0);
        const joined = await binding.join({ queried: first.queried, execution: first.execution }, context);
        expect(joined.status).toBe('joined');
        if (joined.status !== 'joined') throw new Error(joined.reason);
        expect(joined.definition).toEqual(original.definition);
        expect(joined.definition.meaning.digest).toBe(f.meaning.digest);
        expect(joined.execution?.start).toEqual(first.start);
        const second = await consumer.operations.query(first.queried, context, {
          execution: first.execution,
          consumed: first.window.examined,
          size: 1,
        });
        expect(second.status).toBe('queried');
        if (second.status !== 'queried') throw new Error('Derived native execution unavailable');
        const next = await binding.join({ queried: second.queried, execution: second.execution }, context);
        expect(next.status).toBe('joined');
        if (next.status !== 'joined') throw new Error(next.reason);
        expect(next.definition).toEqual(original.definition);
        expect(next.covered).toEqual(original.covered);
        expect(next.execution?.id).toBe(second.execution);
        expect(next.execution?.start).toEqual(second.start);
        expect(next.execution?.ownRows.length).toBe(second.window.examined);
        const final = await consumer.operations.readStatus(
          {
            queried: second.queried,
            execution: second.execution,
          },
          context,
        );
        expect(final.status).toBe('observed');
        if (final.status !== 'observed') throw new Error(final.reason);
        return { first, second, final };
      },
      { includeBackends: true },
    );
    // Charge the original dispatch as well as the derived window, including rejected,
    // lookahead and unused raw rows. A retained execution does not make its work free.
    const costs = [whole.value.first.cost, whole.value.second.cost, whole.value.final.cost];
    for (const cost of costs)
      for (const count of Object.values(cost)) expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
    const candidates = costs.reduce((sum, cost) => sum + cost.candidates, 0);
    expect(candidates).toBeLessThanOrEqual(Math.min(600, 6 * 2 + 3));
    expect(costs.reduce((sum, cost) => sum + cost.inputKeys, 0)).toBeLessThanOrEqual(256);
    expect(costs.reduce((sum, cost) => sum + cost.accessPoints + cost.dependencyPoints, 0)).toBeLessThanOrEqual(
      16 + 8 * candidates,
    );
    expect(costs.reduce((sum, cost) => sum + cost.engineSearches, 0)).toBeLessThanOrEqual(6);
    expect(costs.reduce((sum, cost) => sum + cost.outputSlots, 0)).toBeLessThanOrEqual(2);
    // Existing shared role attribution asserts paired <=2 SQL/64+2*(behind+changed) separately
    // from whole-page SQL/engine-count limits. Binding metadata gets no extra request allowance.
    // createPublicFilterConsumerFixture exposes nativeReceipts/engineResponses, not actual
    // request/response wire-byte totals. This helper's PostgreSQL bytes cannot prove combined
    // PostgreSQL+engine byte acceptance; that Search-owned measurement export is still missing.
    await assertPageCapture(
      'public-source-original-native-window',
      whole.capture,
      whole.value.second,
      whole.value.final,
      2,
    );
    expect(costOf(whole.capture).failedStatements ?? {}).toEqual({});
  } finally {
    await consumer.close();
    await f.close();
  }
});

test('native Source captures reject caller substitutions and preserve prefix meaning rather than a returned-key witness', async () => {
  const f = await fixture();
  const { publicFilterSource } = await nativeProducer();
  const source = publicFilterSource(f.config);
  const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
  try {
    const prefix = {
      purpose: 'suggest',
      prefix: 'Nat',
      size: 10,
      filterDocument: undefined,
      text: undefined,
    } satisfies PublicFilterSourceCaptureInput;
    const pending = binding.resolve({ source, meaning: f.meaning, capture: prefix }, readContext());
    prefix.prefix = 'Changed';
    const resolved = await pending;
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    expect(resolved.definition.capture).toMatchObject({ purpose: 'suggest', prefix: 'Nat', size: 10 });
    expect(resolved.definition.dependencyKeys).toContainEqual({ kind: 'field', field: 'name_sort' });
    const release = structuredClone(f.meaning.release);
    release.catalogue = { id: 'https://example.test/public-filter', version: 'prefix-next' };
    await f.post('/v1/definitions/releases', { release });
    const { activeRelease } = await import('../../src/semantic/definitions.ts');
    const active = await activeRelease(f.db.pool);
    await f.post(`/v1/definitions/releases/${releaseDigest(release)}:activate`, {
      expected_head: active?.head ?? null,
    });
    const original = await binding.resolve(
      { source, meaning: f.meaning, capture: resolved.definition.capture },
      readContext(),
    );
    expect(original.status === 'resolved' && original.definition).toEqual(resolved.definition);
    expect(resolved.definition.meaning.digest).toBe(f.meaning.digest);

    expect(
      await binding.resolve({ source: { ...source }, meaning: f.meaning, capture: prefix }, readContext()),
    ).toMatchObject({ reason: 'source_missing' });
    const pool = f.db.openPool({ max: 1 });
    const foreign = createPublicFilterSourceBinding(pool, f.config.routeKey, f.config.access);
    expect(await foreign.resolve({ source, meaning: f.meaning, capture: prefix }, readContext())).toMatchObject({
      reason: 'source_missing',
    });
  } finally {
    await f.close();
  }
});
