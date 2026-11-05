import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { derivedId } from '../../src/route/route.ts';
import { checkGrowth, GrowthBoundError, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: url, max: 2 });
afterAll(() => pool.end());
const route = 0x1234;
const namespace = '00000000-0000-8000-8000-000000000001';
const id = (name: string, selectedRoute = route) => derivedId(namespace, name, selectedRoute);
const time = new Date('2030-01-02T00:00:00.000Z');
const thread = id('thread');
const author = id('author', 0x5678);
const board = id('board', 0x9abc);
const body = Buffer.from('canonical revision bytes');
const metadata = { visibility: 'published', security_revision: 1, recorded_transaction_id: id('transaction') };
const threadRow = {
  route,
  thread_id: thread,
  author_account_id: author,
  board_id: board,
  title: 'Title',
  ...metadata,
  created_at: time,
  first_post_id: id('post-0'),
  availability: 'available',
};
function postRow(ordinal: number) {
  return {
    route,
    thread_id: thread,
    post_id: id(`post-${ordinal}`),
    reply_to_post_id: null,
    author_account_id: ordinal < 16 ? author : id('unrelated-author'),
    head_revision_id: id(`revision-${ordinal}`),
    ...metadata,
    created_at: time,
    availability: 'available',
  };
}
function revisionRow(ordinal: number, post_id = id(`post-${ordinal}`), revision_id = id(`revision-${ordinal}`)) {
  return {
    route,
    thread_id: thread,
    post_id,
    revision_id,
    body,
    body_sha256: createHash('sha256').update(body).digest(),
    search_text: 'canonical revision bytes',
    licence: 'CC-BY-SA-4.0',
    subject_ids: [id('subject', 0xdef0)],
    media_ids: [id('media')],
    board_id: board,
    availability: 'available',
    recorded_transaction_id: id(`transaction-${ordinal}`),
    recorded_at: time,
  };
}
async function fixture(work: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO content.board
      (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id, created_at)
      VALUES ($1,$2,$3,'Board','draft',1,$4,$5)`,
      [0x9abc, board, id('subject'), id('transaction'), time],
    );
    for (const [table, row] of [
      ['thread', threadRow],
      ['post', postRow(0)],
      ['revision', revisionRow(0)],
    ] as const) {
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO content.${table} (${columns.join(',')}) VALUES
        (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
        Object.values(row),
      );
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
async function rejected(client: pg.PoolClient, sql: string, values: unknown[] = [], code = '23514') {
  await client.query('SAVEPOINT invalid');
  const error: unknown = await client.query(sql, values).catch((caught: unknown) => caught);
  await client.query('ROLLBACK TO SAVEPOINT invalid');
  expect(error).toMatchObject({ code });
}

test('stable creation keys, canonical visibility and same-thread deferred first pointer', async () => {
  await fixture(async (client) => {
    for (const [table, column, key, selectedRoute] of [
      ['board', 'board_id', board, 0x9abc],
      ['thread', 'thread_id', thread, route],
      ['post', 'post_id', id('post-0'), route],
    ] as const) {
      expect(
        (
          await client.query(`SELECT created_at FROM content.${table} WHERE route=$1 AND ${column}=$2`, [
            selectedRoute,
            key,
          ])
        ).rows,
      ).toEqual([{ created_at: time }]);
      await rejected(
        client,
        `UPDATE content.${table} SET created_at=created_at + interval '1 second' WHERE route=$1 AND ${column}=$2`,
        [selectedRoute, key],
      );
      for (const visibility of ['draft', 'protected', 'taken_down', 'published']) {
        await client.query(
          `UPDATE content.${table} SET visibility=$3, security_revision=security_revision+1 WHERE route=$1 AND ${column}=$2`,
          [selectedRoute, key, visibility],
        );
      }
      for (const visibility of ['public', 'private', 'arbitrary']) {
        await rejected(
          client,
          `UPDATE content.${table} SET visibility=$3, security_revision=security_revision+1 WHERE route=$1 AND ${column}=$2`,
          [selectedRoute, key, visibility],
        );
      }
      await rejected(client, `UPDATE content.${table} SET visibility='draft' WHERE route=$1 AND ${column}=$2`, [
        selectedRoute,
        key,
      ]);
    }
    const pointer = await client.query(`SELECT condeferrable, condeferred FROM pg_constraint
      WHERE conrelid='content.thread'::regclass AND conname='thread_first_post_fk'`);
    expect(pointer.rows).toEqual([{ condeferrable: true, condeferred: true }]);
    for (const first of [id('post-0'), id('foreign-post', route + 1)]) {
      await rejected(
        client,
        `INSERT INTO content.thread
        (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
        VALUES ($1,$2,$3,$4,'Other','published',1,$5,$6)`,
        [route, id('other-thread'), author, board, id('transaction'), first],
        '23503',
      );
    }
  });
});

test('logical erasure preserves exact revision metadata and bounded immutable media and subject refs', async () => {
  await fixture(async (client) => {
    const before = (
      await client.query('SELECT * FROM content.revision WHERE route=$1 AND revision_id=$2', [route, id('revision-0')])
    ).rows;
    await client.query(
      "UPDATE content.post SET availability='erased', security_revision=security_revision+1 WHERE route=$1 AND post_id=$2",
      [route, id('post-0')],
    );
    await client.query("UPDATE content.thread SET availability='erased', title=NULL WHERE route=$1 AND thread_id=$2", [
      route,
      thread,
    ]);
    expect(
      (
        await client.query('SELECT * FROM content.revision WHERE route=$1 AND revision_id=$2', [
          route,
          id('revision-0'),
        ])
      ).rows,
    ).toEqual(before);
    for (const table of ['thread', 'post'])
      await rejected(client, `UPDATE content.${table} SET availability='missing'`);
    for (const column of ['media_ids', 'subject_ids']) {
      await rejected(client, `UPDATE content.revision SET ${column}='{}'`);
    }
    for (const [subjects, media, valid] of [
      [128, 32, true],
      [129, 0, false],
      [0, 33, false],
    ] as const) {
      const sql = `INSERT INTO content.revision
        (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id,media_ids)
        SELECT route,thread_id,post_id,$1,body,body_sha256,search_text,licence,array_fill($2::uuid,ARRAY[$3::integer]),board_id,availability,recorded_transaction_id,array_fill($4::uuid,ARRAY[$5::integer])
        FROM content.revision WHERE route=$6 AND revision_id=$7`;
      const values = [
        id(`caps-${subjects}-${media}`),
        id('subject', 0xdef0),
        subjects,
        id('media'),
        media,
        route,
        id('revision-0'),
      ];
      if (valid) await client.query(sql, values);
      else await rejected(client, sql, values);
    }
    await rejected(
      client,
      `INSERT INTO content.revision
      (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id,media_ids)
      SELECT route,thread_id,post_id,$1,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id,ARRAY[$2::uuid]
      FROM content.revision WHERE route=$3 AND revision_id=$4`,
      [id('bad-media'), id('media', route + 1), route, id('revision-0')],
    );
    await client.query(
      "UPDATE content.revision SET body=NULL,body_sha256=NULL,search_text=NULL,availability='erased' WHERE route=$1 AND revision_id=$2",
      [route, id('revision-0')],
    );
    expect(
      (
        await client.query('SELECT * FROM content.revision WHERE route=$1 AND revision_id=$2', [
          route,
          id('revision-0'),
        ])
      ).rows,
    ).toEqual([{ ...before[0], body: null, body_sha256: null, search_text: null, availability: 'erased' }]);
  });
});

test('route-leading neighbourhood indexes retain base keys', async () => {
  const { rows } = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='content'");
  for (const columns of [
    'route, thread_id, created_at, post_id',
    'route, post_id, recorded_at, revision_id',
    'route, thread_id, author_account_id, created_at, post_id',
    'route, post_id',
    'route, revision_id',
  ]) {
    expect(rows.some(({ indexdef }: { indexdef: string }) => indexdef.endsWith(`(${columns})`))).toBe(true);
  }
});

test('forward deployment converts enums and backfills actual metadata without rewriting history', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP SCHEMA content CASCADE');
    const migrations = new URL('../../db/content/migrations/', import.meta.url);
    await client.query(
      (await Bun.file(new URL('20261025082821_content_threads.sql', migrations)).text()).split('-- migrate:down')[0]!,
    );
    await client.query(
      `INSERT INTO content.thread VALUES ($1,$2,$3,$4,'Historical','private',1,$5);
      `,
      [route, thread, author, board, id('transaction')],
    );
    await client.query(`INSERT INTO content.post VALUES ($1,$2,$3,NULL,$4,$5,'public',1,$6)`, [
      route,
      thread,
      id('post-0'),
      author,
      id('revision-0'),
      id('transaction'),
    ]);
    await client.query(
      `INSERT INTO content.revision
      (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id,recorded_at)
      VALUES ($1,$2,$3,$4,$5,sha256($5),'historical','CC0-1.0','{}',$6,'available',$7,$8)`,
      [route, thread, id('post-0'), id('revision-0'), body, board, id('transaction'), time],
    );
    await client.query(
      `INSERT INTO content.revision
      SELECT route,thread_id,post_id,$1,body,body_sha256,search_text,licence,subject_ids,board_id,
      availability,recorded_transaction_id,recorded_at + interval '1 day' FROM content.revision`,
      [id('later-revision')],
    );
    await client.query('UPDATE content.post SET head_revision_id=$1', [id('later-revision')]);
    await client.query(`INSERT INTO content.board VALUES ($1,$2,$3,'Historical board','public',1,$4)`, [
      0x9abc,
      board,
      id('subject'),
      id('transaction'),
    ]);
    await client.query(
      `INSERT INTO editorial.write_basis
      (partition_no,transaction_id,epoch,position,principal_kind,principal_id,client_id,recorded_at)
      VALUES ($1,$2,1,987654,'account',$3,'fixture',$4)`,
      [0x9abc >>> 4, id('transaction'), author, time],
    );
    await client.query(`INSERT INTO content.board VALUES ($1,$2,$3,'No metadata','taken_down',1,$4)`, [
      0x9abc,
      id('fallback-board', 0x9abc),
      id('subject'),
      id('missing-transaction'),
    ]);
    await client.query(`INSERT INTO content.thread VALUES ($1,$2,$3,$4,'No metadata','taken_down',1,$5)`, [
      route,
      id('fallback-thread'),
      author,
      board,
      id('missing-transaction'),
    ]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const fallback = (await client.query('SELECT transaction_timestamp() AS created_at')).rows[0].created_at;
    const before = (await client.query('SELECT * FROM content.revision')).rows;
    const file = Array.from(new Bun.Glob('*_content_neighbourhood.sql').scanSync({ cwd: migrations.pathname }))[0]!;
    await client.query((await Bun.file(new URL(file, migrations)).text()).split('-- migrate:down')[0]!);
    for (const [table, column, key] of [
      ['board', 'board_id', board],
      ['thread', 'thread_id', thread],
      ['post', 'post_id', id('post-0')],
    ]) {
      expect(
        (
          await client.query(
            `SELECT created_at, visibility, security_revision FROM content.${table} WHERE ${column}=$1`,
            [key],
          )
        ).rows,
      ).toEqual([
        { created_at: time, visibility: table === 'thread' ? 'protected' : 'published', security_revision: '1' },
      ]);
    }
    for (const table of ['board', 'thread']) {
      expect(
        (await client.query(`SELECT created_at,visibility FROM content.${table} WHERE title='No metadata'`)).rows,
      ).toEqual([{ created_at: fallback, visibility: 'taken_down' }]);
    }
    expect((await client.query('SELECT * FROM content.revision')).rows).toEqual(
      before.map((row) => ({ ...row, media_ids: [] })),
    );
    expect((await client.query('SELECT first_post_id,availability FROM content.thread')).rows).toEqual([
      { first_post_id: null, availability: 'available' },
      { first_post_id: null, availability: 'available' },
    ]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

const population: Population = {
  name: 'content-neighbourhood',
  hotPartition: route >>> 4,
  hotShare: 1,
  rows: ({ ordinal }) => ({
    // Same route/thread and creation-time ties exercise UUID keysets. Later history includes the target post.
    'content.thread': ordinal === 0 ? [threadRow] : [],
    'content.post': [postRow(ordinal)],
    'content.revision': [
      revisionRow(ordinal),
      ...(ordinal >= 16 ? [revisionRow(ordinal, id('post-0'), id(`history-${ordinal}`))] : []),
    ],
  }),
};

test('checkGrowth rejects a hot-partition scan and passes exact bounded keyset probes', async () => {
  const db = await openGrowthDatabase(url);
  const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
  try {
    const grow = async (_db: typeof db, scale: number, previous: number) =>
      seed(db, population, { from: previous, to: scale });
    const sorted = Array.from({ length: 16 }, (_, ordinal) => id(`post-${ordinal}`)).sort();
    async function probe(assertPlans = false) {
      const query = async (sql: string, values: unknown[], index: string, keys: string[]) => {
        if (assertPlans) {
          const explained = await db.admin.query(`EXPLAIN (FORMAT JSON) ${sql}`, values);
          type Plan = { 'Index Name'?: string; 'Index Cond'?: string; 'Node Type': string; Plans?: Plan[] };
          const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
          const nodes = flatten(explained.rows[0]['QUERY PLAN'][0].Plan);
          expect(nodes.some((node) => node['Node Type'] === 'Sort' || node['Node Type'] === 'Seq Scan')).toBe(false);
          const probe = nodes.find((node) => node['Index Name'] === index);
          expect(probe).toBeDefined();
          for (const key of keys) expect(probe!['Index Cond']).toContain(key);
        }
        return db.pool.query(sql, values);
      };
      for (const direction of ['ASC', 'DESC']) {
        const endpoint = await query(
          `SELECT post_id FROM content.post WHERE route=$1 AND thread_id=$2 AND author_account_id=$3 ORDER BY created_at ${direction},post_id ${direction} LIMIT 1`,
          [route, thread, author],
          'post_thread_author_page_idx',
          ['route', 'thread_id', 'author_account_id'],
        );
        expect(endpoint.rows).toEqual([{ post_id: direction === 'ASC' ? sorted[0] : sorted.at(-1) }]);
        expect(
          (
            await query(
              `SELECT post_id FROM content.post WHERE route=$1 AND thread_id=$2 ORDER BY created_at ${direction},post_id ${direction} LIMIT 1`,
              [route, thread],
              'post_thread_page_idx',
              ['route', 'thread_id'],
            )
          ).rows,
        ).toHaveLength(1);
      }
      const page = await query(
        `SELECT post_id FROM content.post WHERE route=$1 AND thread_id=$2 AND author_account_id=$3 AND (created_at,post_id)>($4,$5) ORDER BY created_at,post_id LIMIT 8`,
        [route, thread, author, time, sorted[0]],
        'post_thread_author_page_idx',
        ['route', 'thread_id', 'author_account_id', 'created_at', 'post_id'],
      );
      expect(page.rows.map((row) => row.post_id)).toEqual(sorted.slice(1, 9));
      expect(
        (
          await query(
            `SELECT post_id FROM content.post WHERE route=$1 AND thread_id=$2 AND (created_at,post_id)>($3,$4) ORDER BY created_at,post_id LIMIT 8`,
            [route, thread, time, id('post-0')],
            'post_thread_page_idx',
            ['route', 'thread_id', 'created_at', 'post_id'],
          )
        ).rows,
      ).toHaveLength(8);
      expect(
        (
          await query(
            `SELECT revision_id FROM content.revision WHERE route=$1 AND post_id=$2 AND (recorded_at,revision_id)>($3,$4) ORDER BY recorded_at,revision_id LIMIT 8`,
            [route, id('post-0'), time, '00000000-0000-0000-0000-000000000000'],
            'revision_post_page_idx',
            ['route', 'post_id', 'recorded_at', 'revision_id'],
          )
        ).rows,
      ).toHaveLength(8);
      for (const [table, column, key] of [
        ['thread', 'thread_id', thread],
        ['post', 'post_id', id('post-0')],
        ['revision', 'revision_id', id('revision-0')],
      ] as const) {
        expect(
          (
            await query(
              `SELECT * FROM content.${table} WHERE route=$1 AND ${column}=$2`,
              [route, key],
              `${table}_pkey`,
              ['route', column],
            )
          ).rows,
        ).toHaveLength(1);
      }
    }
    const report = await checkGrowth(db, {
      name: 'bounded neighbourhood probes',
      scales: [32, 256, 2048],
      rule: 'series',
      bounds,
      // Start with 2,048 same-shape rows, including thread identities for the PK probe.
      // The original 16 author posts and their tied keyset remain fixed.
      grow: (_database, scale, previous) =>
        seed(
          db,
          {
            ...population,
            rows(placement) {
              return {
                ...population.rows!(placement),
                'content.thread': [
                  {
                    ...threadRow,
                    thread_id: placement.ordinal === 0 ? thread : id(`thread-${placement.ordinal}`),
                    first_post_id: placement.ordinal === 0 ? id('post-0') : null,
                  },
                ],
              };
            },
          },
          { from: previous * 64, to: scale * 64 },
        ),
      repetitions: 3,
      warmup: () => probe(true),
      operation: () => probe(),
    });
    expect(report.rule).toBe('series');
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    expect(report.samples.every((sample) => sample.cost.statements === 10)).toBe(true);
    // Reuse the identical seed method at all three scales for the deliberately unbounded baseline.
    await db.admin.query('TRUNCATE content.thread, content.post, content.revision');
    const error: unknown = await checkGrowth(db, {
      name: 'hot partition scan',
      scales: [32, 256, 2048],
      bounds,
      grow,
      repetitions: 3,
      operation: () =>
        db.pool.query('SELECT post_id FROM content.post WHERE route BETWEEN $1 AND $2', [route & ~15, route | 15]),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GrowthBoundError);
    expect((error as GrowthBoundError).violations.some((violation) => violation.metric === 'rows')).toBe(true);
  } finally {
    await db.close();
  }
}, 90_000);
