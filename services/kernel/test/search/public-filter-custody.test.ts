import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createPublicFilterCustody, readPublicFilterConsumerCustody } from '../../src/search/public-filter-custody.ts';
import type { CustodyDefinition } from '../../src/search/public-filter-custody-contract.ts';
import { releaseDigest, RELEASE_FORMAT, RELEASE_LIMITS, releaseAdmission, validateRelease } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId } from '../../src/route/route.ts';
import { createRealAccess } from '../semantic/real-access.ts';
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
  const c = await append(n.queried, []);
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
  for (const execution of [a, b, c]) {
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
  await append(other.queried);
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
  if (other.queried.snapshot.kind !== 'pit') throw new Error('Expected native PIT');
  await search.request('DELETE', '/_search/point_in_time', { pit_id: [other.queried.snapshot.pit] });
  expect((await registry.renewPit(other.queried, 60000, search, context())).status).toBe('unready');
  expect((await recovered.read({ queried: other.queried }, context())).status).toBe('unready');
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
  const close = registry.closeObservation(n.queried, search, { deadline: Date.now() + 90_000 });
  // close sets a durable admission barrier; existing in-flight work may commit before drain.
  while ((await registry.read({ queried: n.queried }, context())).status === 'found') await Bun.sleep(5);
  expect((await registry.acquire(n.queried, context())).status).toBe('unready');
  const execution = {
    id: crypto.randomUUID(),
    start: cut(),
    ownRows: [{ original: 'redirected', terminal: 'winner' }],
  };
  expect((await registry.appendExecution({ use: acquired.use, execution }, context())).status).toBe('appended');
  expect((await registry.appendExecution({ use: acquired.use, execution }, context())).status).toBe('appended');
  expect(
    (await registry.appendExecution({ use: acquired.use, execution: { ...execution, ownRows: [] } }, context())).status,
  ).toBe('unready');
  await registry.release(acquired.use, context());
  expect((await close).status).toBe('closed');
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
  const cleanup: unknown[] = [];
  const concurrentSearch: typeof search = {
    ...search,
    async request<T>(
      method: Parameters<typeof search.request>[0],
      path: string,
      body?: unknown,
      options?: Parameters<typeof search.request>[3],
    ) {
      if (path === '/_search') {
        if (++entered === 2) both();
        await reached;
      }
      const result = await search.request<T>(method, path, body, options);
      if (method === 'DELETE') cleanup.push(result.body);
      return result;
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
  await pool.query(
    `ALTER TABLE search.public_filter_observation ADD CONSTRAINT custody_test_rollback CHECK (registration <> '${renew.registration.id}') NOT VALID`,
  );
  try {
    const failed = await registry.openPit(
      { registration: renew.registration, covered: cut(), keepAliveMs: 60000 },
      concurrentSearch,
      context(),
    );
    expect(failed.status).toBe('unavailable');
    expect(cleanup).toMatchObject([{ pits: [{ successful: true }] }]);
  } finally {
    await pool.query('ALTER TABLE search.public_filter_observation DROP CONSTRAINT custody_test_rollback');
  }
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
}, 120_000);

test('native close revalidates a held obsolete maximum after another factory releases the actual long last use', async () => {
  const n = await setup();
  const unrelated = await setup();
  const releaser = createPublicFilterCustody(pool);
  const leaseDeadline = Date.now() + 300_000;
  const acquired = await registry.acquire(n.queried, { deadline: leaseDeadline });
  if (acquired.status !== 'acquired') throw new Error(acquired.reason);
  let reached!: () => void;
  let deliver!: () => void;
  const maximumRead = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const delivery = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  let held = false;
  let referenceReads = 0;
  const db = await openGrowthDatabase();
  const heldPool = new Proxy(db.pool, {
    get(target, key) {
      if (key === 'query')
        return async (query: string, values?: unknown[]) => {
          // Execute the real statement first. The pool has returned its checkout before delivery is held.
          const result = await target.query(query, values);
          if (query.includes('SELECT expires_at FROM search.public_filter_reference')) {
            referenceReads++;
            if (!held) {
              held = true;
              expect(Number(result.rows[0].expires_at)).toBe(leaseDeadline);
              reached();
              await delivery;
            }
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const closer = createPublicFilterCustody(heldPool);
  const deleted: unknown[] = [];
  const observedSearch: typeof search = {
    ...search,
    async request<T>(
      method: Parameters<typeof search.request>[0],
      path: string,
      body?: unknown,
      options?: Parameters<typeof search.request>[3],
    ) {
      if (method === 'DELETE') deleted.push(body);
      return search.request<T>(method, path, body, options);
    },
  };
  const deadline = Date.now() + 5_000;
  const measuredClose = capture(db, () => closer.closeObservation(n.queried, observedSearch, { deadline }), {
    includeBackends: true,
  });
  const closing = measuredClose.then((measured) => measured.value);
  try {
    await maximumRead;
    expect((await registry.acquire(n.queried, context())).status).toBe('unready');
    expect((await releaser.release(acquired.use, context())).status).toBe('released');
    expect(
      (
        await pool.query('SELECT token FROM search.public_filter_reference WHERE partition_no=7 AND observation=$1', [
          n.queried.snapshot.observation,
        ])
      ).rowCount,
    ).toBe(0);
    deliver();
    const result = await closing;
    expect(result.status).toBe('closed');
    expect(Date.now()).toBeLessThan(deadline);
    expect(Date.now()).toBeLessThan(leaseDeadline);
    expect(referenceReads).toBeGreaterThanOrEqual(2);
    expect(result.cost.statements).toBeLessThanOrEqual(12);
    expect(result.cost.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.cost.engineRequests).toBe(1);
    const nativeClose = costOf((await measuredClose).capture);
    expect(nativeClose.statements).toBeLessThanOrEqual(12);
    expect(nativeClose.requestBytes! + nativeClose.responseBytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
    if (n.queried.snapshot.kind !== 'pit') throw new Error('Expected native PIT');
    expect(deleted).toEqual([{ pit_id: [n.queried.snapshot.pit] }]);
    expect((await registry.read({ queried: unrelated.queried }, context())).status).toBe('found');
    await append(unrelated.queried);
  } finally {
    deliver();
    await closing;
    await closer.close();
    await db.close();
    await releaser.close();
    await registry.closeObservation(n.queried, search, context());
    await registry.closeObservation(unrelated.queried, search, context());
  }
}, 120_000);

test('live uses forbid native deletion, expired uses drain, and a deadline or lost close delivery recovers only its owned PIT', async () => {
  const n = await setup();
  const unrelated = await setup();
  const acquired = await registry.acquire(n.queried, { deadline: Date.now() + 60_000 });
  if (acquired.status !== 'acquired') throw new Error(acquired.reason);
  const closed = await registry.closeObservation(n.queried, search, { deadline: Date.now() + 250 });
  expect(closed).toMatchObject({ status: 'unavailable', reason: 'deadline', cost: { engineRequests: 0 } });
  expect(closed.cost.statements).toBeLessThanOrEqual(12);
  if (n.queried.snapshot.kind !== 'pit') throw new Error('Expected native PIT');
  const probe = await search.request<{ _shards: { failed: number } }>('POST', '/_search', {
    size: 0,
    pit: { id: n.queried.snapshot.pit, keep_alive: '1m' },
  });
  expect(probe.body._shards.failed).toBe(0);
  expect((await registry.acquire(n.queried, context())).status).toBe('unready');
  expect((await registry.release(acquired.use, context())).status).toBe('released');
  const recovered = createPublicFilterCustody(pool);
  let lostDelivery = false;
  const lossySearch: typeof search = {
    ...search,
    async request<T>(
      method: Parameters<typeof search.request>[0],
      path: string,
      body?: unknown,
      options?: Parameters<typeof search.request>[3],
    ) {
      const result = await search.request<T>(method, path, body, options);
      if (method === 'DELETE' && !lostDelivery) {
        lostDelivery = true;
        throw new Error('Injected loss after actual native close');
      }
      return result;
    },
  };
  try {
    expect(await recovered.closeObservation(n.queried, lossySearch, context())).toMatchObject({
      status: 'unavailable',
      reason: 'owner_unavailable',
    });
    expect((await recovered.closeObservation(n.queried, search, context())).status).toBe('closed');
    const expired = await registry.acquire(unrelated.queried, { deadline: Date.now() + 200 });
    if (expired.status !== 'acquired') throw new Error(expired.reason);
    // This is the separate expiry positive, not the early-release control above.
    const draining = await recovered.closeObservation(unrelated.queried, search, context());
    expect(draining.status).toBe('closed');
    expect(draining.cost.statements).toBeLessThanOrEqual(12);
    expect(
      (
        await pool.query('SELECT token FROM search.public_filter_reference WHERE partition_no=7 AND observation=$1', [
          unrelated.queried.snapshot.observation,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    await recovered.close();
    await registry.closeObservation(n.queried, search, context());
    await registry.closeObservation(unrelated.queried, search, context());
  }
}, 120_000);

// A real admitted catalogue at the release authority's byte boundary, retaining the entire bundled grammar.
// Extra released reference properties carry native schemas and descriptions, not a fixture-only empty release.
function wideRelease() {
  const release = structuredClone(bundledRelease);
  release.catalogue = { ...release.catalogue, version: crypto.randomUUID() };
  release.prefixes.custody = 'https://example.test/custody/';
  release.types['schema:Book']!.properties.push('custody:reference0');
  release.types['schema:Book']!.facets.push('custody:reference0');
  let bytes = Buffer.byteLength(JSON.stringify(release));
  let last = '';
  for (let index = 0; index < RELEASE_LIMITS.properties; index++) {
    const key = `custody:reference${index}`;
    const property = {
      iri: `https://example.test/custody/reference${index}`,
      labels: { en: `Catalogue reference ${index}` },
      mappings: [],
      datatype: 'wikibase-item' as const,
      multivalued: true,
      targets: ['schema:CreativeWork'],
      qualifiers: ['wdt:P3831'],
      value: structuredClone(release.properties['schema:publisher']!.value),
      descriptions: {
        en: (
          `Reference ${index} identifies the related catalogue work. The role qualifier records ` +
          'the association independently from its target; filters preserve this association and the released value schema. '
        ).repeat(7),
      },
    };
    const added = Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(property)) + 2;
    if (bytes + added > RELEASE_LIMITS.bytes) {
      expect(releaseAdmission({ ...release, properties: { ...release.properties, [key]: property } })).toContainEqual({
        pointer: '',
        code: 'limit',
      });
      break;
    }
    release.properties[key] = property;
    last = key;
    bytes += added;
  }
  expect(bytes).toBe(Buffer.byteLength(JSON.stringify(release)));
  expect(bytes).toBeGreaterThan(RELEASE_LIMITS.bytes - 2_000);
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(validateRelease(release)).toEqual([]);
  return { release, last, bytes };
}

test('accepted native wide release capture and cold keyed recovery retain full immutable meaning and grammar within original byte allowances', async () => {
  const { release, last } = wideRelease();
  // Publish through real authorization and the ordinary immutable release command, not custody fixture rows.
  const access = await createRealAccess(pool, { publisher: newId(0) }, ['definitions:publish', 'definitions:read']);
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'publisher', 'definitions:publish');
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'publisher', 'gate:definition_publication');
  const kernel = createKernel({
    pool,
    access: access.access,
    writeRate: access.writeRate,
    routeKey: new Uint8Array(32).fill(8),
  });
  const published = await kernel.handle(
    new Request('http://kernel.test/v1/definitions/releases', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access.bearer('publisher')}`,
        'idempotency-key': `"${crypto.randomUUID()}"`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ release }),
    }),
  );
  expect(published.status).toBe(201);
  const identity = (await published.json()) as { digest: string };
  expect(identity.digest).toBe(releaseDigest(release));
  const physical = await target();
  const d = definition();
  const subject = crypto.randomUUID();
  const meaning = { release, digest: identity.digest, type: 'schema:Book' };
  const filterDocument = {
    and: [
      { type: { in: ['schema:Book'] } },
      { not: { statement: { property: 'schema:author', in: [subject] } } },
      {
        statement: {
          property: 'custody:reference0',
          in: [subject],
          qualifiers: [{ property: 'wdt:P3831', in: [subject] }],
        },
      },
    ],
  };
  const definitionInput: CustodyDefinition = {
    ...d,
    meaning,
    capture: { ...d.capture, filterDocument, text: { kind: 'term', value: 'wide native catalogue' } },
    dependencyKeys: [
      { kind: 'type' },
      { kind: 'order', order: 'id' },
      { kind: 'property', property: 'schema:author' },
      { kind: 'property', property: 'wdt:P3831' },
      { kind: 'property', property: 'custody:reference0' },
    ],
  };
  const expected = structuredClone(definitionInput);
  const db = await openGrowthDatabase();
  const custody = createPublicFilterCustody(db.pool);
  let retained: Parameters<typeof registry.read>[0] | undefined;
  try {
    const captureOperation = await capture(
      db,
      () =>
        custody.register(
          {
            definition: definitionInput,
            physicalTarget: physical.index,
            consumerGeneration: 'wide',
            projectionGeneration: '1',
          },
          search,
          context(),
        ),
      { includeBackends: true },
    );
    const registered = captureOperation.value;
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const nativeCapture = costOf(captureOperation.capture);
    expect(registered.cost.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(nativeCapture.requestBytes! + nativeCapture.responseBytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(registered.cost.statements).toBeLessThanOrEqual(12);
    expect(captureOperation.capture.statements.some((sql) => sql.includes('semantic.definition_release'))).toBe(true);
    const stored = await pool.query(
      'SELECT octet_length(definition) AS bytes FROM search.public_filter_registration WHERE partition_no=$1 AND id=$2',
      [registered.registration.partition, registered.registration.id],
    );
    expect(stored.rows[0].bytes).toBeLessThanOrEqual(1024 * 1024);
    const opened = await custody.openPit(
      { registration: registered.registration, covered: cut(), keepAliveMs: 300_000 },
      search,
      context(),
    );
    if (opened.status !== 'retained') throw new Error(opened.reason);
    const execution = await append(opened.queried);
    retained = { queried: opened.queried, execution: execution.id };
    // Mutating the complete input cannot replace either the authority or any retained AST/key/capture field.
    definitionInput.meaning.release.properties[last]!.labels.en = 'mutated';
    const joined = await capture(db, () => custody.read(retained!, context()), { includeBackends: true });
    if (joined.value.status !== 'found') throw new Error(joined.value.reason);
    const reference = { authority: 'semantic.readRelease' as const, digest: identity.digest };
    expect(joined.value.definition).toEqual({ ...expected, meaning: { ...expected.meaning, release: reference } });
    expect(joined.value.execution).toEqual(execution);
    expect(joined.value.cost.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    const nativeJoin = costOf(joined.capture);
    expect(nativeJoin.requestBytes! + nativeJoin.responseBytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(nativeJoin.rows).toBeLessThanOrEqual(64);
    expect(nativeJoin.blocks).toBeLessThanOrEqual(48);
    expect(joined.capture.statements.some((sql) => sql.includes('semantic.definition_release'))).toBe(true);
    await custody.close();
    const modulePath = new URL('../../src/search/public-filter-custody.ts', import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { Pool } from 'pg';
      import { readPublicFilterConsumerCustody } from ${JSON.stringify(modulePath)};
      const pool = new Pool({connectionString: process.env.DATABASE_URL, max:1});
      const result = await readPublicFilterConsumerCustody(pool, JSON.parse(process.env.CUSTODY_REQUEST), {deadline:Date.now()+60000});
      console.log(JSON.stringify(result)); await pool.end();
    `,
      ],
      {
        env: { ...process.env, CUSTODY_REQUEST: JSON.stringify(retained) },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    const recovered = JSON.parse(stdout);
    expect(recovered.status).toBe('found');
    expect(recovered.definition).toEqual(joined.value.definition);
    expect(recovered.execution).toEqual(execution);
    expect(recovered.cost.statements).toBeGreaterThanOrEqual(2);
    expect(recovered.cost.statements).toBeLessThanOrEqual(12);
    expect(recovered.cost.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    // The reference still locates the complete original admitted meaning, including unused grammar.
    const authority = await pool.query('SELECT body FROM semantic.definition_release WHERE route=0 AND digest=$1', [
      identity.digest,
    ]);
    expect(authority.rows[0].body).toEqual(expected.meaning.release);
    expect(releaseDigest(authority.rows[0].body)).toBe(reference.digest);
    expect((await registry.read({ queried: opened.queried, execution: crypto.randomUUID() }, context())).status).toBe(
      'unready',
    );
  } finally {
    if (retained) await registry.closeObservation(retained.queried, search, context());
    await custody.close();
    await db.close();
  }
}, 600_000);
