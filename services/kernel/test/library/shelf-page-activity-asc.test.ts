import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, partitionOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createShelfActivityAscReader } from '../../src/library/shelf-page-activity-asc.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('fixed predicates seek dates nulls and ties without population work', async () => {
  const route = 0x6a10,
    owner = newId(route),
    foreign = newId(route),
    types = [newId(route), newId(route)];
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: newId(0x7b20),
    state: i % 2 ? 'planned' : 'completed',
    type: types[Math.floor(i / 2) % 2]!,
    key: `2026-10-27T00:00:00.${String(Math.floor(i / 2) + 1).padStart(6, '0')}Z`,
  }));
  for (const row of rows)
    await db.admin.query(
      'INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,activity_at,finished_at,type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,1,0)',
      [
        route,
        owner,
        row.id,
        row.state,
        '2026-10-20T00:00:00.000001Z',
        '2026-10-21T00:00:00.000001Z',
        newId(route),
        row.key,
        null,
        row.type,
        row.id,
        partitionOf(0x7b20),
      ],
    );
  const reader = createShelfActivityAscReader();
  for (const state of [null, 'planned'] as const)
    for (const typeId of [null, types[0]!] as const)
      for (const limit of [1, 48]) {
        const expected = rows
          .filter((r) => (state === null || r.state === state) && (typeId === null || r.type === typeId))
          .sort((a, b) => {
            let cmp = a.key === b.key ? 0 : a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? 1 : -1;
            if (cmp === 0) cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            return -cmp;
          })
          .map((r) => r.id);
        const got: string[] = [];
        let after: { key: string; subjectId: string } | null = null;
        for (let page = 0; page < 20; page++) {
          const result = await reader.page(
            db.admin,
            route,
            owner,
            { state, typeId, orderBy: 'lastActivity', direction: 'asc', limit },
            after,
          );
          expect(result.entries.length).toBeLessThanOrEqual(limit);
          got.push(...result.entries.map((r) => r.subjectId));
          if (!result.more) break;
          expect(result.entries.length).toBeGreaterThan(0);
          const last = result.entries.at(-1)!;
          after = { key: last.lastActivityAt ?? '', subjectId: last.subjectId };
        }
        expect(got).toEqual(expected);
        const hidden = await reader.page(
          db.admin,
          route,
          foreign,
          { state, typeId, orderBy: 'lastActivity', direction: 'asc', limit },
          null,
        );
        expect(hidden.entries).toEqual([]);
      }
});
