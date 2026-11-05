import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { LINKS_PROJECTED } from '../../src/semantic/events.ts';
import { LINKS_CONSUMER, linkProjection } from '../../src/semantic/links.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import listOutboundKeyReemit from '../../src/semantic/list-outbound-key-reemit.sql';
import listOutboundPage from '../../src/semantic/list-outbound-links-by-property.sql';
import listInboundPage from '../../src/semantic/list-inbound-links-by-property.sql';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const projection = linkProjection(pool);
let nextPartition = 1024 + Math.floor(Math.random() * 2048);

type Draft = { type: string; subject?: string; data: unknown };

async function append(partition: number, events: Draft[]): Promise<bigint> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    for (const [seq, event] of events.entries()) {
      await client.query(
        `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          partition,
          position,
          seq,
          events.length,
          epoch,
          Bun.randomUUIDv7(),
          event.type,
          event.subject ?? null,
          JSON.stringify(event.data),
        ],
      );
    }
    await client.query('COMMIT');
    return BigInt(position);
  } finally {
    client.release();
  }
}

test("a batch's link changes apply out of order and twice and keep the newest state", async () => {
  const sourcePartition = nextPartition++;
  const targetPartition = nextPartition++;
  const sourceRoute = sourcePartition << 4;
  const targetRoute = targetPartition << 4;
  const sourceId = newId(sourceRoute);
  const targetId = newId(targetRoute);
  const statementA = newId(sourceRoute);
  const statementB = newId(sourceRoute);
  const statementC = newId(sourceRoute);
  expect(partitionOf(sourceRoute)).toBe(sourcePartition);
  expect(partitionOf(targetRoute)).toBe(targetPartition);

  const changed = (
    revision: number,
    changes: { property: string; statement: string; target: string; present: boolean }[],
  ) => ({
    type: 'com.rezics.semantic.links.changed.v1',
    subject: sourceId,
    data: { subject: sourceId, revision, security_revision: 0, changes },
  });
  const property = 'schema:exampleOfWork';
  await append(sourcePartition, [
    changed(4, [
      { property, statement: statementA, target: targetId, present: false },
      { property, statement: statementB, target: targetId, present: true },
    ]),
    { type: 'com.rezics.subject.created.v1', subject: sourceId, data: { id: sourceId } },
  ]);
  await append(sourcePartition, [
    changed(1, [
      { property, statement: statementA, target: targetId, present: true },
      { property, statement: statementC, target: targetId, present: true },
    ]),
  ]);
  await append(sourcePartition, [
    changed(3, [
      { property, statement: statementB, target: targetId, present: false },
      { property, statement: statementC, target: targetId, present: true },
    ]),
  ]);

  const applied = await projection.run(sourcePartition);
  expect(applied.status).toBe('read');
  const read = async () => {
    const { rows } = await admin.query<{
      statement_id: string;
      source_revision: number;
      present: boolean;
      recorded_transaction_id: string;
    }>(
      `SELECT statement_id::text, source_revision, present, recorded_transaction_id::text
       FROM semantic.inbound_link WHERE subject_id = $1 ORDER BY statement_id`,
      [targetId],
    );
    return rows;
  };
  const expected = [
    { statement_id: statementA, source_revision: 4, present: false },
    { statement_id: statementB, source_revision: 4, present: true },
    { statement_id: statementC, source_revision: 3, present: true },
  ].sort((left, right) => (left.statement_id < right.statement_id ? -1 : 1));
  const first = await read();
  expect(
    first.map(({ statement_id, source_revision, present }) => ({ statement_id, source_revision, present })),
  ).toEqual(expected);
  const transactions = first.map((row) => row.recorded_transaction_id);

  const again = await projection.run(sourcePartition);
  expect(again).toMatchObject({ status: 'read', envelopes: 0 });
  expect((await read()).map((row) => row.recorded_transaction_id)).toEqual(transactions);

  await admin.query(
    `UPDATE core.consumer_checkpoint SET epoch = NULL, position = 0
     WHERE consumer = $1 AND partition_no = $2`,
    [LINKS_CONSUMER, sourcePartition],
  );
  const replayed = await projection.run(sourcePartition);
  expect(replayed.status).toBe('read');
  if (replayed.status === 'read') expect(replayed.envelopes).toBeGreaterThan(0);
  const afterReplay = await read();
  expect(
    afterReplay.map(({ statement_id, source_revision, present }) => ({ statement_id, source_revision, present })),
  ).toEqual(expected);
  expect(afterReplay.map((row) => row.recorded_transaction_id)).toEqual(transactions);

  const projected = await admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM core.outbox WHERE partition_no = $1 AND type = $2',
    [targetPartition, LINKS_PROJECTED],
  );
  expect(projected.rows[0]!.count).toBe(2);
});

test('outbound mirror re-emission retires moved Context keys and ignores stale revisions', async () => {
  const sourcePartition = nextPartition++;
  const route = sourcePartition << 4;
  const source = newId(route);
  const globalTarget = newId(route);
  const oldContextTarget = newId(route);
  const staleTarget = newId(route);
  const context = newId(route);
  const statement = newId(route);
  const slot = newId(route);
  const property = 'schema:exampleOfWork';
  const filter = '00000000-0000-0000-0000-000000000000';
  const transaction = () => Bun.randomUUIDv7();
  await admin.query(
    `INSERT INTO semantic.context(route,context_id,kind,labels,recorded_transaction_id)
     VALUES($1,$2,'community','{"en":"Mirror Context"}',$3)`,
    [route, context, transaction()],
  );
  await admin.query(
    `INSERT INTO semantic.outbound_link(
       route,subject_id,context_id,property,filter_value,order_key,target_subject_id,statement_id,slot_id,
       relation,source_type,source_order_key,outbound_order,source_revision,source_security_revision,
       target_revision,target_type,value,present,suppressed,recorded_transaction_id
     ) VALUES
       ($1,$2,$3,$4,$5,'0base',$6,$7,$8,true,'schema:Book','0source','position',1,0,1,'schema:Book','value',true,false,$9),
       ($1,$2,$10,$4,$5,'0context',$11,$7,$8,true,'schema:Book','0source','position',1,0,1,'schema:Book','value',true,false,$9)`,
    [
      route,
      source,
      GLOBAL_CONTEXT,
      property,
      filter,
      globalTarget,
      statement,
      slot,
      transaction(),
      context,
      oldContextTarget,
    ],
  );
  await admin.query(
    `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
     VALUES($1,$2,$3,$4,1)`,
    [route, source, property, filter],
  );
  await admin.query(
    `INSERT INTO semantic.outbound_link_context_count(route,subject_id,context_id,property,filter_value,value)
     VALUES($1,$2,$3,$4,$5,1)`,
    [route, source, context, property, filter],
  );
  const change = (revision: number, target: string, order: string, present = true) => ({
    type: 'com.rezics.semantic.links.changed.v1',
    subject: source,
    data: {
      subject: source,
      revision,
      security_revision: 0,
      changes: [
        {
          context_id: context,
          property,
          statement,
          target,
          present,
          project_outbound: true,
          relation: true,
          slot_id: slot,
          outbound_order: 'position',
          outbound_order_key: order,
          source_type: 'schema:Book',
          order_key: '0source',
          filter_value: filter,
        },
      ],
    },
  });
  const readRows = async () => {
    const { rows } = await admin.query(
      `SELECT context_id::text, target_subject_id::text, order_key, present, source_revision,
              recorded_transaction_id::text
       FROM semantic.outbound_link WHERE route=$1 AND subject_id=$2 AND statement_id=$3
       ORDER BY context_id, order_key, target_subject_id`,
      [route, source, statement],
    );
    return rows;
  };
  const counts = async () => {
    const { rows } = await admin.query(
      `SELECT (SELECT value FROM semantic.outbound_link_count
               WHERE route=$1 AND subject_id=$2 AND property=$3 AND filter_value=$4) AS base,
              (SELECT value FROM semantic.outbound_link_context_count
               WHERE route=$1 AND subject_id=$2 AND context_id=$5 AND property=$3 AND filter_value=$4) AS delta`,
      [route, source, property, filter, context],
    );
    return { base: Number(rows[0]!.base), delta: Number(rows[0]!.delta) };
  };

  await append(sourcePartition, [change(5, oldContextTarget, '0new-context')]);
  const applied = await projection.run(sourcePartition);
  expect(applied.status).toBe('read');
  expect(await counts()).toEqual({ base: 1, delta: 1 });
  let rows = await readRows();
  expect(
    rows.map(({ context_id, target_subject_id, order_key, present }) => ({
      context_id,
      target_subject_id,
      order_key,
      present,
    })),
  ).toEqual([
    { context_id: GLOBAL_CONTEXT, target_subject_id: globalTarget, order_key: '0base', present: true },
    { context_id: context, target_subject_id: oldContextTarget, order_key: '0context', present: false },
    { context_id: context, target_subject_id: oldContextTarget, order_key: '0new-context', present: true },
  ]);

  await append(sourcePartition, [change(4, staleTarget, '0stale')]);
  await projection.run(sourcePartition);
  rows = await readRows();
  expect(rows.some((row) => row.target_subject_id === staleTarget)).toBe(false);
  expect(await counts()).toEqual({ base: 1, delta: 1 });

  await admin.query(
    `UPDATE core.consumer_checkpoint SET epoch=NULL, position=0
     WHERE consumer=$1 AND partition_no=$2`,
    [LINKS_CONSUMER, sourcePartition],
  );
  await projection.run(sourcePartition);
  rows = await readRows();
  expect(rows.find((row) => row.order_key === '0new-context')).toMatchObject({
    present: true,
    source_revision: 5,
  });
  expect(await counts()).toEqual({ base: 1, delta: 1 });

  await append(sourcePartition, [change(6, oldContextTarget, '0new-context', false)]);
  await projection.run(sourcePartition);
  expect((await readRows()).find((row) => row.order_key === '0new-context')).toMatchObject({
    present: false,
    source_revision: 6,
  });
  expect(await counts()).toEqual({ base: 1, delta: 0 });
});

test('holder key source pages preserve payloads and every filter and Context cursor component', async () => {
  const route = nextPartition++ << 4;
  const subject = newId(route);
  const target = newId(route);
  const context = newId(route);
  const nil = '00000000-0000-0000-0000-000000000000';
  await admin.query(
    `INSERT INTO semantic.context(route,context_id,kind,labels,recorded_transaction_id)
     VALUES($1,$2,'community','{"en":"Source page Context"}',$3)`,
    [route, context, Bun.randomUUIDv7()],
  );
  const rows = Array.from({ length: 55 }, (_, index) => {
    const statement = newId(route);
    const slot = newId(route);
    return [nil, newId(route)].flatMap((filter) =>
      [GLOBAL_CONTEXT, context].map((contextId) => ({
        context_id: contextId,
        suppressed: contextId === context,
        property: index % 2 ? 'schema:author' : 'schema:translator',
        statement_id: statement,
        slot_id: slot,
        target: index % 3 ? target : null,
        filter_value: filter,
        order_key: `0${55 - index}`,
        relation: true,
        source_type: 'schema:Book',
        source_order_key: '0holder',
        outbound_order: 'name',
        source_revision: 3,
        source_security_revision: '2',
        target_revision: 4,
        target_type: index % 3 ? 'schema:Person' : '',
        external: null,
        value: index % 3 ? 'value' : 'somevalue',
      })),
    );
  }).flat();
  const tuple = (row: (typeof rows)[number]) => [
    row.property,
    row.target ?? nil,
    row.statement_id,
    row.filter_value,
    row.context_id,
  ];
  rows.sort((left, right) => {
    const a = tuple(left);
    const b = tuple(right);
    for (let index = 0; index < a.length; index++) {
      if (a[index]! < b[index]!) return -1;
      if (a[index]! > b[index]!) return 1;
    }
    return 0;
  });
  await admin.query(
    `INSERT INTO semantic.outbound_link
       (route,subject_id,context_id,suppressed,property,filter_value,order_key,target_subject_id,statement_id,slot_id,
        relation,source_type,source_order_key,outbound_order,source_revision,source_security_revision,target_revision,
        target_type,external,value,present,recorded_transaction_id)
     SELECT $1,$2,r.context_id,r.suppressed,r.property,r.filter_value,r.order_key,COALESCE(r.target,$4::uuid),
            r.statement_id,r.slot_id,r.relation,r.source_type,r.source_order_key,r.outbound_order,r.source_revision,
            r.source_security_revision,r.target_revision,r.target_type,r.external,r.value,true,$5
     FROM jsonb_to_recordset($3::jsonb) r(context_id uuid,suppressed boolean,property text,filter_value uuid,
       order_key text,target uuid,statement_id uuid,slot_id uuid,relation boolean,source_type text,
       source_order_key text,outbound_order text,source_revision integer,source_security_revision bigint,
       target_revision integer,target_type text,external text,value text)`,
    [route, subject, JSON.stringify(rows), nil, Bun.randomUUIDv7()],
  );
  // Exercise the nil target, filter and Context ties as well as the native 100-row continuation boundary.
  for (const after of [-1, 0, 1, 99, 199, 219]) {
    const cursor = after < 0 ? ['', nil, nil, nil, nil] : tuple(rows[after]!);
    const page = await listOutboundKeyReemit.run(pool, {
      route,
      subject_id: subject,
      after_property: cursor[0]!,
      after_target: cursor[1]!,
      after_statement: cursor[2]!,
      after_filter: cursor[3]!,
      after_context: cursor[4]!,
    });
    expect(page).toEqual(rows.slice(after + 1, after + 102));
  }
});

test('native relation seeks merge equal keys, skip suppressions and exhaust every cursor and filter', async () => {
  const route = nextPartition++ << 4;
  const anchor = newId(route);
  const context = newId(route);
  const otherContext = newId(route);
  const nil = '00000000-0000-0000-0000-000000000000';
  const filter = newId(route);
  await admin.query(
    `INSERT INTO semantic.context(route,context_id,kind,labels,recorded_transaction_id)
     SELECT $1,context,'community','{"en":"Seek Context"}',$3 FROM unnest($2::uuid[]) context`,
    [route, [context, otherContext], randomUUID()],
  );
  const keys = Array.from({ length: 70 }, (_, index) => ({
    // Include byte-sensitive order, nil targets, equal order/target ties and statement tie breakers.
    order: index < 40 ? '0A' : index < 60 ? '0a' : '0é',
    target: index < 40 ? nil : newId(route),
    source: anchor,
    statement: newId(route),
    slot: newId(route),
  }));
  const rows = keys.flatMap((key, index) =>
    (index % 7 ? [nil, filter] : [nil]).flatMap((filterValue) =>
      [GLOBAL_CONTEXT, context, otherContext].map((contextId) => ({
        ...key,
        context: contextId,
        filter: filterValue,
        // More suppressions than a complete page must be traversed before its first visible key.
        suppressed: contextId !== GLOBAL_CONTEXT && index < 35,
        // Interleave Context-only and Global-only keys after the suppression prefix, plus a local tombstone.
        present:
          contextId === context
            ? index !== 36 && (index < 40 || index % 5 !== 0)
            : contextId !== GLOBAL_CONTEXT || index < 40 || index % 6 !== 0,
        type: contextId === context ? 'schema:Person' : 'schema:Book',
        value: key.target === nil ? 'somevalue' : 'value',
      })),
    ),
  );
  await admin.query(
    `INSERT INTO semantic.outbound_link(route,subject_id,context_id,property,filter_value,order_key,
      target_subject_id,statement_id,slot_id,relation,source_revision,source_security_revision,
      target_revision,target_type,value,suppressed,present,recorded_transaction_id)
     SELECT $1,$2,r.context,'schema:author',r.filter,r.order,r.target,r.statement,r.slot,true,1,0,0,
            r.type,r.value,r.suppressed,r.present,$4
     FROM jsonb_to_recordset($3::jsonb) r(context uuid,filter uuid,"order" text,target uuid,statement uuid,
       slot uuid,type text,value text,suppressed boolean,present boolean)`,
    [route, anchor, JSON.stringify(rows), randomUUID()],
  );
  await admin.query(
    `INSERT INTO semantic.inbound_link(route,subject_id,context_id,property,filter_value,order_key,
      source_subject_id,statement_id,source_revision,source_type,suppressed,present,recorded_transaction_id)
     SELECT $1,$2,r.context,'schema:author',r.filter,r.order,r.source,r.statement,1,r.type,
            r.suppressed,r.present,$4
     FROM jsonb_to_recordset($3::jsonb) r(context uuid,filter uuid,"order" text,source uuid,statement uuid,
       type text,suppressed boolean,present boolean)`,
    [route, anchor, JSON.stringify(rows), randomUUID()],
  );
  // These must never enter the requested property/filter/relation range.
  await admin.query(
    `INSERT INTO semantic.outbound_link(route,subject_id,property,filter_value,order_key,target_subject_id,statement_id,
       slot_id,relation,source_revision,value,present,recorded_transaction_id)
     VALUES($1,$2,'schema:author',$3,'',$3,$4,$4,false,1,'somevalue',true,$5),
           ($1,$2,'schema:translator',$3,'',$3,$4,$4,true,1,'somevalue',true,$5)`,
    [route, anchor, nil, newId(route), randomUUID()],
  );
  for (const direction of ['outbound', 'inbound'] as const) {
    const tuple = (row: (typeof rows)[number]) => [
      row.order,
      direction === 'outbound' ? row.target : row.source,
      row.statement,
    ];
    const compare = (a: readonly string[], b: readonly string[]) => {
      for (let index = 0; index < a.length; index++) {
        const order = Buffer.compare(Buffer.from(a[index]!), Buffer.from(b[index]!));
        if (order) return order;
      }
      return 0;
    };
    for (const selectedContext of [GLOBAL_CONTEXT, context]) {
      for (const filterValue of [nil, filter]) {
        const selected = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
          if (!row.present || row.filter !== filterValue || ![GLOBAL_CONTEXT, selectedContext].includes(row.context))
            continue;
          const key = JSON.stringify(tuple(row));
          if (row.context === selectedContext || !selected.has(key)) selected.set(key, row);
        }
        const visible = [...selected.values()]
          .filter((row) => row.context === GLOBAL_CONTEXT || !row.suppressed)
          .sort((a, b) => compare(tuple(a), tuple(b)));
        const boundaries = [['', nil, nil], ...keys.map((key) => tuple({ ...rows[0]!, ...key })), ['~', nil, nil]];
        for (const after of boundaries) {
          for (const pageLimit of [1, 2, 26, 80]) {
            const parameters = {
              route,
              subject_id: anchor,
              context_id: selectedContext,
              property: 'schema:author',
              filter_value: filterValue,
              after_order: after[0]!,
              after_statement: after[2]!,
              page_limit: pageLimit,
              scan_limit: null,
            };
            const page =
              direction === 'outbound'
                ? await listOutboundPage.run(pool, { ...parameters, after_target: after[1]! })
                : await listInboundPage.run(pool, { ...parameters, after_source: after[1]! });
            const expected = visible
              .filter((row) => compare(tuple(row), after) > 0)
              .slice(0, pageLimit)
              .map((row) => ({
                property: 'schema:author',
                statement: row.statement,
                type: row.type,
                order_key: row.order,
                ...(direction === 'outbound'
                  ? { slot: row.slot, target: row.target === nil ? null : row.target, external: null, value: row.value }
                  : { subject: row.source }),
              }));
            expect<unknown>({ direction, selectedContext, filterValue, after, pageLimit, page }).toEqual({
              direction,
              selectedContext,
              filterValue,
              after,
              pageLimit,
              page: expected,
            });
          }
        }
      }
    }
  }
}, 60_000);
