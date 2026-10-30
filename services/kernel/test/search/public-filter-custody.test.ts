import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createPublicFilterCustody, readPublicFilterConsumerCustody } from '../../src/search/public-filter-custody.ts';
import type { CustodyDefinition } from '../../src/search/public-filter-custody-contract.ts';
import { releaseDigest, RELEASE_FORMAT } from '@rezics/definitions';
import { openGrowthDatabase, capture, costOf, checkGrowth, assertGrowthAccessPaths } from '../support/growth.ts';

const pool = createPool(process.env.DATABASE_URL!);
const search = createOpenSearch(process.env.OPENSEARCH_URL!);
const prefix = `custody-${crypto.randomUUID().slice(0, 8)}`;
const indices: string[] = [];
const context = () => ({ deadline: Date.now() + 60_000 });
const cut = () => ({ observation: crypto.randomUUID() });
const registry = createPublicFilterCustody(pool);
afterAll(async () => {
  await registry.close();
  for (const index of indices) await search.request('DELETE', `/${index}`);
  await pool.end();
});
// These records exercise the trusted producer boundary only, never Source/Access permission.
function definition(): CustodyDefinition {
  const release: CustodyDefinition['meaning']['release'] = {
    format: RELEASE_FORMAT,
    catalogue: { id: 'boundary', version: '1' },
    generator: { name: 'fixture', version: '1' },
    prefixes: {},
    types: {},
    properties: {},
  };
  return {
    source: { id: crypto.randomUUID(), partition: 7, epoch: 1, configuration: 'native-boundary-fixture' },
    readDefinition: crypto.randomUUID(),
    meaning: { digest: releaseDigest(release), release, type: 'fixture' },
    capture: { filterDocument: undefined, text: undefined, sort: 'id', size: 20, after: [null, 'key'] },
    dependencyKeys: [{ kind: 'order', order: 'id' }],
  };
}
async function target() {
  const index = `${prefix}-${indices.length}`;
  await search.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
  indices.push(index);
  const settings = await search.request<Record<string, { settings: { index: { uuid: string } } }>>(
    'GET',
    `/${index}/_settings`,
  );
  return { index, uuid: settings.body[index]!.settings.index.uuid };
}
async function setup() {
  const physical = await target();
  const input = {
    definition: definition(),
    physicalTarget: physical.index,
    consumerGeneration: '1',
    projectionGeneration: '1',
  };
  const registered = await registry.register(input, search, context());
  expect(registered.status).toBe('registered');
  if (registered.status !== 'registered') throw new Error(registered.reason);
  expect(registered.consumer.incarnation).toBe(physical.uuid);
  const covered = cut();
  const opened = await registry.openPit(
    { registration: registered.registration, covered, keepAliveMs: 300_000 },
    search,
    context(),
  );
  expect(opened.status).toBe('retained');
  if (opened.status !== 'retained') throw new Error(opened.reason);
  return { ...registered, queried: opened.queried, covered, input, physical };
}
async function append(
  queried: Parameters<typeof registry.acquire>[0],
  rows = [{ original: 'original', terminal: 'terminal' }],
) {
  const acquired = await registry.acquire(queried, context());
  expect(acquired.status).toBe('acquired');
  if (acquired.status !== 'acquired') throw new Error(acquired.reason);
  const execution = { id: crypto.randomUUID(), start: cut(), ownRows: rows };
  if (queried.snapshot.kind === 'pit') {
    const actual = await search.request<{ _shards: { failed: number }; timed_out: boolean }>('POST', '/_search', {
      size: 0,
      pit: { id: queried.snapshot.pit, keep_alive: '5m' },
    });
    expect(actual.body._shards.failed).toBe(0);
    expect(actual.body.timed_out).toBe(false);
  }
  try {
    const result = await registry.appendExecution({ use: acquired.use, execution }, context());
    expect(result.status).toBe('appended');
  } finally {
    await registry.release(acquired.use, context());
  }
  return execution;
}

