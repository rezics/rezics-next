import { afterAll, expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { pageRevisionCandidates } from '../../src/content/revision-pages.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { derivedId, partitionOf } from '../../src/route/route.ts';
import { capture, checkGrowth, costOf, measure, openGrowthDatabase } from '../support/growth.ts';
import { checkStatement } from '../support/partition-binding.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const route = 0x1234;
const namespace = '00000000-0000-8000-8000-000000000042';
const id = (name: string, selectedRoute = route) => derivedId(namespace, name, selectedRoute);
const body = Buffer.from(
  canonicalize({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Historical edition' }] }] },
  })!,
);
type Key = { id: string; at: string };
type Parent = { route: number; threadId: string; postId: string };
const order = (keys: Key[]) => keys.toSorted((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

// Native fixtures exercise storage constraints, not posting or erasure API behavior.
async function append(
  client: Pick<PoolClient, 'query'>,
  parent: Parent,
  tag: string,
  from: number,
  to: number,
  at = '2030-01-02T00:00:00.000123Z',
): Promise<Key[]> {
  if (from === to) return [];
  const ids = Array.from({ length: to - from }, (_, i) => id(`${parent.postId}/${tag}/${from + i}`, parent.route));
  const result = await client.query<Key>(
    `INSERT INTO content.revision
     (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,
      board_id,availability,recorded_transaction_id,recorded_at)
     SELECT $1::integer,$2::uuid,$3::uuid,r.revision_id,
       CASE WHEN (r.position-1+$5::integer)%11=10 THEN NULL::bytea ELSE $6::bytea END,
       sha256($6::bytea),
       CASE WHEN (r.position-1+$5::integer)%11=10 THEN NULL::text ELSE 'Historical edition' END,
       'CC-BY-SA-4.0',ARRAY[$7::uuid],$8::uuid,
       CASE WHEN (r.position-1+$5::integer)%11=10 THEN 'erased' ELSE 'available' END,$9::uuid,
       $10::timestamptz + ((r.position-1+$5::integer)/5)*interval '1 microsecond'
     FROM unnest($4::uuid[]) WITH ORDINALITY AS r(revision_id,position)
     RETURNING revision_id AS id,
       to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
    [parent.route, parent.threadId, parent.postId, ids, from, body, id('subject'), id('board'), id('transaction'), at],
  );
  return order(result.rows);
}

async function parent(name: string, count: number, selectedRoute = route) {
  const value: Parent = {
    route: selectedRoute,
    threadId: id(`${name}/thread`, selectedRoute),
    postId: id(`${name}/post`, selectedRoute),
  };
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO content.thread
       (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
       VALUES ($1::integer,$2::uuid,$3::uuid,$4::uuid,'Native fixture','published',1,$5::uuid,$6::uuid)`,
      [selectedRoute, value.threadId, id('author'), id('board'), id('transaction'), value.postId],
    );
    await client.query(
      `INSERT INTO content.post
       (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
       VALUES ($1::integer,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'published',1,$6::uuid)`,
      [
        selectedRoute,
        value.threadId,
        value.postId,
        id('author'),
        id(`${value.postId}/fixed/0`, selectedRoute),
        id('transaction'),
      ],
    );
    const keys = await append(client, value, 'fixed', 0, count);
    await client.query('COMMIT');
    return { ...value, keys };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function anchored(parent: Parent): Promise<PoolClient> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const anchor = await readPartition(client, partitionOf(parent.route));
    expect(anchor?.writeState).toBe('active');
    await finishPlan(client);
    return client;
  } catch (error) {
    await release(client);
    throw error;
  }
}

async function release(client: PoolClient) {
  try {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function finishPlan(client: PoolClient) {
  // Closing the unnamed extended-query portal emits its auto_explain plan while
  // retaining the anchored snapshot. These native controls perform no reads.
  await client.query('SAVEPOINT page_plan');
  await client.query('RELEASE SAVEPOINT page_plan');
}

test('native exact-parent keyset selector is bounded at all history sizes', async () => {
  const source = await parent('bounded', 513);
  await parent('same-route-distractor', 513);
  await parent('same-partition-distractor', 513, route + 1);
  await db.admin.query('VACUUM (ANALYZE) content.revision');
  const client = await anchored(source);
  try {
    for (const limit of [1, 20, 100, 200]) {
      const run = await capture(db, async () => {
        const page = await pageRevisionCandidates(client, { postId: source.postId, after: null, limit });
        await finishPlan(client);
        return page;
      });
      expect(run.value).toEqual({ candidates: source.keys.slice(0, limit), nextKey: source.keys[limit - 1]! });
      const cost = costOf(run.capture);
      expect(cost.rows).toBe(limit + 1);
      expect(cost.statements).toBe(1);
      expect(cost.controlStatements).toBe(2);
      expect(cost.plans).toBe(1);
      expect(cost.relations['content.revision']?.sequentialScans).toBe(0);
      expect(JSON.stringify(run.capture.plans)).toContain('revision_post_page_idx');
      expect(JSON.stringify(run.capture.plans)).not.toContain('"Node Type":"Sort"');
    }
    let after: Key | null = null;
    const seen: Key[] = [];
    do {
      const page = await pageRevisionCandidates(client, { postId: source.postId, after, limit: 200 });
      seen.push(...page.candidates);
      after = page.nextKey;
    } while (after);
    expect(seen).toEqual(source.keys);
    expect(new Set(seen.map((key) => key.id)).size).toBe(513);
    // An exactly full terminal page needs no extra empty request to discover the end.
    expect(
      await pageRevisionCandidates(client, { postId: source.postId, after: source.keys[341]!, limit: 171 }),
    ).toEqual({ candidates: source.keys.slice(342), nextKey: null });
    for (const input of [
      { postId: source.postId, after: source.keys.at(-1)! },
      { postId: id('absent-post'), after: null },
    ]) {
      expect(await pageRevisionCandidates(client, { ...input, limit: 200 })).toEqual({ candidates: [], nextKey: null });
    }
    const { default: statement } = await import('../../src/content/page-revisions.sql');
    expect(await checkStatement(db.admin, { sql: statement.sql, params: [...statement.params] })).toEqual({
      bound: true,
      parameter: 'route',
    });
  } finally {
    await release(client);
  }
});

test('stable time/id ties and insertion between pages never duplicate a row', async () => {
  const source = await parent('insertion', 257);
  const firstClient = await anchored(source);
  let first;
  try {
    first = await pageRevisionCandidates(firstClient, { postId: source.postId, after: null, limit: 37 });
  } finally {
    await release(firstClient);
  }
  const boundary = first.nextKey!;
  const tag = Array.from({ length: 100 }, (_, i) => `insert-${i}`).find(
    (name) => id(`${source.postId}/${name}/0`) > boundary.id,
  )!;
  expect(tag).toBeDefined();
  const inserted = await append(db.admin, source, tag, 0, 1, boundary.at);
  await append(db.admin, source, 'before-boundary', 0, 1, '2029-01-01T00:00:00.000000Z');
  let after: Key | null = boundary;
  const seen = [...first.candidates];
  while (after) {
    const client = await anchored(source);
    try {
      const page = await pageRevisionCandidates(client, { postId: source.postId, after, limit: 37 });
      seen.push(...page.candidates);
      after = page.nextKey;
    } finally {
      await release(client);
    }
  }
  expect(seen).toEqual(order([...source.keys, ...inserted]));
  expect(new Set(seen.map((key) => key.id)).size).toBe(258);
  expect(new Set(seen.map((key) => key.at)).size).toBeLessThan(seen.length);
});

test('invalid routes, limits and non-finite or malformed keys reject before SQL', async () => {
  const source = await parent('validation', 1);
  const client = await anchored(source);
  try {
    const base = { postId: source.postId, after: null, limit: 20 };
    const key = source.keys[0]!;
    const invalid = [
      ...['invalid', id('parent').toUpperCase(), '00000000-0000-4000-8000-123400000001'].map((postId) => ({
        ...base,
        postId,
      })),
      ...[0, -1, 201, 1.5, NaN, Infinity].map((limit) => ({ ...base, limit })),
      ...['invalid', id('key', route + 1), id('key', route + 16)].map((id) => ({ ...base, after: { ...key, id } })),
      ...[
        'infinity',
        '-infinity',
        'NaN',
        '',
        '2030-02-30T00:00:00Z',
        '2030-01-02T24:00:00Z',
        '0000-01-01T00:00:00Z',
      ].map((at) => ({ ...base, after: { ...key, at } })),
    ];
    const run = await capture(db, async () => {
      for (const input of invalid) await expect(pageRevisionCandidates(client, input)).rejects.toThrow();
    });
    expect(run.capture.statements).toEqual([]);
    expect(await pageRevisionCandidates(client, { ...base, limit: 1 })).toEqual({
      candidates: source.keys,
      nextKey: null,
    });
  } finally {
    await release(client);
  }
});

test('three informative seeded scales have zero content sequential scans and bounded actual rows statements buffers', async () => {
  const source = await parent('growth', 64);
  const distractor = await parent('growth-same-route', 1);
  const neighbour = await parent('growth-same-partition', 1, route + 1);
  const after = source.keys[5]!;
  const expected = { candidates: source.keys.slice(6, 43), nextKey: source.keys[42]! };
  let client: PoolClient | undefined;
  try {
    const report = await checkGrowth(db, {
      name: 'native revision parent-prefix seek',
      scales: [256, 2048, 16384],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        if (client) {
          await release(client);
          client = undefined;
        }
        // Fixture writes only: grow preceding history and distractors without moving the measured keys/bytes.
        for (const value of [source, distractor, neighbour]) {
          await append(database.admin, value, 'past', previous * 2, scale * 2, '2020-01-01T00:00:00.000000Z');
          const count = await database.admin.query<{ count: string }>(
            'SELECT count(*) FROM content.revision WHERE route=$1::integer AND post_id=$2::uuid',
            [value.route, value.postId],
          );
          expect(Number(count.rows[0]!.count)).toBeGreaterThanOrEqual(500);
        }
        await database.admin.query('VACUUM (ANALYZE) content.revision');
        // Anchor outside capture: this contract measures only the already-anchored storage helper.
        client = await anchored(source);
      },
      async operation() {
        expect(await pageRevisionCandidates(client!, { postId: source.postId, after, limit: 37 })).toEqual(expected);
        await finishPlan(client!);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 2048, 16384]);
    for (const { cost } of report.samples) {
      expect(cost.rows).toBe(38);
      expect(cost.statements).toBe(1);
      expect(cost.blocks).toBeGreaterThan(0);
      expect(cost.blocks).toBeLessThanOrEqual(201);
      expect(Object.keys(cost.relations!)).toEqual(['content.revision']);
      for (const relation of Object.values(cost.relations!)) expect(relation.sequentialScans).toBe(0);
    }
    console.info('Revision candidates GrowthReport', JSON.stringify(report));
    const page = await measure(db, async () => {
      const value = await pageRevisionCandidates(client!, { postId: source.postId, after, limit: 200 });
      await finishPlan(client!);
      return value;
    });
    expect(page.value).toEqual({ candidates: source.keys.slice(6), nextKey: null });
    expect(page.cost.rows).toBe(58);
  } finally {
    if (client) await release(client);
  }
}, 60_000);
