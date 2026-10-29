import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import pg from 'pg';
import { derivedId } from '../../src/route/route.ts';
import { contentWorkWorkflowId } from '../../src/content/work-contract.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: url, max: 2 });
afterAll(() => pool.end());
const route = 0x1234;
const id = (name: string, selectedRoute = route) =>
  derivedId('00000000-0000-8000-8000-000000000002', name, selectedRoute);
const thread = id('thread');
const author = id('author', 0x5678);
const time = new Date('2030-01-02T00:00:00.000Z');
const endpointPostIdsByOrdinal = Array.from({ length: 4 }, (_, i) => id(`post-${i}`));
const endpointPostIds = [...endpointPostIdsByOrdinal].sort();
const anchorOrdinal = endpointPostIdsByOrdinal.findIndex((postId) => postId === endpointPostIds[0]);
const emptyBody = Buffer.from(serializeDocument(fromPlainText('')));
const emptyBodySha256 = createHash('sha256').update(emptyBody).digest();
const operation = {
  route,
  operation_id: id('operation'),
  initiator_account_id: id('initiator', 0x5678),
  author_account_id: author,
  thread_id: thread,
  anchor_post_id: endpointPostIds[0]!,
  actor_kind: 'account',
  actor_account_id: id('initiator', 0x5678),
  actor_client_id: 'rezics-web',
  actor_scopes: ['content:write', 'account:read'],
  actor_requested_by: `urn:rezics:request:${id('human', 0x9abc)}:${id('request', 0x9abc)}`,
  actor_authn_epoch: 7,
  empty_scope: false,
  upper_created_at: time,
  upper_post_id: endpointPostIds.at(-1)!,
  requested_at: time,
  recorded_transaction_id: id('transaction'),
};
async function insert(client: Pick<pg.PoolClient, 'query'>, row = operation) {
  return client.query(
    `INSERT INTO content.operation (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(',')})`,
    Object.values(row),
  );
}
async function seedAnchor(client: Pick<pg.PoolClient, 'query'>, row: typeof operation) {
  const revisionId = id(`revision-${anchorOrdinal}`, row.route);
  const body = Buffer.from(serializeDocument(fromPlainText('Operation storage fixture')));
  const records = [
    [
      'content.thread',
      {
        route: row.route,
        thread_id: row.thread_id,
        author_account_id: row.author_account_id,
        board_id: id('board'),
        title: 'Fixture',
        visibility: 'published',
        security_revision: 1,
        recorded_transaction_id: row.recorded_transaction_id,
      },
    ],
    [
      'content.post',
      {
        route: row.route,
        thread_id: row.thread_id,
        post_id: row.anchor_post_id,
        reply_to_post_id: null,
        author_account_id: row.author_account_id,
        head_revision_id: revisionId,
        visibility: 'published',
        security_revision: 1,
        recorded_transaction_id: row.recorded_transaction_id,
        created_at: time,
      },
    ],
    [
      'content.revision',
      {
        route: row.route,
        thread_id: row.thread_id,
        post_id: row.anchor_post_id,
        revision_id: revisionId,
        body,
        body_sha256: createHash('sha256').update(body).digest(),
        search_text: 'Operation storage fixture',
        licence: 'CC0-1.0',
        subject_ids: [],
        board_id: id('board'),
        availability: 'available',
        recorded_transaction_id: row.recorded_transaction_id,
      },
    ],
  ] as const;
  for (const [table, record] of records) {
    await client.query(
      `INSERT INTO ${table} (${Object.keys(record).join(',')}) VALUES (${Object.keys(record)
        .map((_, index) => `$${index + 1}`)
        .join(',')})`,
      Object.values(record),
    );
  }
}
async function rejected(client: pg.PoolClient, sql: string, values: unknown[] = [], code = '23514') {
  await client.query('SAVEPOINT invalid');
  const error: unknown = await client.query(sql, values).catch((caught: unknown) => caught);
  await client.query('ROLLBACK TO SAVEPOINT invalid');
  expect(error).toMatchObject({ code });
}
const source = { epoch: 1, partition: route >>> 4, position: 123n };
const workflowId = contentWorkWorkflowId(source, 2, 'authorErase', operation.operation_id);
const bind = `UPDATE content.operation SET native_workflow_id=$3,source_epoch=$4,source_partition=$5,
  source_position=$6,source_event_index=$7 WHERE route=$1 AND operation_id=$2`;
