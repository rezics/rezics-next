import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { LINKS_CHANGED, SUBJECT_MERGED } from '../../src/semantic/events.ts';
import { linkProjection, listSubjectLinks } from '../../src/semantic/links.ts';
import { redirectOf } from '../../src/semantic/merges.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const projection = linkProjection(pool);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
afterAll(() => pool.end());
let nextRoute = (2000 + Math.floor(Math.random() * 1000)) * 16;
const partition = (id: string) => partitionOf(routeOf(id)!);
const testRelease = `sha256:${'0'.repeat(64)}`;

async function subjects(count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const route = nextRoute;
    nextRoute += 16;
    const id = newId(route);
    await runCommand(pool, { partition: partitionOf(route) }, async (tx, { transactionId }) => {
      await tx.query(
        "INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id) VALUES ($1, $2, 'schema:Person', $3)",
        [route, id, transactionId],
      );
      await tx.query(
        `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
         VALUES ($1,$2,1,'create',$3,$4)`,
        [route, id, testRelease, transactionId],
      );
      return { value: null, events: [{ type: 'com.rezics.subject.created.v1', subject: id, data: { id } }] };
    });
    ids.push(id);
  }
  return ids.sort();
}

async function merge(id: string, survivor: string) {
  return runCommand(pool, { partition: partition(id) }, async (tx, { transactionId }) => {
    const latest = await tx.query(
      'SELECT revision, release FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision DESC LIMIT 1',
      [routeOf(id), id],
    );
    const previous = latest.rows[0] as { revision: number; release: string } | undefined;
    await tx.query(
      `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
       VALUES ($1,$2,$3,'merge',$4,$5)`,
      [routeOf(id), id, Number(previous?.revision ?? 1) + 1, previous?.release ?? testRelease, transactionId],
    );
    await tx.query(
      'INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id) VALUES ($1, $2, 1, $3, $4)',
      [routeOf(id), id, survivor, transactionId],
    );
    return { value: null, events: [{ type: SUBJECT_MERGED, subject: id, data: { id, survivor } }] };
  });
}

async function seedLinks(id: string, count: number) {
  const rows = Array.from({ length: count }, () => ({
    source: newId(nextRoute),
    statement: randomUUID(),
  }));
  await runCommand(pool, { partition: partition(id) }, async (tx, { transactionId }) => {
    await tx.query(
      `INSERT INTO semantic.inbound_link
       (route, subject_id, property, source_subject_id, statement_id, source_revision, present, recorded_transaction_id)
       SELECT $1, $2, 'schema:author', r.source, r.statement, 1, true, $3
       FROM jsonb_to_recordset($4::jsonb) r(source uuid, statement uuid)`,
      [routeOf(id), id, transactionId, JSON.stringify(rows)],
    );
    return { value: null, events: [{ type: 'com.rezics.subject.created.v1', subject: id, data: { id } }] };
  });
  return rows;
}

async function seedOutboundRelations(id: string, count: number) {
  const route = routeOf(id)!;
  const nil = '00000000-0000-0000-0000-000000000000';
  const rows = Array.from({ length: count }, (_, index) => ({
    target: newId(route),
    statement: randomUUID(),
    slot: randomUUID(),
    order_key: String(index).padStart(8, '0'),
  }));
  await runCommand(pool, { partition: partition(id) }, async (tx, { transactionId }) => {
    const values = JSON.stringify(rows);
    await tx.query(
      `INSERT INTO semantic.outbound_link
       (route, subject_id, property, filter_value, order_key, target_subject_id, statement_id, slot_id, relation,
        source_type, source_order_key, outbound_order, source_revision, source_security_revision, target_revision,
        target_type, external, value, present, recorded_transaction_id)
       SELECT $1, $2, 'schema:author', $3, r.order_key, r.target, r.statement, r.slot, true,
              'schema:Person', '', 'name', 1, 0, 0, 'schema:Person', NULL, 'value', true, $4
       FROM jsonb_to_recordset($5::jsonb) r(target uuid, statement uuid, slot uuid, order_key text)`,
      [route, id, nil, transactionId, values],
    );
    await tx.query(
      `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
       VALUES ($1,$2,'schema:author',$3,$4)`,
      [route, id, nil, count],
    );
    await tx.query(
      `INSERT INTO semantic.inbound_link
       (route, subject_id, property, source_subject_id, statement_id, source_revision, source_security_revision,
        present, source_type, order_key, filter_value, recorded_transaction_id)
       SELECT $1, r.target, 'schema:author', $2, r.statement, 1, 0, true, 'schema:Person', '', $3, $4
       FROM jsonb_to_recordset($5::jsonb) r(target uuid, statement uuid)`,
      [route, id, nil, transactionId, values],
    );
    await tx.query(
      `INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value)
       SELECT $1, r.target, 'schema:author', $2, 1
       FROM jsonb_to_recordset($3::jsonb) r(target uuid)`,
      [route, nil, JSON.stringify(rows.map(({ target }) => ({ target })))],
    );
    return { value: null, events: [{ type: 'com.rezics.subject.created.v1', subject: id, data: { id } }] };
  });
  return rows;
}

