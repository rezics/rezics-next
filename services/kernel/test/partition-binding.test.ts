import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { checkKeys, checkSqlFiles, checkStatement, exemption, type Binding } from './support/partition-binding.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
});

const fixtures = `
  CREATE SCHEMA fixture;
  CREATE TABLE fixture.subject (route integer NOT NULL, subject_id uuid NOT NULL, sort_key text NOT NULL,
    PRIMARY KEY (route, subject_id));
  CREATE INDEX subject_page ON fixture.subject (route, sort_key, subject_id);
  CREATE TABLE fixture.fact (route integer NOT NULL, subject_id uuid NOT NULL, slot_id uuid NOT NULL, value jsonb,
    PRIMARY KEY (route, subject_id, slot_id));
  CREATE TABLE fixture.log (partition_no integer NOT NULL, position bigint NOT NULL, payload jsonb NOT NULL,
    PRIMARY KEY (partition_no, position));
`;

async function withFixtures<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fixtures);
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const route: Binding = { bound: true, parameter: 'route' };
const partition: Binding = { bound: true, parameter: 'partition_no' };
const statements: [string, string, string[], Binding | { bound: false }][] = [
  [
    'anchored read',
    'SELECT sort_key FROM fixture.subject WHERE route = $1 AND subject_id = $2',
    ['route', 'subject_id'],
    route,
  ],
  [
    'same-partition join',
    `SELECT f.value FROM fixture.subject s JOIN fixture.fact f ON f.route = s.route AND f.subject_id = s.subject_id
     WHERE s.route = $1 AND s.subject_id = $2`,
    ['route', 'subject_id'],
    route,
  ],
  [
    'correlated subquery',
    `SELECT sort_key FROM fixture.subject s WHERE route = $1 AND EXISTS
     (SELECT 1 FROM fixture.fact f WHERE f.route = s.route AND f.subject_id = s.subject_id AND f.value = $2)`,
    ['route', 'value'],
    route,
  ],
  [
    'insert of parameters',
    'INSERT INTO fixture.fact (route, subject_id, slot_id) VALUES ($1, $2, $3)',
    ['route', 'subject_id', 'slot_id'],
    route,
  ],
  [
    'insert of a set',
    `INSERT INTO fixture.fact (route, subject_id, slot_id, value)
     SELECT $1, $2, e.slot_id, e.value FROM jsonb_to_recordset($3) AS e(slot_id uuid, value jsonb)`,
    ['route', 'subject_id', 'facts'],
    route,
  ],
  [
    'update',
    'UPDATE fixture.subject SET sort_key = $3 WHERE route = $1 AND subject_id = $2',
    ['route', 'subject_id', 'sort_key'],
    route,
  ],
  [
    'partition page',
    `SELECT subject_id, sort_key FROM fixture.subject
     WHERE route >= $1 * 16 AND route < ($1 + 1) * 16 AND (sort_key, subject_id) > ($2, $3)
     ORDER BY sort_key, subject_id LIMIT 50`,
    ['partition_no', 'sort_key', 'subject_id'],
    partition,
  ],
  [
    'fence and log',
    `WITH fence AS (UPDATE core.partition SET position = position + 1
       WHERE partition_no = $1 AND write_state = 'active' RETURNING epoch, position)
     INSERT INTO fixture.log (partition_no, position, payload) SELECT $1, fence.position, $2 FROM fence
     RETURNING position`,
    ['partition_no', 'payload'],
    partition,
  ],
  ['no authoritative table', 'SELECT now()', [], { bound: true, parameter: null }],
  ['filter off the key', 'SELECT route FROM fixture.subject WHERE sort_key = $1', ['sort_key'], { bound: false }],
  ['several routes', 'SELECT sort_key FROM fixture.subject WHERE route IN ($1, $2)', ['a', 'b'], { bound: false }],
  [
    'two parameters',
    'SELECT s.sort_key, f.value FROM fixture.subject s, fixture.fact f WHERE s.route = $1 AND f.route = $2',
    ['a', 'b'],
    { bound: false },
  ],
  [
    'arbitrary range',
    'SELECT sort_key FROM fixture.subject WHERE route >= $1 AND route < $2',
    ['a', 'b'],
    { bound: false },
  ],
  [
    'mismatched range',
    'SELECT sort_key FROM fixture.subject WHERE route >= $1 * 16 AND route < ($2 + 1) * 16',
    ['a', 'b'],
    { bound: false },
  ],
  [
    'range of another width',
    'SELECT sort_key FROM fixture.subject WHERE route >= $1 * 8 AND route < ($1 + 1) * 8',
    ['a'],
    { bound: false },
  ],
  ['whole table', 'SELECT partition_no FROM core.partition', [], { bound: false }],
  [
    'insert of several rows',
    'INSERT INTO fixture.fact (route, subject_id, slot_id) VALUES ($1, $2, $3), ($4, $5, $6)',
    ['a', 'b', 'c', 'd', 'e', 'f'],
    { bound: false },
  ],
  [
    'insert of a computed route',
    'INSERT INTO fixture.fact (route, subject_id, slot_id) VALUES ($1 + 1, $2, $3)',
    ['route', 'subject_id', 'slot_id'],
    { bound: false },
  ],
  ['delete off the key', 'DELETE FROM fixture.fact WHERE subject_id = $1', ['subject_id'], { bound: false }],
];

test('generic plans decide whether a statement is bound to one partition', async () => {
  const results = await withFixtures(async (client) => {
    const verdicts: Record<string, Binding> = {};
    for (const [name, sql, params] of statements) verdicts[name] = await checkStatement(client, { sql, params });
    return verdicts;
  });
  for (const [name, , , expected] of statements)
    expect({ name, ...results[name] }).toMatchObject({ name, ...expected });
  for (const [name, , , expected] of statements)
    if (!expected.bound) expect(results[name]).toEqual({ bound: false, reason: expect.any(String) });
});

test('every primary key and unique index leads with route or partition_no', async () => {
  expect(await checkKeys(pool)).toEqual([]);
  const violations = await withFixtures(async (client) => {
    await client.query(`
      CREATE TABLE fixture.unkeyed (route integer NOT NULL, label text);
      CREATE TABLE fixture.misled (id uuid PRIMARY KEY, route integer NOT NULL);
      CREATE TABLE fixture.labelled (route integer NOT NULL, id uuid NOT NULL, label text NOT NULL,
        PRIMARY KEY (route, id), UNIQUE (label));
      CREATE UNIQUE INDEX labelled_route_label ON fixture.labelled (route, label);
    `);
    return checkKeys(client);
  });
  expect(violations).toEqual(['fixture.labelled_label_key', 'fixture.misled_pkey', 'fixture.unkeyed']);
});

test('an exemption is a first-line comment that gives its reason', () => {
  expect(exemption('-- unbound: loads the route map\nSELECT partition_no FROM core.partition')).toBe(
    'loads the route map',
  );
  expect(exemption('SELECT 1')).toBeNull();
  expect(exemption('-- unbound:\nSELECT 1')).toBeNull();
  expect(exemption('SELECT 1\n-- unbound: too late')).toBeNull();
});

test('every statement under src is bound to one partition or exempt with a reason', async () => {
  const client = await pool.connect();
  try {
    const results = await checkSqlFiles(client, new URL('../src/', import.meta.url).pathname);
    expect(results).toContainEqual({ file: 'partition/read.sql', binding: partition });
    expect(results.filter((result) => 'bound' in result.binding && !result.binding.bound)).toEqual([]);
  } finally {
    client.release();
  }
});
