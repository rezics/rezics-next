import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createShelfPageReader } from '../../src/library/shelf-reader-page.ts';
import { createDefaultShelfReads } from '../../src/library/shelf-reader-defaults.ts';
import { readShelfFacets, readShelfSummary } from '../../src/library/shelf-reader-metadata.ts';
import { lookupShelfType } from '../../src/library/shelf-reader-types.ts';
import type { ShelfQuery, ShelfSeek } from '../../src/library/shelf-contract.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { authenticateAccount, admittedAccess } from '../support/admitted-access.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { productionActions } from '../support/production-actions.ts';
import { testTokens } from '../support/test-kernel.ts';

let db: GrowthDatabase;
const route = 0x6a10;
const accountId = newId(route),
  other = newId(route),
  typeId = newId(route);
const nil = '00000000-0000-0000-0000-000000000000';
const ids = [newId(0x7b20), newId(0x7b20), newId(0x7b20)].sort();
const entryless = newId(0x7b20),
  activeId = newId(route);
const type = `schema:${'A'.repeat(8192)}`;
beforeAll(async () => {
  db = await openGrowthDatabase();
  for (const owner of [accountId, other])
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,minimum_authn_epoch,transaction_id)
      VALUES($1,$2,'actor','active',1,$2)`,
      [route, owner],
    );
  for (const [i, subjectId] of ids.entries())
    await db.admin.query(
      `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,
      transaction_id,activity_at,finished_at,type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position)
      VALUES($1,$2,$3,'planned',1,$4,$4,$5,$4,$6,$7,$3,$8,1,0)`,
      [
        route,
        accountId,
        subjectId,
        `2026-10-27T00:00:00.00000${i < 2 ? 1 : 2}Z`,
        newId(route),
        i === 0 ? null : '2026-10-28T00:00:00.123456Z',
        typeId,
        partitionOf(0x7b20),
      ],
    );
  for (const [id, owner, subject, time] of [
    [activeId, accountId, ids[0]!, '2026-10-29'],
    [newId(route), other, ids[0]!, '2026-10-30'],
    [newId(route), accountId, entryless, '2026-10-31'],
  ])
    await db.admin.query(
      `INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,
      completed_unit_count,state,revision,started_at,transaction_id,last_changed_at)
      VALUES($1,$2,$3,$4,'completed_units','chapter',3,'active',1,$5,$2,$5)`,
      [route, id, owner, subject, time],
    );
  await db.admin.query(
    `INSERT INTO library.shelf_type_value(route,account_id,type_id,full_type,byte_length,json_byte_length)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [route, accountId, typeId, type, Buffer.byteLength(type), Buffer.byteLength(JSON.stringify(type))],
  );
  await db.admin.query(
    `INSERT INTO library.shelf_type_root(route,account_id,digest,primary_type_id,root_node_id)
    VALUES($1,$2,$3,$4,$5)`,
    [route, accountId, createHash('sha256').update(type).digest(), typeId, newId(route)],
  );
  for (const [bucket, key, n] of [
    ['all', nil, 19],
    ['planned', nil, 11],
    ['collections', nil, 4],
    ['all', typeId, 3],
    ['planned', typeId, 3],
  ])
    await db.admin.query('INSERT INTO library.shelf_count(route,account_id,bucket,type_id,n) VALUES($1,$2,$3,$4,$5)', [
      route,
      accountId,
      bucket,
      key,
      n,
    ]);
});
afterAll(async () => {
  await db?.close();
});

test('native shelf page enriches only selected owner entries and seeks exact dates, ties and finished nulls', async () => {
  const reader = createShelfPageReader();
  for (const orderBy of ['createdAt', 'lastActivity', 'finishedAt'] as const)
    for (const direction of ['asc', 'desc'] as const) {
      const query: ShelfQuery = { orderBy, direction, limit: 1, state: 'planned', typeId };
      const expected = orderBy === 'finishedAt' ? [ids[1]!, ids[2]!, ids[0]!] : [ids[2]!, ids[0]!, ids[1]!];
      if (direction === 'asc') expected.reverse();
      const got: string[] = [];
      let after: ShelfSeek | null = null;
      for (let step = 0; step < 4; step++) {
        const result = await withReadTransaction(db.pool, (client) =>
          reader.page(client, route, accountId, query, after),
        );
        const entry = result.entries[0]!;
        got.push(entry.subjectId);
        expect(entry.activeProgressSession?.id ?? null).toBe(entry.subjectId === ids[0] ? activeId : null);
        expect(entry.subjectId).not.toBe(entryless);
        if (!result.more) break;
        after = {
          subjectId: entry.subjectId,
          key:
            orderBy === 'createdAt'
              ? entry.createdAt
              : orderBy === 'lastActivity'
                ? entry.lastActivityAt
                : (entry.finishedAt ?? ''),
        };
      }
      expect(got).toEqual(expected);
    }
  const result = await capture(db, () =>
    withReadTransaction(db.pool, (client) =>
      reader.page(
        client,
        route,
        accountId,
        { orderBy: 'createdAt', direction: 'asc', limit: 1, state: null, typeId: null },
        null,
      ),
    ),
  );
  expect(result.value.entries[0]!.createdAt).toContain('000001');
  const sessionStatements = result.capture.statements.filter((statement) =>
    statement.includes('library.progress_session'),
  );
  expect(sessionStatements).toHaveLength(1);
  expect(JSON.stringify(sessionStatements[0])).not.toContain(entryless);
  expect(
    (
      await reader.page(
        db.admin,
        route,
        other,
        { orderBy: 'createdAt', direction: 'desc', limit: 20, state: null, typeId: null },
        null,
      )
    ).entries,
  ).toEqual([]);
});

