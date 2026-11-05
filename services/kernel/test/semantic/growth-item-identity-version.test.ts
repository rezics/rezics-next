import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { readItemIdentityVersion } from '../../src/semantic/item-identity.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(db.pool, bundledRelease);
});

afterAll(async () => {
  await db.close();
});

type Point = { route: number; id: string; transactionId: string };

async function seedPoint(database: GrowthDatabase, route: number): Promise<Point> {
  const id = newId(route);
  const transactionId = randomUUID();
  await database.admin.query(
    `INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id, current_release)
     VALUES ($1, $2::uuid, 'schema:Person', $3::uuid, $4)`,
    [route, id, randomUUID(), bundledDigest],
  );
  await database.admin.query(
    `INSERT INTO semantic.revision(route, subject_id, revision, kind, release, recorded_transaction_id)
     VALUES ($1, $2::uuid, 1, 'create', $3, $4::uuid),
            ($1, $2::uuid, 2, 'identity', $3, $5::uuid)`,
    [route, id, bundledDigest, randomUUID(), transactionId],
  );
  return { route, id, transactionId };
}

async function seedNoise(database: GrowthDatabase, point: Point, count: number): Promise<void> {
  const data = JSON.stringify(
    Array.from({ length: count }, () => ({ source: newId(point.route), transaction_id: randomUUID() })),
  );
  await database.admin.query(
    `WITH entries AS MATERIALIZED (
       SELECT source::uuid AS source, transaction_id::uuid AS transaction_id
       FROM jsonb_to_recordset($2::jsonb) AS entry(source text, transaction_id text)
     ), created AS (
       INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id, current_release)
       SELECT $1, source, 'schema:Person', transaction_id, $3 FROM entries
       RETURNING route, subject_id, recorded_transaction_id
     ), revisions AS (
       INSERT INTO semantic.revision(route, subject_id, revision, kind, release, recorded_transaction_id)
       SELECT route, subject_id, 1, 'create', $3, recorded_transaction_id FROM created
       RETURNING route, subject_id
     )
     INSERT INTO semantic.redirect(route, subject_id, sequence, target, recorded_transaction_id)
     SELECT revisions.route, revisions.subject_id, 1, $4::uuid, entries.transaction_id
     FROM entries JOIN revisions ON revisions.route = $1 AND revisions.subject_id = entries.source`,
    [point.route, data, bundledDigest, point.id],
  );
}

async function growSubjects(database: GrowthDatabase, point: Point, scale: number, previous: number): Promise<void> {
  const data = JSON.stringify(
    Array.from({ length: scale - previous }, () => ({ id: newId(point.route), transaction_id: randomUUID() })),
  );
  await database.admin.query(
    `WITH rows AS (
       SELECT id::uuid AS id, transaction_id::uuid AS transaction_id
       FROM jsonb_to_recordset($2::jsonb) AS entry(id text, transaction_id text)
     ), subjects AS (
       INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id, current_release)
       SELECT $1, id, 'schema:Person', transaction_id, $3 FROM rows
       RETURNING route, subject_id, recorded_transaction_id
     )
     INSERT INTO semantic.revision(route, subject_id, revision, kind, release, recorded_transaction_id)
     SELECT route, subject_id, 1, 'create', $3, recorded_transaction_id FROM subjects`,
    [point.route, data, bundledDigest],
  );
}

async function growRedirects(database: GrowthDatabase, point: Point, scale: number, previous: number): Promise<void> {
  const data = JSON.stringify(
    Array.from({ length: scale - previous }, () => ({
      source: newId(point.route),
      target: newId(point.route),
      transaction_id: randomUUID(),
    })),
  );
  await database.admin.query(
    `WITH entries AS MATERIALIZED (
       SELECT source::uuid AS source, target::uuid AS target, transaction_id::uuid AS transaction_id
       FROM jsonb_to_recordset($2::jsonb) AS entry(source text, target text, transaction_id text)
     ), created AS (
       INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id, current_release)
       SELECT $1, source, 'schema:Person', transaction_id, $3 FROM entries
       RETURNING route, subject_id, recorded_transaction_id
     ), revisions AS (
       INSERT INTO semantic.revision(route, subject_id, revision, kind, release, recorded_transaction_id)
       SELECT route, subject_id, 1, 'create', $3, recorded_transaction_id FROM created
       RETURNING route, subject_id
     )
     INSERT INTO semantic.redirect(route, subject_id, sequence, target, recorded_transaction_id)
     SELECT $1, entries.source, 1, entries.target, entries.transaction_id
     FROM entries JOIN revisions ON revisions.route = $1 AND revisions.subject_id = entries.source`,
    [point.route, data, bundledDigest],
  );
}

