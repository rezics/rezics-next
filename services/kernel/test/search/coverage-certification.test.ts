import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { createCoverageStore } from '../../src/search/coverage-store.ts';
import {
  createSubjectProjectionCoordinator,
  initializeSubjectIncarnation,
  readSubjectCoverage,
  type CoverageHome,
  type IndexIncarnation,
  type ProjectionOptions,
} from '../../src/search/coverage.ts';
import { createSubjectIndex, subjectAlias } from '../../src/search/indices.ts';
import { installTemplates, searchSubjects } from '../../src/search/query.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createCoverageFixture, holdBulk } from './coverage-fixture.ts';

// Certification/readonly reader only. Native alias attachment below publishes no certificate or lifecycle row.
let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

type BasisRead = { state: 'not_ready' } | { state: 'ready'; basis: { digest: string } };
async function native() {
  const path = new URL('../../src/semantic/identity-basis.ts', import.meta.url);
  expect(
    await Bun.file(path).exists(),
    'Real command/source/engine baseline passed; identity-basis.ts is required',
  ).toBe(true);
  const ports = await import(path.href);
  expect(typeof ports.readIdentityBasis).toBe('function');
  expect(typeof ports.readIdentityHome).toBe('function');
  return ports as {
    readIdentityBasis(pool: Pool, options: { deadline: number }): Promise<BasisRead>;
    readIdentityHome(client: PoolClient, partition: number): Promise<CoverageHome & { pending: bigint }>;
  };
}

async function run(config: ProjectionOptions, target: IndexIncarnation, partitions: Iterable<number>) {
  const coordinator = createSubjectProjectionCoordinator(config);
  const deadline = Date.now() + 120_000;
  for (const partition of new Set(partitions)) {
    let result;
    do {
      if (Date.now() >= deadline) throw new Error('Real guarded projector failed to reach its finite barrier');
      result = await coordinator.run(target, partition);
    } while (result.status === 'busy' || (result.status === 'read' && result.envelopes > 0));
    expect(result.status).toBe('read');
  }
}

async function populated() {
  const config = f.options(f.fresh());
  const target = await initializeSubjectIncarnation(config, 1);
  const coordinator = createSubjectProjectionCoordinator(config);
  const deadline = Date.now() + 120_000;
  while ((await coordinator.populate(target)).state === 'more') {
    if (Date.now() >= deadline) throw new Error('Actual population did not complete');
  }
  const homes = await f.admin.query<{ partition_no: number }>(
    'SELECT partition_no FROM core.partition WHERE position>0',
  );
  await run(
    config,
    target,
    homes.rows.map((row) => row.partition_no),
  );
  return { config, target, coordinator };
}

async function certified() {
  const p = await populated();
  const ports = await native();
  const before = await ports.readIdentityBasis(f.pool, { deadline: Date.now() + 30_000 });
  expect(before.state).toBe('ready');
  const certificate = await p.coordinator.certify(p.target, { deadline: Date.now() + 30_000 });
  expect(certificate.state).toBe('ready');
  if (certificate.state !== 'ready' || before.state !== 'ready')
    throw new Error('Actual native certification required');
  const after = await ports.readIdentityBasis(f.pool, { deadline: Date.now() + 30_000 });
  expect(after).toEqual(before);
  expect(certificate.basis).toEqual(before.basis);
  expect(certificate.incarnation).toEqual(p.target);
  // Attach only the ACTUAL already-certified physical target, without activate/retire or store promotion.
  await f.search.request('POST', '/_aliases', {
    actions: [{ add: { index: p.target.index, alias: subjectAlias(p.config.prefix) } }],
  });
  await installTemplates(f.search, p.config.prefix);
  expect(await readSubjectCoverage(p.config, { deadline: Date.now() + 30_000 })).toEqual(certificate);
  return { ...p, certificate, ports };
}

