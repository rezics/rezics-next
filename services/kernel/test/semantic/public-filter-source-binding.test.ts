import { newId } from '../../src/route/route.ts';
import { checkGrowth, seed } from '../support/growth.ts';
import { publicationJob } from './support/public-filter-binding.ts';
import { expect, test } from 'bun:test';
import {
  createPublicFilterSourceBinding,
  readNativePublicFilterPublicationCompletion,
  type NativeSourceRepairLocator,
  type NativeSourceRepairStepVerification,
} from '../../src/semantic/public-filter-source-binding.ts';
import {
  capturedConsumer,
  consumerFixture,
  fixture,
  nativeProducer,
  readContext,
} from './support/public-filter-source.ts';

test('native public Source configuration and immutable meaning/read definition resolve without trusting caller identity', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = {
      sort: 'id' as const,
      size: 10,
      filterDocument: undefined,
      text: undefined,
    };
    const result = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error(`Native Source binding ${result.reason}`);
    expect(result.definition.source.epoch).toBeGreaterThan(0);
    expect(result.definition.source.configuration.length).toBeGreaterThan(0);
    expect(result.definition.readDefinition.length).toBeGreaterThan(0);
    expect(result.definition.dependencyKeys).toContainEqual({
      kind: 'field',
      field: 'id',
    });
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
          statement: {
            property: 'schema:author',
            in: [person],
            qualifiers: [{ property: 'ex:left', in: [person] }],
          },
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
    await search.request('PUT', `/${index}`, {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
    });
    created = true;
    const registered = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: index,
        consumerGeneration: '1',
        projectionGeneration: '1',
      },
      search,
      readContext(),
    );
    expect(registered.status).toBe('registered');
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const begun = await binding.begin(
      {
        source,
        meaning: f.meaning,
        capture,
        consumer: registered.consumer,
        snapshot: 'prepared',
      },
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
        const execution = {
          id: crypto.randomUUID(),
          start: begun.bootstrap.covered,
          ownRows,
        };
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

test('native Source repair receipts revalidate original steps, replay, and current ownership without completing an incomplete cut', async () => {
  const { createPublicFilterCustody } = await import('../../src/search/public-filter-custody.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const index = `source-repair-${crypto.randomUUID()}`;
  const custody = createPublicFilterCustody(f.db.pool);
  let created = false;
  try {
    const person = await f.create();
    const book = await f.create('schema:Book', {
      'schema:author': [
        {
          property: { id: 'schema:author' },
          value: { type: 'value', content: person },
          qualifiers: [],
        },
      ],
    });
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = {
      sort: 'id' as const,
      size: 10,
      filterDocument: undefined,
      text: undefined,
    };
    const resolved = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    await search.request('PUT', `/${index}`, {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
    });
    created = true;
    const registered = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: index,
        consumerGeneration: '1',
        projectionGeneration: '1',
      },
      search,
      readContext(),
    );
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const begun = await binding.begin(
      {
        source,
        meaning: f.meaning,
        capture,
        consumer: registered.consumer,
        snapshot: 'prepared',
      },
      readContext(),
    );
    if (begun.status !== 'begun') throw new Error(begun.reason);
    const retained = await custody.retainPrepared(
      {
        registration: registered.registration,
        covered: begun.bootstrap.covered,
        build: crypto.randomUUID(),
        generation: 1n,
        rows: [{ original: book, terminal: book }],
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
            {
              use: acquired.use,
              execution: {
                id: execution,
                start: begun.bootstrap.covered,
                ownRows: [{ original: book, terminal: book }],
              },
            },
            readContext(),
          )
        ).status,
      ).toBe('appended');
    } finally {
      await custody.release(acquired.use, readContext());
    }
    const original = {
      bootstrap: begun.bootstrap.id,
      queried: retained.queried,
      execution,
    };
    const forged: NativeSourceRepairLocator = {
      bootstrap: original.bootstrap,
      execution,
      step: crypto.randomUUID(),
      locatorDigest: '0'.repeat(64),
    };
    expect(
      (await binding.readRepairReceipt({ receipt: forged, queried: retained.queried, execution }, readContext()))
        .status,
    ).not.toBe('verified');
    expect((await binding.settle(original, readContext())).status).not.toBe('joined');

    // Ordinary native pages are the only way to reach the original produced step. No fixture receipt setter.
    let frontier: string | null = null;
    let found = false;
    for (let steps = 0; steps < 20000; steps++) {
      const request = { ...original, frontier, inputLimit: 256 };
      const page = await binding.repairPage(request, readContext());
      expect(page.status).toBe('progress');
      if (page.status !== 'progress') throw new Error(`Native repair stopped: ${page.status}`);
      const repair = page.repairs.find((entry) => entry.source.subject === book);
      if (!repair) {
        frontier = page.frontier;
        continue;
      }
      found = true;
      const step = await binding.readRepairStep(
        {
          bootstrap: original.bootstrap,
          queried: retained.queried,
          execution,
          predecessor: frontier,
        },
        readContext(),
      );
      expect(step).toMatchObject({
        status: 'verified',
        step: page.frontier,
        predecessor: frontier,
        complete: false,
      });
      if (step.status !== 'verified') throw new Error('Native Source repair step was not verified');
      expect(step.receipts.map((receipt) => receipt.locatorDigest)).toEqual(
        page.repairs.map((entry) => entry.receipt.locatorDigest),
      );
      const recovered = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
      const replay = await recovered.repairPage(request, readContext());
      expect(replay.status).toBe('progress');
      if (replay.status !== 'progress') throw new Error('Lost-response replay did not recover the native step');
      expect(replay.frontier).toBe(page.frontier);
      expect(replay.repairs.map((entry) => entry.receipt.step)).toEqual(
        page.repairs.map((entry) => entry.receipt.step),
      );
      const receipt: NativeSourceRepairLocator = JSON.parse(JSON.stringify(repair.receipt));
      const read = { receipt, queried: retained.queried, execution };
      expect((await recovered.readRepairReceipt(read, readContext())).status).toBe('verified');
      expect(
        (
          await recovered.readRepairReceipt(
            { ...read, receipt: { ...receipt, locatorDigest: 'f'.repeat(64) } },
            readContext(),
          )
        ).status,
      ).not.toBe('verified');
      expect(
        (await recovered.readRepairReceipt({ ...read, execution: crypto.randomUUID() }, readContext())).status,
      ).not.toBe('verified');
      expect((await recovered.repairPage({ ...request, inputLimit: 1 }, readContext())).status).not.toBe('progress');
      expect((await recovered.settle(original, readContext())).status).not.toBe('joined');
      await f.propose(book, person);
      expect((await recovered.readRepairReceipt(read, readContext())).status).not.toBe('verified');
      await f.db.admin.query('UPDATE core.partition SET epoch = epoch + 1 WHERE partition_no = $1', [
        repair.source.partition,
      ]);
      expect((await recovered.readRepairReceipt(read, readContext())).status).not.toBe('verified');
      break;
    }
    expect(found).toBe(true);
  } finally {
    await custody.close();
    if (created) await search.request('DELETE', `/${index}`);
    await f.close();
  }
});