test('real migrated durable custody preserves immutable definition observation cut and each exact execution across process recovery and rejects tuple mutation unknown execution expiry closed or replaced registrations without borrowing live coverage', async () => {
  const n = await setup();
  const a = await append(n.queried);
  const b = await append(n.queried, [{ original: 'other-original', terminal: 'other-terminal' }]);
  (n.input.definition.capture.after as (string | null)[])[1] = 'mutated';
  Object.assign(n.input.definition.source, { configuration: 'mutated' });
  const modulePath = new URL('../../src/search/public-filter-custody.ts', import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
    import { Pool } from 'pg'; import { readPublicFilterConsumerCustody } from ${JSON.stringify(modulePath)};
    const pool = new Pool({connectionString: process.env.DATABASE_URL, max:1});
    const result = await readPublicFilterConsumerCustody(pool, JSON.parse(process.env.CUSTODY_REQUEST), {deadline:Date.now()+60000});
    console.log(JSON.stringify(result)); await pool.end();
  `,
    ],
    {
      env: { ...process.env, CUSTODY_REQUEST: JSON.stringify({ queried: n.queried, execution: a.id }) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const recoveredResult = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(recoveredResult.execution).toEqual(a);
  const recovered = createPublicFilterCustody(pool);
  for (const execution of [a, b]) {
    const joined = await readPublicFilterConsumerCustody(
      pool,
      { queried: n.queried, execution: execution.id },
      context(),
    );
    expect(joined.status).toBe('found');
    if (joined.status !== 'found') throw new Error(joined.reason);
    expect(joined.execution).toEqual(execution);
    expect(joined.covered).toEqual(n.covered);
    expect(joined.definition.capture.after).toEqual([null, 'key']);
    expect(joined.definition.source.configuration).toBe('native-boundary-fixture');
    expect(joined.cost.statements).toBe(1);
    expect(joined.cost.rows).toBeGreaterThan(0);
  }
  const diagnostic = await recovered.read({ queried: n.queried }, context());
  expect(diagnostic.status === 'found' && diagnostic.execution).toBeNull();
  expect(await recovered.read({ queried: n.queried, execution: crypto.randomUUID() }, context())).toMatchObject({
    status: 'unready',
    reason: 'execution_missing',
  });
  for (const queried of [
    { ...n.queried, consumer: { ...n.consumer, projectionGeneration: 'other' } },
    { ...n.queried, snapshot: { ...n.queried.snapshot, pit: 'invented' } },
    {
      ...n.queried,
      snapshot: {
        kind: 'prepared' as const,
        observation: n.queried.snapshot.observation,
        build: 'invented',
        generation: 1n,
      },
    },
  ])
    expect((await recovered.read({ queried }, context())).status).toBe('unready');
  const other = await setup();
  expect((await recovered.read({ queried: other.queried, execution: a.id }, context())).status).toBe('unready');
  expect((await recovered.register(n.input, search, context())).status).toBe('unready');
  const live = await recovered.openPit(
    { registration: n.registration, covered: cut(), keepAliveMs: 300_000 },
    search,
    context(),
  );
  expect(live.status).toBe('retained');
  expect((await recovered.read({ queried: n.queried }, context())).status).toBe('found');
  await recovered.closeObservation(n.queried, search, context());
  await recovered.closeObservation(n.queried, search, context());
  expect((await recovered.read({ queried: n.queried }, context())).status).toBe('unready');
  expect(live.status === 'retained' && (await recovered.read({ queried: live.queried }, context())).status).toBe(
    'found',
  );
  await recovered.retire(n.registration, context());
  expect(live.status === 'retained' && (await recovered.read({ queried: live.queried }, context())).status).toBe(
    'unready',
  );
  if (live.status === 'retained') await recovered.closeObservation(live.queried, search, context());
  const short = await registry.openPit(
    { registration: other.registration, covered: cut(), keepAliveMs: 1 },
    search,
    context(),
  );
  await Bun.sleep(10);
  expect(short.status === 'retained' && (await recovered.read({ queried: short.queried }, context())).status).toBe(
    'unready',
  );
  if (short.status === 'retained') await recovered.closeObservation(short.queried, search, context());
  await registry.closeObservation(other.queried, search, context());
  const old = await setup();
  await search.request('DELETE', `/${old.physical.index}`);
  await search.request('PUT', `/${old.physical.index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
  const replacement = await recovered.register(old.input, search, context());
  expect(replacement.status).toBe('registered');
  expect(replacement.status === 'registered' && replacement.consumer.incarnation).not.toBe(old.consumer.incarnation);
  expect((await recovered.read({ queried: old.queried }, context())).status).toBe('unready');
  await recovered.closeObservation(old.queried, search, context());
  await recovered.close();
  expect((await pool.query('SELECT 1')).rowCount).toBe(1);
}, 120_000);

test('native PIT lifecycle concurrent execution close and rollback retain exact owned references and original-terminal rows', async () => {
  const n = await setup();
  const acquired = await registry.acquire(n.queried, context());
  if (acquired.status !== 'acquired') throw new Error(acquired.reason);
  const close = registry.closeObservation(n.queried, search, context());
  // close sets a durable admission barrier; existing in-flight work may commit before drain.
  while ((await registry.read({ queried: n.queried }, context())).status === 'found') await Bun.sleep(5);
  expect((await registry.acquire(n.queried, context())).status).toBe('unready');
  const execution = {
    id: crypto.randomUUID(),
    start: cut(),
    ownRows: [{ original: 'redirected', terminal: 'winner' }],
  };
  expect((await registry.appendExecution({ use: acquired.use, execution }, context())).status).toBe('appended');
  expect(
    (await registry.appendExecution({ use: acquired.use, execution: { ...execution, ownRows: [] } }, context())).status,
  ).toBe('unready');
  await registry.release(acquired.use, context());
  await close;
  const stored = await pool.query(
    'SELECT execution FROM search.public_filter_execution WHERE partition_no=7 AND observation=$1 AND id=$2',
    [n.queried.snapshot.observation, execution.id],
  );
  expect(stored.rows[0].execution).toBeString();
  const renew = await setup();
  let entered = 0;
  let both!: () => void;
  const reached = new Promise<void>((resolve) => {
    both = resolve;
  });
  const concurrentSearch: typeof search = {
    ...search,
    async request(method, path, body, options) {
      if (path === '/_search') {
        if (++entered === 2) both();
        await reached;
      }
      return search.request(method, path, body, options);
    },
  };
  const results = await Promise.all([
    registry.renewPit(renew.queried, 60_000, concurrentSearch, context()),
    registry.renewPit(renew.queried, 60_000, concurrentSearch, context()),
  ]);
  expect(results.filter((r) => r.status === 'retained')).toHaveLength(1);
  const winner = results.find((r) => r.status === 'retained');
  if (!winner || winner.status !== 'retained') throw new Error('No CAS winner');
  expect((await registry.read({ queried: winner.queried }, context())).status).toBe('found');
  expect(winner.queried.snapshot.observation).toBe(renew.queried.snapshot.observation);
  // Native SQL rollback cannot leak an execution or reference mutation into the durable view.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE search.public_filter_observation SET state='closed' WHERE partition_no=7 AND observation=$1",
      [winner.queried.snapshot.observation],
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  expect((await registry.read({ queried: winner.queried }, context())).status).toBe('found');
  await registry.closeObservation(winner.queried, search, context());
  const prepared = await registry.retainPrepared(
    {
      registration: renew.registration,
      covered: cut(),
      build: crypto.randomUUID(),
      generation: 9007199254740993n,
      rows: [{ original: 'a', terminal: 'b' }],
      expiresAt: Date.now() + 60_000,
    },
    context(),
  );
  expect(prepared.status).toBe('retained');
  if (prepared.status !== 'retained') throw new Error(prepared.reason);
  if (prepared.queried.snapshot.kind !== 'prepared') throw new Error('Expected prepared');
  expect((await append(prepared.queried)).ownRows).toEqual([{ original: 'original', terminal: 'terminal' }]);
  expect(
    (
      await registry.read(
        { queried: { ...prepared.queried, snapshot: { ...prepared.queried.snapshot, generation: 1n } } },
        context(),
      )
    ).status,
  ).toBe('unready');
  expect(
    (
      await registry.retainPrepared(
        {
          registration: renew.registration,
          covered: cut(),
          build: prepared.queried.snapshot.build,
          generation: prepared.queried.snapshot.generation,
          rows: [],
          expiresAt: Date.now() + 60000,
        },
        context(),
      )
    ).status,
  ).toBe('unready');
  const retained = await registry.read({ queried: prepared.queried }, context());
  expect(retained.status === 'found' && retained.queried).toEqual(prepared.queried);
  await registry.closeObservation(prepared.queried, search, context());
}, 120_000);

test('native keyed custody growth includes unrelated definitions observations and executions at 64/512/4096', async () => {
  const n = await setup();
  const execution = await append(n.queried);
  const db = await openGrowthDatabase();
  try {
    for (const axis of ['registration', 'observation', 'execution']) {
      const report = await checkGrowth(db, {
        name: `public-filter-custody-${axis}`,
        scales: [64, 512, 4096],
        indexProbes: 8,
        bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        includeBackends: true,
        async grow(_db, scale) {
          if (axis === 'registration')
            await db.admin.query(
              `INSERT INTO search.public_filter_registration SELECT partition_no, md5(id || g), physical_target, consumer, definition, 'retired' FROM search.public_filter_registration CROSS JOIN generate_series(1,$1::int) g WHERE partition_no=7 AND id=$2 ON CONFLICT DO NOTHING`,
              [scale, n.registration.id],
            );
          if (axis === 'observation')
            await db.admin.query(
              `INSERT INTO search.public_filter_observation SELECT partition_no, '7:' || md5(observation || g), registration, queried, covered, expires_at, 'closed', revision, prepared_rows FROM search.public_filter_observation CROSS JOIN generate_series(1,$1::int) g WHERE partition_no=7 AND observation=$2 ON CONFLICT DO NOTHING`,
              [scale, n.queried.snapshot.observation],
            );
          if (axis === 'execution')
            await db.admin.query(
              `INSERT INTO search.public_filter_execution SELECT partition_no, observation, md5(id || g), execution FROM search.public_filter_execution CROSS JOIN generate_series(1,$1::int) g WHERE partition_no=7 AND observation=$2 AND id=$3 ON CONFLICT DO NOTHING`,
              [scale, n.queried.snapshot.observation, execution.id],
            );
        },
        async operation() {
          const result = await readPublicFilterConsumerCustody(
            db.pool,
            { queried: n.queried, execution: execution.id },
            context(),
          );
          expect(result.status).toBe('found');
        },
      });
      assertGrowthAccessPaths('public-filter-custody-keyed', report.samples, [
        'search.public_filter_registration',
        'search.public_filter_observation',
        'search.public_filter_execution',
      ]);
    }
    const measured = await capture(
      db,
      () => readPublicFilterConsumerCustody(db.pool, { queried: n.queried, execution: execution.id }, context()),
      { includeBackends: true },
    );
    const real = costOf(measured.capture);
    expect(real.statements).toBe(1);
    expect(real.rows).toBeLessThanOrEqual(64);
    expect(real.blocks).toBeLessThanOrEqual(48);
    expect(real.responseBytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
  } finally {
    await db.close();
    await registry.closeObservation(n.queried, search, context());
  }
}, 600_000);

test('full expanded negative AST text keyset and configuration are copied before native I/O; compiler keys and immutable rebinding reject tampering', async () => {
  const physical = await target();
  const d = definition();
  const property = (id: string, qualifiers: string[] = []) => ({
    iri: `https://example.test/${id}`,
    labels: { en: id },
    mappings: [],
    datatype: 'wikibase-item' as const,
    multivalued: true,
    qualifiers,
    value: {},
  });
  Object.assign(d.meaning.release, {
    types: {
      'schema:Book': {
        iri: 'https://schema.org/Book',
        labels: { en: 'Book' },
        mappings: [],
        bases: [],
        properties: ['schema:author'],
        facets: ['schema:author'],
      },
    },
    properties: { 'schema:author': property('author', ['rezics:role']), 'rezics:role': property('role') },
  });
  Object.assign(d.meaning, { digest: releaseDigest(d.meaning.release) });
  const id = crypto.randomUUID();
  const ast = {
    or: [
      { type: { in: ['schema:Book'] } },
      {
        not: {
          statement: { property: 'schema:author', in: [id], qualifiers: [{ property: 'rezics:role', in: [id] }] },
        },
      },
    ],
  };
  const text = { kind: 'term' as const, value: 'original text' };
  Object.assign(d.capture, { filterDocument: ast, text });
  Object.assign(d, {
    dependencyKeys: [
      { kind: 'type' },
      { kind: 'property', property: 'schema:author' },
      { kind: 'property', property: 'rezics:role' },
      { kind: 'order', order: 'id' },
    ],
  });
  const expected = structuredClone(d);
  const input = { definition: d, physicalTarget: physical.index, consumerGeneration: '1', projectionGeneration: '1' };
  const pending = registry.register(input, search, context());
  ast.or[0]!.type!.in[0] = 'schema:Person';
  text.value = 'mutated';
  const registered = await pending;
  if (registered.status !== 'registered') throw new Error(registered.reason);
  const opened = await registry.openPit(
    { registration: registered.registration, covered: cut(), keepAliveMs: 60000 },
    search,
    context(),
  );
  if (opened.status !== 'retained') throw new Error(opened.reason);
  const found = await registry.read({ queried: opened.queried }, context());
  expect(found.status === 'found' && found.definition).toEqual(expected);
  expect(
    (
      await registry.register(
        { ...input, definition: { ...expected, capture: { ...expected.capture, size: 1 } } },
        search,
        context(),
      )
    ).status,
  ).toBe('unready');
  expect(() =>
    registry.register(
      { ...input, definition: { ...expected, dependencyKeys: [{ kind: 'order', order: 'id' }] } },
      search,
      context(),
    ),
  ).toThrow();
  expect(await registry.read({ queried: opened.queried }, { deadline: Date.now() - 1 })).toMatchObject({
    status: 'unavailable',
    reason: 'deadline',
    cost: { statements: 0, engineRequests: 0 },
  });
  expect(
    (
      await registry.closeObservation(
        { ...opened.queried, consumer: { ...opened.queried.consumer, readDefinition: 'other' } },
        search,
        context(),
      )
    ).status,
  ).toBe('unready');
  expect((await registry.read({ queried: opened.queried }, context())).status).toBe('found');
  await registry.closeObservation(opened.queried, search, context());
});
