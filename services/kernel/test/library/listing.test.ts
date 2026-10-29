import { afterAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { EVENT_TYPES, readBatch } from '../../src/events/log.ts';
import * as store from '../../src/library/collection-store.ts';
import type { CollectionVisibility } from '../../src/library/collection-model.ts';
import { subjectCollections, syncSubjectListing } from '../../src/library/listing.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, openGrowthDatabase } from '../support/growth.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(process.env.DATABASE_URL);
afterAll(() => pool.end());
const sourceRoute = 0x6780;
const subjectRoute = 0x7890;
const at = '2026-10-26T04:00:00.000Z';
const clock = () => new Date(at);
const listed = 'com.rezics.library.subject.listed.v1';
const context = () => ({ time: at, transactionId: newId(sourceRoute) });

async function collection(db: Pool, subjectId: string, visibility: CollectionVisibility, copies = 1) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = await store.insertCollection(
      client,
      sourceRoute,
      {
        id: newId(sourceRoute),
        curatorAccountId: newId(sourceRoute),
        title: 'A Collection',
        description: null,
        visibility,
      },
      context(),
    );
    const members: string[] = [];
    for (let i = 0; i < copies; i++) {
      const memberId = newId(sourceRoute);
      await store.insertMember(
        client,
        sourceRoute,
        row.id,
        { id: memberId, subjectId, note: 'Private editorial note', ordinalKey: `a${i}` },
        context(),
      );
      members.push(memberId);
    }
    await client.query('COMMIT');
    return { ...row, members };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Store fixtures still publish through the native command fence: stamps are core positions.
async function sourceWrite(
  collectionId: string,
  body: (client: Parameters<typeof store.readCollection>[0], writeContext: ReturnType<typeof context>) => Promise<void>,
) {
  await runCommand(pool, { partition: partitionOf(sourceRoute), clock }, async (tx, command) => {
    await body(tx, { time: authoritativeTimeValue(command.time), transactionId: command.transactionId });
    return {
      value: null,
      events: [
        { type: 'com.rezics.library.collection.listing.changed.v1', subject: collectionId, data: { collectionId } },
      ],
    };
  });
}

async function visibility(collectionId: string, value: CollectionVisibility) {
  await sourceWrite(collectionId, async (client, context) => {
    const row = (await store.readCollection(client, sourceRoute, collectionId))!;
    expect(
      await store.updateCollection(
        client,
        sourceRoute,
        collectionId,
        row.revision,
        { title: row.title, description: row.description, visibility: value },
        context,
      ),
    ).not.toBeNull();
  });
}

async function remove(collectionId: string, memberId?: string) {
  await sourceWrite(collectionId, async (client, context) => {
    if (memberId) await store.deleteMember(client, sourceRoute, collectionId, memberId, context);
    else await store.tombstoneCollection(client, sourceRoute, collectionId, context);
  });
}

const sync = (subjectId: string, collectionId: string) =>
  syncSubjectListing({ pool, clock }, { subjectId, collectionId });

async function state(subjectId: string) {
  const route = routeOf(subjectId)!;
  const listing = await pool.query('SELECT * FROM library.subject_listing WHERE route=$1 AND subject_id=$2', [
    route,
    subjectId,
  ]);
  const pairs = await pool.query(
    'SELECT * FROM library.subject_collection WHERE route=$1 AND subject_id=$2 ORDER BY collection_id',
    [route, subjectId],
  );
  const events = await pool.query(
    'SELECT * FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY position, event_seq',
    [partitionOf(route), subjectId],
  );
  return { listing: listing.rows, pairs: pairs.rows, events: events.rows };
}

async function assertCount(subjectId: string, count: number, eventCount: number) {
  const result = await state(subjectId);
  expect(result.listing[0]?.public_collection_count ?? 0).toBe(count);
  const events = result.events.filter((event) => event.type === listed);
  expect(events).toHaveLength(eventCount);
  for (const event of events) expect(event.data).toEqual({ subjectId });
  return result;
}

test('only distinct active public Collections count, with a keyset page in the subject partition', async () => {
  const subjectId = newId(subjectRoute);
  const publicOne = await collection(pool, subjectId, 'public', 2);
  const publicTwo = await collection(pool, subjectId, 'public');
  const privateOne = await collection(pool, subjectId, 'private');
  const unlisted = await collection(pool, subjectId, 'unlisted');
  const deleted = await collection(pool, subjectId, 'public');
  await remove(deleted.id);
  const absent = newId(sourceRoute);
  for (const collectionId of [privateOne.id, unlisted.id, deleted.id, absent]) {
    await sync(subjectId, collectionId);
    expect((await state(subjectId)).pairs).toEqual([]);
    expect((await state(subjectId)).events).toEqual([]);
  }
  await sync(subjectId, publicOne.id);
  await sync(subjectId, publicTwo.id);
  const result = await assertCount(subjectId, 2, 2);
  expect(result.pairs).toHaveLength(2);
  expect(result.pairs.find((pair) => pair.collection_id === publicOne.id)).toMatchObject({
    route: subjectRoute,
    subject_id: subjectId,
    collection_route: sourceRoute,
    multiplicity: 2,
  });
  const ids = [publicOne.id, publicTwo.id].sort();
  const first = await subjectCollections(pool, subjectId, null, 1);
  expect(first.map((row) => row.collectionId)).toEqual([ids[0]!]);
  const second = await subjectCollections(pool, subjectId, ids[0]!, 1);
  expect(second.map((row) => row.collectionId)).toEqual([ids[1]!]);
  expect(await subjectCollections(pool, subjectId, ids[1]!, 1)).toEqual([]);
  expect(await subjectCollections(pool, newId(subjectRoute), null, 10)).toEqual([]);
  const serialized = JSON.stringify(result);
  for (const id of [...publicOne.members, ...publicTwo.members, publicOne.curatorAccountId]) {
    expect(serialized).not.toContain(id);
  }
  for (const key of ['entry_id', 'session_id', 'copy_id', 'follow_id', 'account_id']) {
    expect(serialized).not.toContain(key);
  }
  expect(await subjectCollections(pool, subjectId, null, 10)).toHaveLength(2);
});

test('visibility cycles, duplicate removal, deletion, redelivery and reversed deliveries converge', async () => {
  const subjectId = newId(subjectRoute);
  const source = await collection(pool, subjectId, 'public', 2);
  await sync(subjectId, source.id);
  const original = await assertCount(subjectId, 1, 1);
  await sync(subjectId, source.id);
  expect(await state(subjectId)).toEqual(original);

  await remove(source.id, source.members[0]!);
  await sync(subjectId, source.id);
  expect((await assertCount(subjectId, 1, 2)).pairs[0]?.multiplicity).toBe(1);
  await visibility(source.id, 'private');
  await sync(subjectId, source.id);
  expect((await assertCount(subjectId, 0, 3)).pairs).toEqual([]);
  await visibility(source.id, 'public');
  await sync(subjectId, source.id);
  await assertCount(subjectId, 1, 4);

  const other = await collection(pool, subjectId, 'public');
  await sync(subjectId, other.id);
  await assertCount(subjectId, 2, 5);
  await remove(source.id);
  await remove(other.id, other.members[0]!);
  // Deliver the newest work before older notifications: every invocation rereads current truth.
  for (const id of [other.id, source.id]) await sync(subjectId, id);
  const final = await assertCount(subjectId, 0, 7);
  expect(final.pairs).toEqual([]);
  for (const id of [source.id, other.id, other.id, source.id]) await sync(subjectId, id);
  expect(await state(subjectId)).toEqual(final);
});

test('listed events have a registered closed schema and are readable by the indexer', async () => {
  const subjectId = newId(subjectRoute + 16);
  const source = await collection(pool, subjectId, 'public');
  await sync(subjectId, source.id);
  const schema = EVENT_TYPES[listed];
  expect(Value.Check(schema, { subjectId })).toBe(true);
  expect(Value.Check(schema, { subjectId, collectionId: source.id })).toBe(false);
  expect(Value.Check(schema, {})).toBe(false);
  const events: unknown[] = [];
  expect(
    await readBatch(pool, {
      consumer: 'listing_test',
      partition: partitionOf(routeOf(subjectId)!),
      apply: async (envelopes) => {
        events.push(...envelopes.flatMap((envelope) => envelope.events));
      },
    }),
  ).toMatchObject({ status: 'read', envelopes: 1 });
  expect(events).toMatchObject([{ type: listed, subject: subjectId, data: { subjectId } }]);
});

test('sync statements stay equal at three scales of unrelated subjects and Collections', async () => {
  const db = await openGrowthDatabase();
  const counts: number[] = [];
  let previous = 0;
  try {
    for (const scale of [1, 8, 64]) {
      for (let i = previous; i < scale; i++) {
        const subjectId = newId(subjectRoute + 32);
        const source = await collection(db.admin, subjectId, 'public');
        await syncSubjectListing({ pool: db.pool, clock }, { subjectId, collectionId: source.id });
      }
      previous = scale;
      const subjectId = newId(subjectRoute + 32);
      const source = await collection(db.admin, subjectId, 'public', 2);
      const measured = await capture(db, () =>
        syncSubjectListing({ pool: db.pool, clock }, { subjectId, collectionId: source.id }),
      );
      counts.push(measured.capture.statements.length);
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts).toEqual([counts[0]!, counts[0]!, counts[0]!]);
  } finally {
    await db.close();
  }
});