test('certification independently matches the full native basis, all current homes and actual core fences', async () => {
  const p = await certified();
  const store = createCoverageStore(f.pool);
  for (let partition = 0; partition < 4096; partition++) {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const home = await p.ports.readIdentityHome(client, partition);
      const core = (
        await client.query<{ epoch: number; node: string; position: string }>(
          'SELECT epoch, node, position::text FROM core.partition WHERE partition_no=$1',
          [partition],
        )
      ).rows[0]!;
      expect(home.pending).toBe(0n);
      expect(home.epoch).toBe(core.epoch);
      expect(home.home).toBe(core.node);
      const row = (await store.readHome(p.target, partition))!;
      expect(row).not.toBeNull();
      expect(row.verified).toEqual({ partition, epoch: home.epoch, home: home.home, generation: home.generation });
      expect(row.fence!.epoch).toBe(home.epoch);
      expect(row.fence!.generation).toBe(home.generation);
      expect(row.coveredThrough!.epoch).toBe(home.epoch);
      expect(row.coveredThrough!.position).toBeGreaterThanOrEqual(row.fence!.position);
      expect(row.coveredThrough!.position).toBeLessThanOrEqual(BigInt(core.position));
      if (row.attempt !== null) expect(row.attempt.outcome).toBe('completed');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  const before = await p.ports.readIdentityBasis(f.pool, { deadline: Date.now() + 30_000 });
  expect(await readSubjectCoverage(p.config, { deadline: Date.now() + 30_000 })).toEqual(p.certificate);
  expect(await p.ports.readIdentityBasis(f.pool, { deadline: Date.now() + 30_000 })).toEqual(before);
}, 180_000);

test('ordinary source lag retains the actual certificate and readonly raw hidden hit metadata', async () => {
  const ids = await f.books();
  const p = await certified();
  const before = (await f.raw(p.config.prefix)).filter((hit) => ids.includes(hit.id));
  expect(before.map((hit) => hit.id)).toEqual(ids);
  await f.post(`/v1/subjects/${ids[1]}:hide`, { reason: 'Ordinary lag after native certification' });
  await f.books(2);
  expect(await readSubjectCoverage(p.config, { deadline: Date.now() + 30_000 })).toEqual(p.certificate);
  expect((await f.raw(p.config.prefix)).filter((hit) => ids.includes(hit.id))).toEqual(before);
  expect(before.map((hit) => hit.sort)).toEqual(ids.map((id) => [id]));
  expect(before.map((hit) => hit.matched)).toEqual([['f0'], ['f0'], ['f0']]);
  expect((await f.disclosed(p.config.prefix)).passed.some(({ subject }) => subject.id === ids[1])).toBe(false);
  const readonly = {
    ...p.config,
    search: {
      ...f.search,
      async request<T>(...args: Parameters<typeof f.search.request>) {
        expect(['GET', 'HEAD']).toContain(args[0]);
        expect(args[1]).not.toMatch(/_search|_msearch|_search\/template/);
        return f.search.request<T>(...args);
      },
      async bulk<T>(): Promise<T> {
        throw new Error('Coverage reader attempted a write');
      },
    },
  };
  expect(await readSubjectCoverage(readonly, { deadline: Date.now() + 30_000 })).toEqual(p.certificate);
}, 180_000);

test('structural consumer lag remains unavailable despite native ready until actual refresh-visible consumption', async () => {
  const ids = await f.books();
  const p = await certified();
  await f.merge(ids[0]!, ids[2]!);
  await f.settleIdentity();
  const basis = await p.ports.readIdentityBasis(f.pool, { deadline: Date.now() + 30_000 });
  expect(basis.state).toBe('ready');
  expect(basis).not.toEqual({ state: 'ready', basis: p.certificate.basis });
  expect((await readSubjectCoverage(p.config, { deadline: Date.now() + 30_000 })).state).toBe('not_ready');
  expect((await f.raw(p.config.prefix)).some((hit) => hit.id === ids[0])).toBe(true);
  await run(p.config, p.target, ids.map(subjectPartition));
  expect((await p.coordinator.certify(p.target, { deadline: Date.now() + 30_000 })).state).toBe('ready');
  expect((await f.raw(p.config.prefix)).some((hit) => hit.id === ids[0])).toBe(false);
  expect((await readSubjectCoverage(p.config, { deadline: Date.now() + 30_000 })).state).toBe('ready');
}, 180_000);

test('zero-hit reader still checks physical UUID and never transfers old coverage to a recreated name', async () => {
  const p = await certified();
  const empty = await searchSubjects(f.search, p.config.prefix, {
    filter: { term: { type: 'schema:Movie' } },
    sort: 'id',
    size: 1,
  });
  expect(empty.hits).toEqual([]);
  await f.search.request('DELETE', `/${p.target.index}`);
  await createSubjectIndex(f.search, p.config.prefix, p.target.generation);
  const settings = await f.search.request<Record<string, { settings: { index: { uuid: string } } }>>(
    'GET',
    `/${p.target.index}/_settings`,
  );
  expect(settings.body[p.target.index]!.settings.index.uuid).not.toBe(p.target.uuid);
  await f.search.request('POST', '/_aliases', {
    actions: [{ add: { index: p.target.index, alias: subjectAlias(p.config.prefix) } }],
  });
  expect(
    (await searchSubjects(f.search, p.config.prefix, { filter: { match_all: {} }, sort: 'id', size: 1 })).hits,
  ).toEqual([]);
  expect((await readSubjectCoverage(p.config, { deadline: Date.now() + 30_000 })).state).toBe('not_ready');
  expect((await p.coordinator.certify(p.target, { deadline: Date.now() + 30_000 })).state).toBe('not_ready');
}, 180_000);

test('a real unresolved older-basis attempt blocks newer certification and a second guarded writer', async () => {
  const p = await certified();
  const ids = await f.books();
  const gate = holdBulk(f.search);
  const old = createSubjectProjectionCoordinator({ ...p.config, search: gate.transport }).run(
    p.target,
    subjectPartition(ids[0]),
  );
  // Attach rejection handling before scheduling more work, preserving the actual outcome for finally.
  const outcome = old.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await gate.entered;
    const row = (await createCoverageStore(f.pool).readHome(p.target, subjectPartition(ids[0])))!;
    expect(row.attempt).toMatchObject({ outcome: 'enrolled', checkpoint: 'pending' });
    await f.merge(ids[0]!, ids[2]!);
    await f.settleIdentity();
    expect((await p.ports.readIdentityBasis(f.pool, { deadline: Date.now() + 30_000 })).state).toBe('ready');
    expect((await p.coordinator.run(p.target, subjectPartition(ids[0]))).status).toBe('busy');
    expect((await p.coordinator.certify(p.target, { deadline: Date.now() + 1_000 })).state).toBe('not_ready');
    expect((await readSubjectCoverage(p.config, { deadline: Date.now() + 30_000 })).state).toBe('not_ready');
  } finally {
    gate.release();
    const result = await outcome;
    if ('error' in result) throw result.error;
  }
  await run(p.config, p.target, ids.map(subjectPartition));
  expect((await p.coordinator.certify(p.target, { deadline: Date.now() + 30_000 })).state).toBe('ready');
}, 180_000);