const links = (id: string, seen: Parameters<typeof listSubjectLinks>[2]['seen'] = [], cursor?: string) =>
  listSubjectLinks(pool, tokens, {
    routeKey: new Uint8Array(32).fill(1),
    subject: id,
    property: null,
    limit: 100,
    authorize: async () => true,
    seen,
    ...(cursor === undefined ? {} : { cursor }),
  });

test('a merge moves more than one page and remains behind until its last page', async () => {
  const [survivor, id] = (await subjects(2)) as [string, string];
  const seeded = await seedLinks(id, 205);
  const merged = await merge(id, survivor);
  const seen = [{ partition: merged.partition, epoch: merged.epoch, position: merged.position }];
  await projection.run(partition(id));
  const first = await links(survivor, seen);
  expect(first.links).toHaveLength(100);
  expect(first.freshness.caught_up).toBe(false);
  await projection.run(partition(survivor));
  expect((await links(survivor, seen)).freshness.caught_up).toBe(false);
  await projection.run(partition(survivor));
  await projection.run(partition(survivor));
  const final = await links(survivor, seen);
  expect(final.freshness.caught_up).toBe(true);
  const all = [...final.links];
  let cursor = final.next;
  while (cursor) {
    const page = await links(survivor, seen, cursor);
    all.push(...page.links);
    cursor = page.next;
  }
  expect(all.map((link) => link.statement).sort()).toEqual(seeded.map((link) => link.statement).sort());

  // Replay every merge envelope without rewriting a completed move or its redirect.
  const before = await pool.query('SELECT * FROM semantic.redirect WHERE route = $1 AND subject_id = $2', [
    routeOf(id),
    id,
  ]);
  await pool.query(
    'UPDATE core.consumer_checkpoint SET epoch = NULL, position = 0 WHERE consumer = $1 AND partition_no = $2',
    ['semantic_links', partition(id)],
  );
  await projection.run(partition(id));
  expect((await links(survivor, seen)).freshness.caught_up).toBe(true);
  expect(
    (await pool.query('SELECT * FROM semantic.redirect WHERE route = $1 AND subject_id = $2', [routeOf(id), id])).rows,
  ).toEqual(before.rows);
}, 15_000);

test('a merge removes 3,000 outbound relation projections in bounded pages', async () => {
  const [survivor, id] = (await subjects(2)) as [string, string];
  await seedOutboundRelations(id, 3_000);
  const merged = await merge(id, survivor);
  await projection.run(partition(id));

  let previous = 3_000;
  let pages = 0;
  for (; pages < 40 && previous > 0; pages++) {
    await projection.run(partition(survivor));
    const result = await pool.query(
      'SELECT count(*)::integer AS value FROM semantic.outbound_link WHERE route=$1 AND subject_id=$2 AND present',
      [routeOf(id), id],
    );
    const remaining = Number(result.rows[0]?.value ?? 0);
    expect(previous - remaining).toBeLessThanOrEqual(100);
    previous = remaining;
  }
  expect(previous).toBe(0);
  expect(pages).toBeGreaterThanOrEqual(30);
  const mirrors = await pool.query(
    `SELECT count(*)::integer AS value FROM semantic.inbound_link
     WHERE route=$1 AND source_subject_id=$2 AND present`,
    [routeOf(id), id],
  );
  expect(mirrors.rows[0]?.value).toBe(0);
  const count = await pool.query(
    `SELECT value::integer FROM semantic.outbound_link_count
     WHERE route=$1 AND subject_id=$2 AND property='schema:author' AND filter_value='00000000-0000-0000-0000-000000000000'`,
    [routeOf(id), id],
  );
  expect(count.rows[0]?.value).toBe(0);
  expect(merged.partition).toBe(partition(id));
}, 30_000);

