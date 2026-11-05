import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { installTemplates, SEARCH_TEMPLATE } from '../../src/search/query.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createCoverageFixture, type CoverageFixtureResources } from './coverage-fixture.ts';

let database: GrowthDatabase | undefined;
let runtimeAdmin: Pool | undefined;
let search: OpenSearch | undefined;
let defaultFixture: Awaited<ReturnType<typeof createCoverageFixture>> | undefined;
let suppliedFixture: Awaited<ReturnType<typeof createCoverageFixture>> | undefined;
let defaultFixtureOpen = false;
let suppliedFixtureOpen = false;

beforeAll(async () => {
  database = await openGrowthDatabase();
  runtimeAdmin = database.openPool();
  const searchUrl = process.env.OPENSEARCH_URL;
  if (!searchUrl) throw new Error('OPENSEARCH_URL must name the real check engine');
  search = createOpenSearch(searchUrl);
}, 180_000);

afterAll(async () => {
  try {
    if (suppliedFixtureOpen) await suppliedFixture?.close();
    if (defaultFixtureOpen) await defaultFixture?.close();
  } finally {
    await database?.close();
  }
}, 180_000);

test('real coverage fixture uses caller instrumented runtime pools and preserves their ownership while existing default behavior stays compatible', async () => {
  const db = database!;
  const admin = runtimeAdmin!;
  const transport = search!;

  await expect(createCoverageFixture({ pool: db.pool } as unknown as CoverageFixtureResources)).rejects.toThrow(
    'Coverage fixture resources must include pool, admin and search together',
  );

  defaultFixture = await createCoverageFixture();
  defaultFixtureOpen = true;
  expect(defaultFixture.pool).not.toBe(db.pool);
  expect(defaultFixture.admin).not.toBe(admin);
  expect(defaultFixture.search).not.toBe(transport);
  await defaultFixture.close();
  defaultFixtureOpen = false;
  await expect(defaultFixture.pool.query('SELECT 1')).rejects.toThrow();
  await expect(defaultFixture.admin.query('SELECT 1')).rejects.toThrow();

  const databaseUrl = process.env.DATABASE_URL;
  const searchUrl = process.env.OPENSEARCH_URL;
  delete process.env.DATABASE_URL;
  delete process.env.OPENSEARCH_URL;
  try {
    suppliedFixture = await createCoverageFixture({ pool: db.pool, admin, search: transport });
    suppliedFixtureOpen = true;
  } finally {
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
    if (searchUrl === undefined) delete process.env.OPENSEARCH_URL;
    else process.env.OPENSEARCH_URL = searchUrl;
  }

  const fixture = suppliedFixture;
  expect(fixture.pool).toBe(db.pool);
  expect(fixture.admin).toBe(admin);
  expect(fixture.search).toBe(transport);

  const prefix = fixture.fresh();
  const config = fixture.options(prefix);
  expect(config.pool).toBe(db.pool);
  expect(config.search).toBe(transport);
  expect(config.source).toBe(fixture.source);
  expect(config.listing).toBe(fixture.listing);

  const ids = await fixture.books(2);
  const subject = ids[0]!;
  const measured = await capture(db, () => fixture.source.read(subjectPartition(subject), [subject]), {
    includeBackends: true,
  });
  expect(measured.value.subjects.map(({ id }) => id)).toEqual([subject]);
  expect(measured.capture.statements.some((statement) => /semantic\.subject/i.test(statement))).toBe(true);
  expect(measured.capture.plans.length).toBeGreaterThan(0);
  const cost = costOf(measured.capture);
  expect(cost.rows).toBeGreaterThan(0);
  expect(cost.relations['semantic.subject']?.rows).toBeGreaterThan(0);

  const sourceBackends = new Set(
    measured.capture.statements.flatMap((statement, index) =>
      /semantic\.subject/i.test(statement) ? [measured.capture.statementBackends?.[index]] : [],
    ),
  );
  expect([...sourceBackends].some((backend) => typeof backend === 'number')).toBe(true);

  const cleanupPrefix = fixture.fresh();
  const cleanupIndex = subjectIndexName(cleanupPrefix, 1);
  await createSubjectIndex(transport, cleanupPrefix, 1);
  await installTemplates(transport, cleanupPrefix);
  expect((await transport.request('HEAD', `/${cleanupIndex}`)).status).toBe(200);
  expect((await transport.request('GET', `/_scripts/${cleanupPrefix}${SEARCH_TEMPLATE}`)).status).toBe(200);

  await fixture.close();
  suppliedFixtureOpen = false;
  await expect(transport.request('HEAD', `/${cleanupIndex}`)).rejects.toMatchObject({ status: 404 });
  await expect(transport.request('GET', `/_scripts/${cleanupPrefix}${SEARCH_TEMPLATE}`)).rejects.toMatchObject({
    status: 404,
  });
  expect((await db.pool.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]?.ok).toBe(1);
  expect((await admin.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]?.ok).toBe(1);
}, 300_000);
