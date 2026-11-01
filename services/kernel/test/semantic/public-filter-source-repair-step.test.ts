import { expect, test } from 'bun:test';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import { fixture, nativeProducer, readContext } from './support/public-filter-source.ts';
import type { PublicFilterConsumerJob, PublicFilterQueriedObservation } from '../../src/search/public-filter-consumer-contract.ts';

test('native Source retains and replays a durable empty repair-step locator list', async () => {
  const { createPublicFilterCustody } = await import('../../src/search/public-filter-custody.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const index = `source-empty-step-${crypto.randomUUID()}`;
  const custody = createPublicFilterCustody(f.db.pool);
  let created = false;
  try {
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = { sort: 'id' as const, size: 10, filterDocument: undefined, text: undefined };
    const resolved = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    await search.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
    created = true;
    const registered = await custody.register(
      { definition: resolved.definition, physicalTarget: index, consumerGeneration: '1', projectionGeneration: '1' },
      search,
      readContext(),
    );
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const begun = await binding.begin(
      { source, meaning: f.meaning, capture, consumer: registered.consumer, snapshot: 'prepared' },
      readContext(),
    );
    if (begun.status !== 'begun') throw new Error(begun.reason);
    const retained = await custody.retainPrepared(
      {
        registration: registered.registration,
        covered: begun.bootstrap.covered,
        build: crypto.randomUUID(),
        generation: 1n,
        rows: [],
        expiresAt: Date.now() + 600000,
      },
      readContext(),
    );
    if (retained.status !== 'retained') throw new Error(retained.reason);
    expect(
      (await binding.adopt({ bootstrap: begun.bootstrap.id, queried: retained.queried }, readContext())).status,
    ).toBe('adopted');
    const acquired = await custody.acquire(retained.queried, readContext());
    if (acquired.status !== 'acquired') throw new Error(acquired.reason);
    const execution = crypto.randomUUID();
    try {
      expect(
        (
          await custody.appendExecution(
            { use: acquired.use, execution: { id: execution, start: begun.bootstrap.covered, ownRows: [] } },
            readContext(),
          )
        ).status,
      ).toBe('appended');
    } finally {
      await custody.release(acquired.use, readContext());
    }
    const request = {
      bootstrap: begun.bootstrap.id,
      queried: retained.queried,
      execution,
      frontier: null,
      inputLimit: 256,
    };
    const page = await binding.repairPage(request, readContext());
    expect(page.status).toBe('progress');
    if (page.status !== 'progress') throw new Error('Native Source step did not persist');
    const read = { bootstrap: begun.bootstrap.id, queried: retained.queried, execution, predecessor: null };
    expect(await binding.readRepairStep(read, readContext())).toMatchObject({
      status: 'verified',
      step: page.frontier,
      predecessor: null,
      frontier: page.frontier,
      complete: false,
      receipts: [],
    });
    const recovered = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const replay = await recovered.repairPage(request, readContext());
    expect(replay.status).toBe('progress');
    if (replay.status !== 'progress') throw new Error('Lost-response replay did not resolve the stored step');
    expect(replay.frontier).toBe(page.frontier);
    expect(await recovered.readRepairStep(read, readContext())).toMatchObject({
      status: 'verified',
      step: page.frontier,
      receipts: [],
    });
  } finally {
    await custody.close();
    if (created) await search.request('DELETE', `/${index}`);
    await f.close();
  }
});

test(
  'Native public Source repair step and complete original cut are durably revalidated before joining genuine Search dispatch settlement without current ACK or incomplete enumeration substitutes',
  async () => {
    const { createOpenSearch } = await import('../../src/search/opensearch.ts');
    const { createPublicFilterConsumerFixture } = await import('../search/support/public-filter-consumer.ts');
    const { publicFilterSource } = await nativeProducer();
    const f = await fixture();
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const person = await f.create();
    await f.create('schema:Book', {
      'schema:author': [
        { property: { id: 'schema:author' }, value: { type: 'value', content: person }, qualifiers: [] },
      ],
    });
    const search = createOpenSearch(process.env.OPENSEARCH_URL!);
    let bootstrap: string | null = null;
    let consumer: Awaited<ReturnType<typeof createPublicFilterConsumerFixture>> | undefined;
    try {
      // Observe the genuine Source begin call so the fixture can ask the existing Source settle method
      // with its real bootstrap locator after Search produces a native dispatch settlement.
      const trackedBinding = new Proxy(binding, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property === 'begin' && typeof value === 'function')
            return async (...args: Parameters<typeof binding.begin>) => {
              const result = await target.begin(...args);
              if (result.status === 'begun') bootstrap = result.bootstrap.id;
              return result;
            };
          return value;
        },
      });
      consumer = await createPublicFilterConsumerFixture({
        pool: f.db.pool,
        source,
        binding: trackedBinding,
        clock: f.config.clock,
        context: readContext(),
        search,
        meaning: f.meaning,
      });
      const plan = { sort: 'id' as const, size: 10, filterDocument: undefined, text: undefined };
      let queried: PublicFilterQueriedObservation | undefined;
      let job: PublicFilterConsumerJob | undefined;
      for (let attempt = 0; attempt < 10000; attempt++) {
        const captured = await consumer.operations.capture({ plan, snapshot: 'prepared' }, readContext());
        if (captured.status === 'captured') {
          queried = captured.queried;
          job = captured.repair;
          break;
        }
        if (captured.status !== 'preparing') throw new Error(`Native capture ${captured.status}`);
        const progress = await consumer.operations.repairStep(captured.repair, readContext());
        if (progress.status === 'unready' || progress.status === 'unavailable')
          throw new Error(`Native capture repair ${progress.reason}`);
      }
      if (!queried || !job || !bootstrap) throw new Error('Native Search capture did not retain its Source bootstrap');
      const execution = await consumer.operations.query(queried, readContext());
      if (execution.status !== 'queried') throw new Error(`Native execution ${execution.status}`);

      // A real target refresh cannot replace completion of the original Source cut and repair steps.
      await consumer.transport.request('POST', `/${consumer.physicalTarget}/_refresh`);
      const incomplete = await binding.settle({ bootstrap, queried, execution: execution.execution }, readContext());
      expect(incomplete.status).not.toBe('joined');

      let settled = false;
      for (let attempt = 0; attempt < 10000; attempt++) {
        const progress = await consumer.operations.repairStep(job, readContext());
        if (progress.status === 'settled') {
          settled = true;
          break;
        }
        if (progress.status === 'unready' || progress.status === 'unavailable')
          throw new Error(`Native Search settlement ${progress.reason}`);
      }
      expect(settled).toBe(true);
      expect(await binding.settle({ bootstrap, queried, execution: execution.execution }, readContext())).toMatchObject({
        status: 'joined',
        queried,
        execution: { id: execution.execution },
      });

      await consumer.recreate();
      expect((await binding.settle({ bootstrap, queried, execution: execution.execution }, readContext())).status).not.toBe(
        'joined',
      );
    } finally {
      await consumer?.close();
      await f.close();
    }
  },
);
