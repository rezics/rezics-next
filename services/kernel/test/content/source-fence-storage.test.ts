import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { readFences, type SourceFenceTuple } from '../../src/content/source-fences.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: url, max: 2 });
afterAll(() => pool.end());
const key = new Uint8Array(32).fill(7);
function tuple(external_id: string, field_group: SourceFenceTuple['field_group'] = 'summary', source = 'catalogue') {
  return { route: tupleRoute(key, source, external_id), source, external_id, field_group };
}
const target = tuple('record-1');
const partition = partitionOf(target.route);
const open = (row: SourceFenceTuple) => ({ ...row, takenDown: false, securityRevision: null });
async function insert(
  client: Pick<pg.PoolClient, 'query'>,
  row = target,
  takenDown = true,
  revision = '9007199254740993',
) {
  await client.query(
    `INSERT INTO content.source_fences
    (route,source,external_id,field_group,taken_down,security_revision) VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.route, row.source, row.external_id, row.field_group, takenDown, revision],
  );
}
async function rejected(client: pg.PoolClient, sql: string, values: unknown[], code = '23514') {
  await client.query('SAVEPOINT invalid');
  const error: unknown = await client.query(sql, values).catch((caught: unknown) => caught);
  await client.query('ROLLBACK TO SAVEPOINT invalid');
  expect(error).toMatchObject({ code });
}

// Caller owns the trusted independently anchored client. This fact read grants no API permission.
test('one independently anchored batch reads only requested exact source tuples and preserves security revision', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    expect((await readPartition(client, partition))?.partitionNo).toBe(partition);
    // Every near match has a different value, and none may close an absent exact key.
    await insert(client, { ...target, route: target.route ^ 1 }, false, '3');
    await insert(client, { ...target, source: 'unrelated' }, false, '4');
    await insert(client, { ...target, external_id: 'unrelated' }, false, '5');
    await insert(client, tuple('record-1', 'cover'), true, '6');
    expect(await readFences(client, [target])).toEqual([open(target)]);
    const unrelated = `SELECT * FROM content.source_fences
      WHERE NOT (route=$1 AND source=$2 AND external_id=$3 AND field_group IN ('summary','facts'))
      ORDER BY route,source,external_id,field_group`;
    const identity = [target.route, target.source, target.external_id];
    const before = (await client.query(unrelated, identity)).rows;
    await insert(client);
    await insert(client, tuple('record-1', 'facts'), false, '9223372036854775807');
    const requested = [tuple('record-1', 'facts'), target, target];
    let statements = 0;
    const observed = {
      query: (async (text: string, values: unknown[]) => {
        statements++;
        const result = await client.query(text, values);
        // Keyed correspondence must survive arbitrary driver row order.
        return { ...result, rows: result.rows.toReversed() };
      }) as pg.PoolClient['query'],
    };
    expect(await readFences(observed, requested)).toEqual([
      { ...requested[0]!, takenDown: false, securityRevision: '9223372036854775807' },
      { ...target, takenDown: true, securityRevision: '9007199254740993' },
      { ...target, takenDown: true, securityRevision: '9007199254740993' },
    ]);
    expect(statements).toBe(1);
    await client.query(
      `UPDATE content.source_fences SET taken_down=false,security_revision=9007199254740994
      WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4`,
      Object.values(target),
    );
    expect(await readFences(client, [target])).toEqual([
      { ...target, takenDown: false, securityRevision: '9007199254740994' },
    ]);
    expect((await client.query(unrelated, identity)).rows).toEqual(before);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('absent tuple is open and field groups share tuple route', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await readPartition(client, partition);
    const requested = ['summary', 'facts', 'cover'].map((group) =>
      tuple('record-1', group as SourceFenceTuple['field_group']),
    );
    expect(new Set(requested.map((row) => row.route)).size).toBe(1);
    expect(target.route).toBe(tupleRoute(key, target.source, target.external_id));
    expect(await readFences(client, requested)).toEqual(requested.map(open));
    const hundred = Array.from({ length: 100 }, hotTuple);
    expect(new Set(hundred.map((row) => row.route)).size).toBeGreaterThan(1);
    expect(await readFences(client, hundred)).toEqual(hundred.map(open));
    expect(await readFences(client, [])).toEqual([]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('invalid, cross-route, mixed-partition and oversized batches fail before SQL', async () => {
  let statements = 0;
  const client = {
    query: (async () => {
      statements++;
      throw new Error('Unexpected SQL');
    }) as pg.PoolClient['query'],
  };
  for (const rows of [
    Array(101).fill(target),
    [target, { ...target, route: target.route ^ 16 }],
    [target, { ...target, route: target.route ^ 1, field_group: 'facts' }],
    ...[-1, 65536, 1.5, NaN].map((route) => [{ ...target, route }]),
    ...['', 'Upper', 'bad\nsource', 'source\n', 'source\u2028', 'x'.repeat(33)].map((source) => [
      { ...target, source },
    ]),
    ...['', 'a\nb', 'a\u0085b', '\ud800', 'x'.repeat(1025), 'é'.repeat(513)].map((external_id) => [
      { ...target, external_id },
    ]),
    [{ ...target, field_group: 'unknown' }],
    [null],
  ]) {
    await expect(readFences(client, rows as readonly SourceFenceTuple[])).rejects.toThrow(RangeError);
  }
  expect(statements).toBe(0);
});

test('native storage keeps exact identity and monotonic bigint revision through updates', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insert(client);
    expect(
      (
        await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='content.source_fences'::regclass AND contype='p'`)
      ).rows,
    ).toEqual([{ definition: 'PRIMARY KEY (route, source, external_id, field_group)' }]);
    const where = ' WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4';
    for (const change of [
      'route=route # 1',
      "source='other'",
      "external_id='other'",
      "field_group='facts'",
      'security_revision=0',
      'security_revision=9007199254740992',
      'taken_down=false',
    ])
      await rejected(client, `UPDATE content.source_fences SET ${change}${where}`, Object.values(target));
    await rejected(client, `DELETE FROM content.source_fences${where}`, Object.values(target));
    for (const row of [
      { ...target, route: -1 },
      { ...target, route: 65536 },
      { ...target, source: 'Upper' },
      { ...target, external_id: '' },
      { ...target, external_id: 'x'.repeat(1025) },
      { ...target, external_id: 'é'.repeat(513) },
      { ...target, external_id: 'a\nb' },
      { ...target, external_id: 'a\u0085b' },
      { ...target, field_group: 'unknown' },
    ])
      await rejected(client, `INSERT INTO content.source_fences VALUES ($1,$2,$3,$4,true,1)`, Object.values(row));
    await rejected(
      client,
      `INSERT INTO content.source_fences VALUES ($1,$2,$3,$4,true,0)`,
      Object.values(tuple('invalid-revision')),
    );
    await rejected(
      client,
      `INSERT INTO content.source_fences VALUES ($1,$2,$3,$4,true,1)`,
      Object.values(target),
      '23505',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

// Real tupleRoute homes, including many records in this same source and partition.
let next = 0;
function hotTuple() {
  for (;;) {
    const row = tuple(`growth-${next++}`);
    if (partitionOf(row.route) === partition) return row;
  }
}
const population: Population = {
  name: 'source-fences',
  hotPartition: partition,
  hotShare: 1,
  rows: ({ ordinal }) => ({
    'content.source_fences': [hotTuple(), tuple(`other-${ordinal}`, 'summary', 'other')].flatMap((row) =>
      (['facts', 'summary', 'cover'] as const).map((field_group) => ({
        ...row,
        field_group,
        taken_down: true,
        security_revision: '1',
      })),
    ),
  }),
};

test('checkGrowth proves no source partition or catalogue scan', async () => {
  const db = await openGrowthDatabase(url);
  const client = await db.openPool({ max: 1 }).connect();
  try {
    await insert(db.admin);
    await insert(db.admin, tuple('record-1', 'facts'), false, '2');
    await client.query('BEGIN READ ONLY');
    await readPartition(client, partition);
    const requested = [target, tuple('record-1', 'facts'), tuple('record-1', 'cover')];
    const expected = [
      { ...target, takenDown: true, securityRevision: '9007199254740993' },
      { ...requested[1]!, takenDown: false, securityRevision: '2' },
      open(requested[2]!),
    ];
    const report = await checkGrowth(db, {
      name: 'exact source fence batch',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (_db, scale, previous) => {
        await seed(db, population, { from: previous, to: scale });
      },
      operation: async () => {
        // The caller already anchored this live client; only the storage batch is measured here.
        expect(await readFences(client, requested)).toEqual(expected);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    expect(report.samples.every((sample) => sample.cost.statements === 1)).toBe(true);
    expect(
      report.samples.every((sample) =>
        Object.keys(sample.cost.relations ?? {}).every(
          (name) => name === 'content.source_fences' || name.startsWith('index:source_fences'),
        ),
      ),
    ).toBe(true);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await db.close();
  }
}, 90_000);