test('Native public Source repair step and complete original cut are durably revalidated before joining genuine Search dispatch settlement without current ACK or incomplete enumeration substitutes', async () => {
  const { readPublicFilterConsumerCustody, readPublicFilterRepairSettlement } =
    await import('../../src/search/public-filter-custody.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  let consumer: Awaited<ReturnType<typeof consumerFixture>> | undefined;
  try {
    const source = publicFilterSource(f.config);
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    consumer = await consumerFixture(f, source);
    const capture = await capturedConsumer(
      f,
      consumer,
      { sort: 'id', size: 10, filterDocument: undefined, text: undefined },
      'prepared',
    );
    const query = await consumer.operations.query(capture.queried, readContext());
    expect(query.status).toBe('queried');
    if (query.status !== 'queried') throw new Error(`Native default query ${query.status}`);
    const retained = await readPublicFilterConsumerCustody(
      f.db.pool,
      { queried: query.queried, execution: query.execution },
      readContext(),
    );
    expect(retained.status).toBe('found');
    if (retained.status !== 'found' || !retained.execution) throw new Error('Missing actual Search execution');
    const request = {
      bootstrap: retained.covered.observation,
      queried: query.queried,
      execution: query.execution,
    };

    const job = await publicationJob(f, source, query.queried.consumer);
    const publication = { ...request, job };
    // The genuine native query has dispatched. Lose only the reply after the original
    // Source association commits, before the completion reader can adopt/settle it.
    let interrupted = false;
    const losingReply = new Proxy(f.db.pool, {
      get(target, key) {
        if (key === 'query')
          return async (statement: string, values?: unknown[]) => {
            const result = await target.query(statement, values);
            if (!interrupted && statement.includes('SET publication_job=')) {
              interrupted = true;
              throw new Error('Lost original Source publication association reply');
            }
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      readNativePublicFilterPublicationCompletion(
        createPublicFilterSourceBinding(losingReply, f.config.routeKey, f.config.access),
        publication,
        readContext(),
      ),
    ).rejects.toThrow('Lost original Source publication association reply');
    expect(interrupted).toBe(true);
    expect((await readNativePublicFilterPublicationCompletion(binding, publication, readContext())).status).not.toBe(
      'complete',
    );
    // Restart after the original observation: the persisted job resolves that same cut/execution.
    const restarted = () => createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    expect(await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext())).toMatchObject({
      status: 'pending',
      publication,
    });
    const first = await consumer.operations.repairStep(capture.repair, readContext());
    expect(first.status).toBe('progress');
    if (first.status !== 'progress') throw new Error(`Incomplete Source repair ${first.status}`);
    const incomplete = await binding.readRepairStep({ ...request, predecessor: null }, readContext());
    expect(incomplete).toMatchObject({
      status: 'verified',
      predecessor: null,
      complete: false,
    });
    if (incomplete.status !== 'verified') throw new Error('Original Source step was not revalidated');
    expect(incomplete.frontier).toBe(incomplete.step);
    expect(incomplete.receipts.length).toBeLessThanOrEqual(256);

    // An existing live target acknowledgement cannot replace the original cut's unfinished Source frontier.
    expect(
      (
        await readPublicFilterRepairSettlement(
          f.db.pool,
          { queried: query.queried, execution: query.execution },
          readContext(),
        )
      ).status,
    ).not.toBe('settled');
    expect((await binding.settle(request, readContext())).status).not.toBe('joined');

    let settled = false;
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const result = await consumer.operations.repairStep(capture.repair, readContext());
      if (result.status === 'progress') continue;
      expect(result.status).toBe('settled');
      settled = result.status === 'settled';
      break;
    }
    expect(settled).toBe(true);

    let predecessor: string | null = null;
    let complete: NativeSourceRepairStepVerification | null = null;
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const step: NativeSourceRepairStepVerification = await binding.readRepairStep(
        { ...request, predecessor },
        readContext(),
      );
      expect(step.status).toBe('verified');
      if (step.status !== 'verified') throw new Error(`Native Source step ${step.status}`);
      if (step.complete) {
        complete = step;
        break;
      }
      expect(step.frontier).toBe(step.step);
      predecessor = step.step;
    }
    expect(complete?.status).toBe('verified');
    if (!complete || complete.status !== 'verified') throw new Error('Original Source cut did not close');
    expect(complete.frontier).toBeNull();
    expect(complete.predecessor).toBe(predecessor);

    const dispatch = await readPublicFilterRepairSettlement(
      f.db.pool,
      { queried: query.queried, execution: query.execution },
      readContext(),
    );
    expect(dispatch.status).toBe('settled');
    if (dispatch.status !== 'settled') throw new Error(`Native Search settlement ${dispatch.status}`);
    const joined = await binding.settle(request, readContext());
    expect(joined.status).toBe('joined');
    if (joined.status !== 'joined') throw new Error(`Native Source settlement ${joined.status}`);
    expect(joined.queried).toEqual(query.queried);
    expect(joined.execution).toEqual(retained.execution);
    expect(joined.covered).toEqual(retained.covered);
    expect(dispatch.settlement.id).toBeString();
    // Native drain committed before a reply/restart. Both reads must return the original proof.
    for (let restart = 0; restart < 2; restart++) {
      const result = await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext());
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') throw new Error(`Native publication completion ${result.reason}`);
      expect(result.publication).toEqual(publication);
      expect(result.covered).toEqual(retained.covered);
      expect(result.execution).toEqual(retained.execution);
      expect(result.terminal.step).toBe(complete.step);
      expect(result.observation).toMatchObject({
        status: 'observed',
        coverage: 'all_native_homes',
      });
      expect(result.settlement.id).toBe(dispatch.settlement.id);
    }
    const growth = await checkGrowth(f.db, {
      name: 'original Source generation completion fixed window',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      async grow(database, scale, previous) {
        await seed(
          database,
          {
            name: `publication-unrelated-${job}`,
            hotPartition: 0,
            rows: ({ route }) => ({
              'semantic.subject': [
                {
                  route,
                  subject_id: newId(route),
                  type: 'schema:Person',
                  recorded_transaction_id: crypto.randomUUID(),
                  current_release: f.meaning.digest,
                },
              ],
            }),
          },
          { from: previous, to: scale },
        );
      },
      async operation() {
        const result = await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext());
        expect(result.status).toBe('complete');
        if (result.status !== 'complete') throw new Error(`Original completion ${result.reason}`);
        expect(result.publication).toEqual(publication);
        expect(result.cost.inputKeys).toBeLessThanOrEqual(1000);
        for (const field of ['rows', 'statements', 'bytes', 'engineRequests'])
          expect(Reflect.get(result.cost, field)).toBeGreaterThan(0);
      },
    });
    expect(growth.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
    const equivalent = await consumer.operations.query(query.queried, readContext());
    expect(equivalent.status).toBe('queried');
    if (equivalent.status !== 'queried') throw new Error('Missing equivalent native execution');
    expect(equivalent.execution).not.toBe(query.execution);
    expect(
      (
        await readNativePublicFilterPublicationCompletion(
          restarted(),
          { ...publication, execution: equivalent.execution },
          readContext(),
        )
      ).status,
    ).not.toBe('complete');
    expect((await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext())).status).toBe(
      'complete',
    );
    await consumer.recreate();
    expect((await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext())).status).not.toBe(
      'complete',
    );
  } finally {
    try {
      await consumer?.close();
    } finally {
      await f.close();
    }
  }
});

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
    const capture = {
      sort: 'id' as const,
      size: 10,
      filterDocument: undefined,
      text: undefined,
    };
    const resolved = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    await search.request('PUT', `/${index}`, {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
    });
    created = true;
    const registered = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: index,
        consumerGeneration: '1',
        projectionGeneration: '1',
      },
      search,
      readContext(),
    );
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const begun = await binding.begin(
      {
        source,
        meaning: f.meaning,
        capture,
        consumer: registered.consumer,
        snapshot: 'prepared',
      },
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
            {
              use: acquired.use,
              execution: {
                id: execution,
                start: begun.bootstrap.covered,
                ownRows: [],
              },
            },
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
    const read = {
      bootstrap: begun.bootstrap.id,
      queried: retained.queried,
      execution,
      predecessor: null,
    };
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