async function growEditorialHistory(
  database: GrowthDatabase,
  point: Point,
  scale: number,
  previous: number,
): Promise<void> {
  const data = JSON.stringify(
    Array.from({ length: scale - previous }, (_, index) => ({
      revision: previous + index + 3,
      kind: ['propose', 'accept', 'adopt'][index % 3],
    })),
  );
  await database.admin.query(
    `INSERT INTO semantic.revision(route, subject_id, revision, kind, release, recorded_transaction_id)
     SELECT $1, $2::uuid, revision, kind, $3, $4::uuid
     FROM jsonb_to_recordset($5::jsonb) AS entry(revision integer, kind text)`,
    [point.route, point.id, bundledDigest, randomUUID(), data],
  );
}

async function assertMetadataPlan(database: GrowthDatabase, id: string): Promise<void> {
  const client = await database.admin.connect();
  try {
    let statement: { text: string; values: unknown[] | undefined } | undefined;
    const query = (async (query: string | QueryConfig, values?: unknown[]) => {
      const text = typeof query === 'string' ? query : query.text;
      const parameters = typeof query === 'string' ? values : query.values;
      statement = { text, values: parameters };
      return typeof query === 'string' ? client.query(query, values as unknown[]) : client.query(query);
    }) as PoolClient['query'];
    await readItemIdentityVersion({ query }, id);
    if (!statement) throw new Error('The metadata helper did not execute its point query');
    const { rows } = await database.admin.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(
      `EXPLAIN (FORMAT JSON) ${statement.text}`,
      statement.values as unknown[],
    );
    const indexes = (node: Record<string, unknown>): string[] => [
      ...(typeof node['Index Name'] === 'string' ? [node['Index Name']] : []),
      ...((node.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(indexes),
    ];
    const plan = rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(indexes(plan)).toContain('revision_identity_version');
    expect(indexes(plan)).toContain('redirect_pkey');
    expect(indexes(plan)).toContain('subject_pkey');
  } finally {
    client.release();
  }
}

test('metadata point reads stay bounded as unrelated revision history grows', async () => {
  const subjects = await seedPoint(db, 33008);
  const redirects = await seedPoint(db, 33024);
  const history = await seedPoint(db, 33040);
  await Promise.all([subjects, redirects, history].map((point) => seedNoise(db, point, 4096)));
  const scales = [64, 512, 4096] as const;

  const subjectReport = await checkGrowth(db, {
    name: 'item identity metadata with unrelated subjects',
    scales,
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => growSubjects(database, subjects, scale, previous),
    operation: async (database) => {
      const result = await readItemIdentityVersion(database.pool, subjects.id);
      expect(result).toEqual({ revision: 2, transactionId: subjects.transactionId, redirect: null });
      return result;
    },
  });
  expect(subjectReport.samples.map((sample) => sample.scale)).toEqual([...scales]);

  const redirectReport = await checkGrowth(db, {
    name: 'item identity metadata with unrelated redirects',
    scales,
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => growRedirects(database, redirects, scale, previous),
    operation: async (database) => {
      const result = await readItemIdentityVersion(database.pool, redirects.id);
      expect(result).toEqual({ revision: 2, transactionId: redirects.transactionId, redirect: null });
      return result;
    },
  });
  expect(redirectReport.samples.map((sample) => sample.scale)).toEqual([...scales]);

  const historyReport = await checkGrowth(db, {
    name: 'item identity metadata with nonidentity revision history',
    scales,
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => growEditorialHistory(database, history, scale, previous),
    operation: async (database) => {
      const result = await readItemIdentityVersion(database.pool, history.id);
      expect(result).toEqual({ revision: 2, transactionId: history.transactionId, redirect: null });
      return result;
    },
  });
  expect(historyReport.samples.map((sample) => sample.scale)).toEqual([...scales]);
  for (const report of [subjectReport, redirectReport, historyReport]) {
    expect(report.samples.map((sample) => sample.cost.statements)).toEqual([1, 1, 1]);
    expect(report.samples.map((sample) => sample.cost.rows)).toEqual([2, 2, 2]);
  }
  await assertMetadataPlan(db, history.id);
}, 240_000);