test('native maintained summary and full-byte facets do not derive totals from the page or invent a ready generation', async () => {
  // These assertions exercise storage readers, not readiness: raw fixture rows cannot publish a native gate.
  const result = await readShelfSummary(db.admin, route, accountId, typeId);
  expect(result.tabs.all).toEqual({ total: 19, shown: 3 });
  expect(result.tabs.planned).toEqual({ total: 11, shown: 3 });
  expect(result.tabs.collections).toEqual({ total: 4, shown: 4 });
  expect(result.tabs.completed).toEqual({ total: 0, shown: 0 });
  expect(await lookupShelfType(db.admin, route, accountId, type)).toBe(typeId);
  expect(await lookupShelfType(db.admin, route, other, type)).toBeNull();
  expect(await lookupShelfType(db.admin, route, accountId, `${type}B`)).toBeNull();
  expect(await readShelfFacets(db.admin, route, accountId, null, 20, 8 * 1024 * 1024)).toEqual({
    types: [{ type, count: 3 }],
    more: false,
    after: typeId,
  });
  expect(await readShelfFacets(db.admin, route, accountId, typeId, 20, 8 * 1024 * 1024)).toEqual({
    types: [],
    more: false,
    after: null,
  });
  await expect(readShelfFacets(db.admin, route, accountId, null, 20, 4224)).rejects.toMatchObject({
    code: 'dependency_unavailable',
  });
});

test('read dependencies bind the normalized owner predicate and effective page size', async () => {
  const access = admittedAccess({ actions: productionActions() });
  const actor = await authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 5000 },
    {
      accountId,
      clientId: 'native-shelf-read',
      scopes: ['library_entry:list'],
    },
  );
  const reads = createDefaultShelfReads({ pool: db.pool, access, tokens: testTokens(), clock: () => new Date() });
  await expect(reads.summary(actor, {})).rejects.toMatchObject({
    name: 'ShelfReadUnavailableError',
    code: 'dependency_unavailable',
  });
  await expect(reads.listTypes(actor, {})).rejects.toMatchObject({
    name: 'ShelfReadUnavailableError',
    code: 'dependency_unavailable',
  });
  await expect(reads.listShelf(actor, { orderBy: 'createdAt' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(reads.summary({ ...actor }, {})).rejects.toMatchObject({ code: 'forbidden' });
  await expect(reads.summary(actor, { accountId: other } as {})).rejects.toMatchObject({ code: 'invalid_argument' });
  await expect(reads.listTypes(actor, { limit: 101 })).rejects.toMatchObject({ code: 'invalid_argument' });
  // The existing opaque codec binding includes the resolved private key and the effective default size.
  const { encodeListCursor, decodeListCursor } = await import('../../src/tokens/list-cursor.ts');
  const { shelfCursorBinding, normalizeShelfQuery } = await import('../../src/library/shelf-contract.ts');
  const binding = shelfCursorBinding(accountId, normalizeShelfQuery({ orderBy: 'finishedAt', typeId }));
  const ring = testTokens(),
    now = new Date();
  const cursor = await encodeListCursor(ring, binding, { epoch: 1, after: ['', ids[0]!] }, now);
  expect(await decodeListCursor(ring, binding, cursor, now)).toEqual({ ok: true, epoch: 1, after: ['', ids[0]!] });
  for (const changed of [{ limit: 1 }, { typeId: null }, { direction: 'asc' }, { state: 'planned' }])
    expect(
      (await decodeListCursor(ring, { ...binding, query: { ...binding.query, ...changed } }, cursor, now)).ok,
    ).toBe(false);
  expect((await decodeListCursor(ring, { ...binding, viewer: other }, cursor, now)).ok).toBe(false);
});