const binding = [route, operation.operation_id, workflowId, source.epoch, source.partition, '123', 2];
const read = 'SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2';
const endpoint = (direction: 'ASC' | 'DESC') =>
  `SELECT created_at,post_id FROM content.post WHERE route=$1 AND thread_id=$2 AND author_account_id=$3 ORDER BY created_at ${direction},post_id ${direction} LIMIT 1`;

// SQL fixtures are setup only: storage neither grants Access nor launches workflows.
test('operation identity is routed and records no duplicate native job state', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedAnchor(client, operation);
    await insert(client);
    const stored = (await client.query(read, [route, operation.operation_id])).rows[0];
    expect(stored).toEqual({
      ...operation,
      actor_authn_epoch: '7',
      native_workflow_id: null,
      source_epoch: null,
      source_partition: null,
      source_position: null,
      source_event_index: null,
      source_digest: null,
      original_minimum_authn_epoch: null,
      original_operator_account_id: null,
      original_delegation_transaction_id: null,
      original_delegation_issued_valid: null,
      creation_command_kind: null,
      creation_idempotency_key: null,
      creation_request_digest: null,
      creation_target_route: null,
      creation_target_id: null,
    });
    const columns = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='content' AND table_name='operation' ORDER BY ordinal_position`);
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      [
        ...Object.keys(operation),
        'native_workflow_id',
        'source_epoch',
        'source_partition',
        'source_position',
        'source_event_index',
        'source_digest',
        'original_minimum_authn_epoch',
        'original_operator_account_id',
        'original_delegation_transaction_id',
        'original_delegation_issued_valid',
        'creation_command_kind',
        'creation_idempotency_key',
        'creation_request_digest',
        'creation_target_route',
        'creation_target_id',
      ].sort(),
    );
    expect(
      (
        await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='content.operation'::regclass AND contype='p'`)
      ).rows,
    ).toEqual([{ definition: 'PRIMARY KEY (route, operation_id)' }]);
    expect(
      (
        await client.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='content.operation'::regclass AND contype='f'`)
      ).rows,
    ).toEqual([]);
    for (const change of [
      { route: route + 1 },
      { operation_id: id('bad', route + 1) },
      { thread_id: id('bad', route + 16) },
      { upper_post_id: id('bad', route + 1) },
      { actor_kind: 'anonymous' },
      { actor_account_id: author },
      { actor_client_id: '' },
      { actor_client_id: 'x'.repeat(1025) },
      { actor_requested_by: id('unverified-human') },
      { actor_scopes: Array(13000).fill('x') },
      { actor_scopes: [''] },
      { actor_scopes: [null] },
      { actor_scopes: ['x'.repeat(129)] },
      { actor_scopes: ['bad scope'] },
      { actor_authn_epoch: 0 },
      { actor_authn_epoch: '9007199254740992' },
      { empty_scope: true },
      { upper_created_at: null },
      { upper_post_id: null },
      { upper_created_at: new Date(time.getTime() + 1) },
    ]) {
      const row = { ...operation, operation_id: id('invalid'), ...change };
      await rejected(
        client,
        `INSERT INTO content.operation (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
          .map((_, i) => `$${i + 1}`)
          .join(',')})`,
        Object.values(row),
      );
    }
    await rejected(
      client,
      `INSERT INTO content.operation (
        route,operation_id,initiator_account_id,author_account_id,thread_id,anchor_post_id,actor_kind,
        actor_account_id,actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,empty_scope,
        upper_created_at,upper_post_id,requested_at,recorded_transaction_id,native_workflow_id,source_epoch,
        source_partition,source_position,source_event_index
      ) SELECT route,$1,initiator_account_id,author_account_id,
      thread_id,anchor_post_id,actor_kind,actor_account_id,actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,
      empty_scope,upper_created_at,upper_post_id,requested_at,recorded_transaction_id,$2,1,$3,123,2
      FROM content.operation WHERE route=$4 AND operation_id=$5`,
      [
        id('prebound'),
        contentWorkWorkflowId(source, 2, 'authorErase', id('prebound')),
        source.partition,
        route,
        operation.operation_id,
      ],
    );
    await insert(client, {
      ...operation,
      operation_id: id('empty'),
      empty_scope: true,
      upper_created_at: null,
      upper_post_id: null,
    } as unknown as typeof operation);
    // A sibling route is allowed within the thread's partition; accounts are remote identities.
    const sibling = {
      ...operation,
      route: route + 1,
      operation_id: id('sibling', route + 1),
      thread_id: id('sibling-thread', route + 1),
      anchor_post_id: id('sibling-anchor', route + 1),
      upper_post_id: id('sibling-upper', route + 1),
      actor_requested_by: null,
    } as unknown as typeof operation;
    await seedAnchor(client, sibling);
    await insert(client, sibling);
    for (const column of Object.keys(operation)) {
      await rejected(client, `UPDATE content.operation SET ${column}=NULL WHERE route=$1 AND operation_id=$2`, [
        route,
        operation.operation_id,
      ]);
    }
    await rejected(client, bind, [route, operation.operation_id, workflowId, 1, source.partition + 1, '123', 2]);
    await rejected(client, bind, [route, operation.operation_id, 'wrong-id', 1, source.partition, '123', 2]);
    await rejected(client, 'UPDATE content.operation SET native_workflow_id=$3 WHERE route=$1 AND operation_id=$2', [
      route,
      operation.operation_id,
      workflowId,
    ]);
    await client.query(bind, binding);
    await client.query(bind, binding);
    expect((await client.query(read, [route, operation.operation_id])).rows[0]).toMatchObject({
      native_workflow_id: workflowId,
      source_position: '123',
      source_event_index: 2,
    });
    await rejected(client, bind, [
      route,
      operation.operation_id,
      contentWorkWorkflowId({ ...source, position: 124n }, 2, 'authorErase', operation.operation_id),
      1,
      source.partition,
      '124',
      2,
    ]);
    await rejected(
      client,
      `UPDATE content.operation SET native_workflow_id=NULL,source_epoch=NULL,
      source_partition=NULL,source_position=NULL,source_event_index=NULL WHERE route=$1 AND operation_id=$2`,
      [route, operation.operation_id],
    );
    await rejected(client, 'DELETE FROM content.operation WHERE route=$1 AND operation_id=$2', [
      route,
      operation.operation_id,
    ]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

const metadata = { visibility: 'published', security_revision: 1, recorded_transaction_id: id('transaction') };
const population: Population = {
  name: 'operation-identity',
  hotPartition: route >>> 4,
  hotShare: 1,
  rows: ({ ordinal }) => ({
    'content.thread': [
      {
        route,
        thread_id: id(`history-thread-${ordinal}`),
        author_account_id: author,
        board_id: id('board'),
        title: 'Fixture',
        ...metadata,
        created_at: time,
      },
    ],
    // The target author's fixed neighbourhood has tied creation keys. Its unrelated thread history grows too.
    'content.post': [
      ...(ordinal === anchorOrdinal
        ? []
        : [
            {
              route,
              thread_id: thread,
              post_id: id(`post-${ordinal}`),
              reply_to_post_id: null,
              author_account_id: ordinal < 4 ? author : id('other-author'),
              head_revision_id: id(`revision-${ordinal}`),
              ...metadata,
              created_at: time,
            },
          ]),
      ...(ordinal >= 4
        ? [
            {
              route,
              thread_id: id(`history-thread-${ordinal}`),
              post_id: id(`history-post-${ordinal}`),
              reply_to_post_id: null,
              author_account_id: author,
              head_revision_id: id(`history-revision-${ordinal}`),
              ...metadata,
              created_at: time,
            },
          ]
        : []),
    ],
    'content.revision': (ordinal === anchorOrdinal ? [] : [false])
      .concat(ordinal >= 4 ? [true] : [])
      .map((history) => ({
        route,
        thread_id: history ? id(`history-thread-${ordinal}`) : thread,
        post_id: id(`${history ? 'history-post' : 'post'}-${ordinal}`),
        revision_id: id(`${history ? 'history-revision' : 'revision'}-${ordinal}`),
        body: emptyBody,
        body_sha256: emptyBodySha256,
        search_text: '',
        licence: 'CC0-1.0',
        subject_ids: [],
        board_id: id('board'),
        availability: 'available',
        recorded_transaction_id: id('transaction'),
        recorded_at: time,
      })),
    'content.operation': [{ ...operation, operation_id: id(`unrelated-operation-${ordinal}`) }],
  }),
  async finish(admin, { from, to }) {
    const ids = Array.from({ length: to - from }, (_, offset) => id(`unrelated-operation-${from + offset}`));
    // Seed the insert-and-bind history too: each fresh measured identity grows from pending to the wider bound row.
    await admin.query(
      `UPDATE content.operation o
       SET native_workflow_id=i.workflow_id,source_epoch=$3,source_partition=$4,
           source_position=$5,source_event_index=$6
       FROM unnest($1::uuid[],$2::text[]) AS i(operation_id,workflow_id)
       WHERE o.route=$7 AND o.operation_id=i.operation_id`,
      [
        ids,
        ids.map((operationId) => contentWorkWorkflowId(source, 2, 'authorErase', operationId)),
        source.epoch,
        source.partition,
        source.position.toString(),
        2,
        route,
      ],
    );
  },
};

test('endpoint and status reads use bounded exact keys', async () => {
  const indexes = (await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='content'")).rows;
  expect(
    indexes.filter((row) => row.indexdef.endsWith('(route, thread_id, author_account_id, created_at, post_id)')),
  ).toHaveLength(1);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedAnchor(client, operation);
    await insert(client);
    expect((await client.query(read, [route, operation.operation_id])).rows).toHaveLength(1);
    expect((await client.query(read, [route + 1, operation.operation_id])).rows).toEqual([]);
    expect((await client.query(read, [route, id('absent')])).rows).toEqual([]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('checkGrowth stays independent of unrelated operations and author history', async () => {
  const db = await openGrowthDatabase(url);
  const sorted = endpointPostIds;
  try {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await seedAnchor(client, operation);
      await insert(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    // Fresh operations (including the warm-up) share a committed history of equivalent inserts and bindings.
    const baseline = 4096;
    await seed(db, population, { from: 0, to: baseline });
    const assertIndex = async (sql: string, values: unknown[], index: string, keys: string[]) => {
      const result = await db.admin.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
      const nodes: Record<string, unknown>[] = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
      };
      visit(result.rows[0]['QUERY PLAN'][0].Plan);
      const probes = nodes.filter((node) => node['Index Name'] === index);
      expect(probes).toHaveLength(1);
      for (const key of keys) expect(probes[0]!['Index Cond']).toContain(key);
    };
    const report = await checkGrowth(db, {
      name: 'operation identity and author endpoints',
      rule: 'series',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 3,
      grow: async (_db, scale, previous) => {
        await seed(db, population, { from: baseline + previous, to: baseline + scale });
        await db.admin.query('ANALYZE content.operation; ANALYZE content.post');
        await assertIndex(read, [route, operation.operation_id], 'operation_pkey', ['route', 'operation_id']);
        for (const direction of ['ASC', 'DESC'] as const)
          await assertIndex(endpoint(direction), [route, thread, author], 'post_thread_author_page_idx', [
            'route',
            'thread_id',
            'author_account_id',
          ]);
      },
      operation: async (_db, _scale, repetition) => {
        // Real insert and immutable binding, not a progress initialization scan.
        const row = { ...operation, operation_id: id(`measured-${repetition}`) };
        await insert(db.pool, row);
        const nativeId = contentWorkWorkflowId(source, 2, 'authorErase', row.operation_id);
        await db.pool.query(bind, [route, row.operation_id, nativeId, 1, source.partition, '123', 2]);
        expect((await db.pool.query(read, [route, row.operation_id])).rows[0].native_workflow_id).toBe(nativeId);
        // An identity without a native mapping is pending; only DBOS can supply terminal state or counters.
        expect((await db.pool.query(read, [route, operation.operation_id])).rows[0].native_workflow_id).toBeNull();
        for (const direction of ['ASC', 'DESC'] as const) {
          const result = await db.pool.query(endpoint(direction), [route, thread, author]);
          expect(result.rows).toEqual([{ created_at: time, post_id: direction === 'ASC' ? sorted[0] : sorted.at(-1) }]);
        }
      },
    });
    expect(report.rule).toBe('series');
    for (const sample of report.samples)
      for (const cost of sample.repetitions) {
        expect(cost.relations['content.operation']?.sequentialScans).toBe(0);
        expect(cost.relations['content.post']?.sequentialScans).toBe(0);
        expect(cost.relations['content.post']?.rows).toBe(2);
      }
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    expect(report.samples.every((sample) => sample.cost.statements === 6)).toBe(true);
  } finally {
    await db.close();
  }
}, 90_000);
