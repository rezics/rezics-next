import { afterAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { fromPlainText } from '@rezics/document';
import { validateContentDocument } from '../../src/content/document.ts';
import { pagePostCandidates } from '../../src/content/post-pages.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { derivedId, partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, measure, openGrowthDatabase } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const route = 0x1234;
const namespace = '00000000-0000-8000-8000-000000000001';
const id = (name: string, selectedRoute = route) => derivedId(namespace, `post-pages-${name}`, selectedRoute);
type Key = { id: string; at: string };
const document = validateContentDocument({
  body: fromPlainText('Private fixture'),
  licence: 'CC-BY-4.0',
  subjectIds: [],
});
const at = '2030-01-02T00:00:00.123456Z';

// Setup writes canonical documents under the migrated constraints. They are not
// evidence of production posting, erasure, Access or disclosure behavior.
async function seedPosts(threadId: string, keys: readonly Key[]): Promise<void> {
  if (!keys.length) return;
  const selectedRoute = routeOf(threadId)!;
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO content.thread
       (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
       VALUES ($1::integer,$2::uuid,$3::uuid,$4::uuid,'Private title','protected',1,$5::uuid,$6::uuid)
       ON CONFLICT DO NOTHING`,
      [selectedRoute, threadId, id('author'), id('board'), id('transaction'), keys[0]!.id],
    );
    const revisions = keys.map((key) => id(`head-${key.id}`, selectedRoute));
    await client.query(
      `INSERT INTO content.post
       (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at,availability)
       SELECT $1::integer,$2::uuid,k.id,$3::uuid,k.revision,'protected',1,$4::uuid,k.at,
              CASE WHEN k.id=$5::uuid THEN 'erased' ELSE 'available' END
       FROM unnest($6::uuid[],$7::uuid[],$8::timestamptz[]) AS k(id,revision,at)`,
      [
        selectedRoute,
        threadId,
        id('author'),
        id('transaction'),
        keys[0]!.id,
        keys.map((key) => key.id),
        revisions,
        keys.map((key) => key.at),
      ],
    );
    await client.query(
      `INSERT INTO content.revision
       (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       SELECT $1::integer,$2::uuid,k.id,k.revision,
              CASE WHEN k.id=$3::uuid THEN NULL ELSE $4::bytea END,
              CASE WHEN k.id=$3::uuid THEN NULL ELSE $5::bytea END,
              CASE WHEN k.id=$3::uuid THEN NULL ELSE $6::text END,$7::text,'{}'::uuid[],$8::uuid,
              CASE WHEN k.id=$3::uuid THEN 'erased' ELSE 'available' END,$9::uuid
       FROM unnest($10::uuid[],$11::uuid[]) AS k(id,revision)`,
      [
        selectedRoute,
        threadId,
        keys[0]!.id,
        Buffer.from(document.canonicalBytes),
        Buffer.from(document.sha256, 'hex'),
        document.searchText,
        document.licence,
        id('board'),
        id('transaction'),
        keys.map((key) => key.id),
        revisions,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function anchored<T>(threadId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    const anchor = await readPartition(client, partitionOf(routeOf(threadId)!));
    expect(anchor?.writeState).toBe('active');
    return await work(client);
  } finally {
    client.release();
  }
}

test('native exact-parent keyset selector is bounded at all history sizes', async () => {
  const threadId = id('coverage');
  const keys = Array.from({ length: 613 }, (_, n) => ({ id: id(`coverage-${n}`), at }));
  keys.sort((a, b) => a.id.localeCompare(b.id));
  await seedPosts(threadId, keys);
  await seedPosts(
    id('other-parent'),
    keys.map((key) => ({ ...key, id: id(`other-${key.id}`) })),
  );
  await seedPosts(
    id('same-partition', route + 1),
    keys.map((key) => ({ ...key, id: id(key.id, route + 1) })),
  );
  await anchored(threadId, async (client) => {
    for (const limit of [1, 20, 100, 200]) {
      const seen: Key[] = [];
      let after: Key | null = null;
      do {
        const { value: page, cost } = await measure(db, () => pagePostCandidates(client, { threadId, after, limit }));
        expect(page.candidates.length).toBeLessThanOrEqual(limit);
        expect(cost.statements).toBe(1);
        expect(cost.rows).toBeLessThanOrEqual(limit + 1);
        seen.push(...page.candidates);
        after = page.nextKey;
        expect(after).toEqual(seen.length < keys.length ? seen.at(-1)! : null);
      } while (after);
      expect(seen).toEqual(keys);
      expect(new Set(seen.map((key) => key.id)).size).toBe(keys.length);
    }
    expect(await pagePostCandidates(client, { threadId, after: keys.at(-1)!, limit: 20 })).toEqual({
      candidates: [],
      nextKey: null,
    });
    expect(await pagePostCandidates(client, { threadId: id('empty'), after: null, limit: 20 })).toEqual({
      candidates: [],
      nextKey: null,
    });
    const last = await pagePostCandidates(client, { threadId, after: keys.at(-21)!, limit: 20 });
    expect(last).toEqual({ candidates: keys.slice(-20), nextKey: null });
  });
});

test('stable time/id ties and insertion between pages never duplicate a row', async () => {
  const threadId = id('insertion');
  const keys = Array.from({ length: 8 }, (_, n) => ({ id: id(`tie-${n}`), at })).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const later = { id: id('later'), at: '2030-01-02T00:00:00.123457Z' };
  await seedPosts(threadId, [...keys, later]);
  await anchored(threadId, async (client) => {
    const first = await pagePostCandidates(client, { threadId, after: null, limit: 3 });
    expect(first.candidates).toEqual(keys.slice(0, 3));
    const before = { id: id('insert-before'), at: '2030-01-02T00:00:00.123455Z' };
    const after = { id: id('insert-after'), at: '2030-01-02T00:00:00.123458Z' };
    await seedPosts(threadId, [before, after]);
    const seen = [...first.candidates];
    let key = first.nextKey;
    while (key) {
      const page = await pagePostCandidates(client, { threadId, after: key, limit: 3 });
      seen.push(...page.candidates);
      key = page.nextKey;
    }
    expect(seen).toEqual([...keys, later, after]);
    expect(new Set(seen.map((key) => key.id)).size).toBe(seen.length);
    // Exact historical revisions are never candidates, including an old revision
    // whose post now points at a different head. The selector reads no bytes.
    await db.admin.query(
      `INSERT INTO content.revision
       (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       SELECT route,thread_id,post_id,$3::uuid,NULL,NULL,NULL,licence,subject_ids,board_id,'erased',recorded_transaction_id
       FROM content.revision WHERE route=$1::integer AND revision_id=$2::uuid`,
      [route, id(`head-${keys[0]!.id}`), id('historical')],
    );
    const result = await pagePostCandidates(client, { threadId, after: null, limit: 200 });
    expect(result.candidates).toEqual([before, ...keys, later, after]);
    expect(result.candidates.every((candidate) => Object.keys(candidate).sort().join(',') === 'at,id')).toBe(true);
  });
});

test('rejects invalid routed parent/key identities, times and limits before SQL', async () => {
  const threadId = id('validation');
  await anchored(threadId, async (client) => {
    const { capture: raw } = await capture(db, async () => {
      for (const invalid of ['', 'not-an-id', '00000000-0000-4000-8000-000000000001', threadId.toUpperCase()]) {
        await expect(pagePostCandidates(client, { threadId: invalid, after: null, limit: 20 })).rejects.toThrow(
          RangeError,
        );
        await expect(pagePostCandidates(client, { threadId, after: { id: invalid, at }, limit: 20 })).rejects.toThrow(
          RangeError,
        );
      }
      for (const selectedRoute of [route + 1, route + 16])
        await expect(
          pagePostCandidates(client, { threadId, after: { id: id('wrong-route', selectedRoute), at }, limit: 20 }),
        ).rejects.toThrow(RangeError);
      for (const time of ['infinity', '-infinity', 'NaN', '', '2030-02-30T00:00:00.000Z'])
        await expect(
          pagePostCandidates(client, { threadId, after: { id: id('key'), at: time }, limit: 20 }),
        ).rejects.toThrow(RangeError);
      for (const limit of [0, -1, 201, 1.5, NaN, Infinity])
        await expect(pagePostCandidates(client, { threadId, after: null, limit })).rejects.toThrow(RangeError);
    });
    expect(raw.statements).toEqual([]);
  });
});

test('three informative seeded scales have zero content sequential scans and bounded actual rows statements buffers', async () => {
  const threadId = id('growth');
  const fixed = Array.from({ length: 32 }, (_, n) => ({ id: id(`fixed-${n}`), at })).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  await seedPosts(threadId, fixed);
  await anchored(threadId, async (client) => {
    const report = await checkGrowth(db, {
      name: 'Native post candidates',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_, scale, previous) => {
        // Grow the same parent's skipped history and later history, plus other
        // parents on the same route and a different route in the same partition.
        for (const [parent, selectedRoute] of [
          [threadId, route],
          [id('growth-other'), route],
          [id('growth-neighbour', route + 1), route + 1],
        ] as const) {
          await seedPosts(
            parent,
            Array.from({ length: 2 * (scale - previous) }, (_, n) => ({
              id: id(`growth-${parent}-${2 * previous + n}`, selectedRoute),
              at: n % 2 ? '2031-01-01T00:00:00.000000Z' : '2029-01-01T00:00:00.000000Z',
            })),
          );
        }
        await db.admin.query('ANALYZE content.post');
        const size = await db.admin.query(
          'SELECT count(*)::integer AS n FROM content.post WHERE route=$1::integer AND thread_id=$2::uuid',
          [route, threadId],
        );
        expect(size.rows[0].n).toBe(2 * scale + fixed.length);
      },
      operation: async () => {
        const page = await pagePostCandidates(client, { threadId, after: fixed[0]!, limit: 20 });
        expect(page).toEqual({ candidates: fixed.slice(1, 21), nextKey: fixed[20]! });
        return page;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBe(21);
      expect(sample.cost.statements).toBe(1);
      const relations = Object.entries(sample.cost.relations!);
      expect(relations.map(([name]) => name)).toEqual(['content.post']);
      for (const [, relation] of relations) {
        expect(relation.sequentialScans).toBe(0);
        expect(relation.rows).toBe(21);
      }
    }
    // Page-size growth is output-sensitive and independent of history growth.
    for (const limit of [1, 20, 100, 200]) {
      const { value, cost } = await measure(db, () =>
        pagePostCandidates(client, { threadId, after: fixed[0]!, limit }),
      );
      expect(value.candidates).toHaveLength(limit);
      expect(value.nextKey).toEqual(value.candidates.at(-1)!);
      expect(cost.rows).toBe(limit + 1);
      expect(cost.statements).toBe(1);
    }
  });
}, 90_000);