test('a survivor merged while its event is in flight forwards the move and repoints all members', async () => {
  const [smallest, middle, largest, member] = (await subjects(4)) as [string, string, string, string];
  const seeded = await seedLinks(member, 1);
  await merge(member, largest);
  await projection.run(partition(member));
  await merge(largest, middle);
  await merge(middle, smallest);
  // The largest subject's event has not yet reached the middle survivor.
  await projection.run(partition(largest));
  await projection.run(partition(middle));
  for (let i = 0; i < 4; i++) await projection.run(partition(smallest));
  expect((await links(smallest)).links.map((link) => link.statement)).toEqual([seeded[0]!.statement]);
  for (const id of [middle, largest, member]) expect(await redirectOf(pool, id)).toBe(smallest);
});

test('link changes reaching a redirected target are forwarded and a newer removal wins over a copied link', async () => {
  const [survivor, id, source] = (await subjects(3)) as [string, string, string];
  const [seeded] = await seedLinks(id, 1);
  await merge(id, survivor);
  const statement = randomUUID();
  await runCommand(pool, { partition: partition(source) }, async () => ({
    value: null,
    events: [
      {
        type: LINKS_CHANGED,
        subject: source,
        data: {
          subject: source,
          revision: 2,
          security_revision: 0,
          changes: [{ target: id, property: 'schema:author', statement, present: true }],
        },
      },
      {
        type: LINKS_CHANGED,
        subject: seeded!.source,
        data: {
          subject: seeded!.source,
          revision: 2,
          security_revision: 0,
          changes: [{ target: id, property: 'schema:author', statement: seeded!.statement, present: false }],
        },
      },
    ],
  }));
  await projection.run(partition(source));
  // Copying revision 1 after the forwarded revision 2 removal must keep the tombstone.
  await projection.run(partition(id));
  expect((await links(survivor)).links).toEqual([{ subject: source, property: 'schema:author', statement }]);
  expect(
    (
      await pool.query(
        'SELECT source_revision, present FROM semantic.inbound_link WHERE route = $1 AND subject_id = $2 AND property = $3 AND source_subject_id = $4 AND statement_id = $5',
        [routeOf(survivor), survivor, 'schema:author', seeded!.source, seeded!.statement],
      )
    ).rows,
  ).toEqual([{ source_revision: 2, present: false }]);
});

test('an unfinished move follows a survivor merged after its first link page', async () => {
  const [smallest, middle, largest] = (await subjects(3)) as [string, string, string];
  const seeded = await seedLinks(largest, 205);
  await merge(largest, middle);
  await projection.run(partition(largest));
  expect((await links(middle)).freshness.caught_up).toBe(false);
  const merged = await merge(middle, smallest);
  await projection.run(partition(middle));
  const seen = [{ partition: merged.partition, epoch: merged.epoch, position: merged.position }];
  expect((await links(smallest, seen)).freshness.caught_up).toBe(false);
  for (let i = 0; i < 5; i++) await projection.run(partition(smallest));
  const first = await links(smallest, seen);
  expect(first.freshness.caught_up).toBe(true);
  const all = [...first.links];
  let cursor = first.next;
  while (cursor) {
    const page = await links(smallest, seen, cursor);
    all.push(...page.links);
    cursor = page.next;
  }
  expect(all.map((link) => link.statement).sort()).toEqual(seeded.map((link) => link.statement).sort());
  expect(await redirectOf(pool, largest)).toBe(smallest);
}, 15_000);
