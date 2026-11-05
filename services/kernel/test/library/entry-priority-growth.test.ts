import { expect, test } from 'bun:test';
import { createEntryPriorityReaders } from '../../src/library/entry-priority-page.ts';
import type { ShelfQuery } from '../../src/library/shelf-contract.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';

const route = 0x6a38;
const at = '2026-10-20T00:00:00.000001Z';
type PriorityRow = { subjectId: string; state: string; typeId: string; priority: number | null };

function ordered(rows: PriorityRow[], direction: 'asc' | 'desc'): PriorityRow[] {
  return [...rows].sort((a, b) => {
    if (a.priority === null && b.priority !== null) return 1;
    if (b.priority === null && a.priority !== null) return -1;
    if (a.priority !== null && b.priority !== null && a.priority !== b.priority)
      return direction === 'asc' ? a.priority - b.priority : b.priority - a.priority;
    return a.subjectId.localeCompare(b.subjectId);
  });
}

for (const scale of [64, 512, 4096])
  test(`priority pages filter and order the complete owner population at ${scale} rows`, async () => {
    const db = await openGrowthDatabase();
    const foreignRoute = route + 0x1000;
    const owner = newId(route);
    const foreign = newId(route);
    const remote = newId(foreignRoute);
    const typeA = newId(route);
    const typeB = newId(route);
    const remoteType = newId(foreignRoute);
    const readers = createEntryPriorityReaders();
    const ownerRows: PriorityRow[] = Array.from({ length: scale }, (_, index) => ({
      subjectId: newId(0x7b20),
      state: index % 17 === 0 ? 'paused' : index % 7 === 0 ? 'completed' : 'planned',
      typeId: index % 5 === 0 ? typeB : typeA,
      priority: index % 17 === 0 || index % 13 === 0 ? null : (index % 100) + 1,
    }));
    const unrelatedRows: PriorityRow[] = Array.from({ length: scale }, () => ({
      subjectId: newId(0x7b20),
      state: 'planned',
      typeId: typeA,
      priority: 1,
    }));

    async function insert(accountId: string, ownerRoute: number, rows: PriorityRow[]) {
      const transactions = rows.map(() => newId(ownerRoute));
      await db.admin.query(
        `INSERT INTO library.entry
          (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,activity_at,finished_at,
           type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position)
         SELECT $1,$2,x.subject_id,x.state,1,$3,$3,x.transaction_id,$3,NULL,x.type_id,x.subject_id,$4,1,0
         FROM unnest($5::uuid[],$6::text[],$7::uuid[],$8::uuid[]) AS x(subject_id,state,type_id,transaction_id)`,
        [
          ownerRoute,
          accountId,
          at,
          partitionOf(0x7b20),
          rows.map((row) => row.subjectId),
          rows.map((row) => row.state),
          rows.map((row) => row.typeId),
          transactions,
        ],
      );
      const ranked = rows.filter((row) => row.priority !== null);
      if (ranked.length)
        await db.admin.query(
          `INSERT INTO library.entry_personal_fact
            (route,account_id,subject_id,fact_id,annotation_revision,note,priority,annotation_updated_at,
             annotation_transaction_id,created_at,updated_at,transaction_id)
           SELECT $1,$2,x.subject_id,x.fact_id,1,NULL,x.priority,$3,x.transaction_id,$3,$3,x.transaction_id
           FROM unnest($4::uuid[],$5::uuid[],$6::smallint[],$7::uuid[])
             AS x(subject_id,fact_id,priority,transaction_id)`,
          [
            ownerRoute,
            accountId,
            at,
            ranked.map((row) => row.subjectId),
            ranked.map(() => newId(ownerRoute)),
            ranked.map((row) => row.priority),
            ranked.map(() => newId(ownerRoute)),
          ],
        );
    }

    async function page(
      direction: 'asc' | 'desc',
      state: ShelfQuery['state'],
      typeId: ShelfQuery['typeId'],
      limit: number,
    ) {
      const query: ShelfQuery = { state, typeId, orderBy: 'priority', direction, limit };
      return readers[direction].page(db.pool, route, owner, query, null);
    }

    try {
      await insert(owner, route, ownerRows);
      await insert(foreign, route, unrelatedRows);
      await insert(
        remote,
        foreignRoute,
        unrelatedRows.map((row) => ({ ...row, typeId: remoteType })),
      );

      const allExpected = ordered(ownerRows, 'asc');
      const all = await page('asc', null, null, 19);
      expect(all.entries.map((row) => [row.subjectId, row.priority])).toEqual(
        allExpected.slice(0, 19).map((row) => [row.subjectId, row.priority]),
      );
      expect(all.more).toBe(allExpected.length > 19);

      const matching = ownerRows.filter((row) => row.state === 'planned' && row.typeId === typeA);
      for (const direction of ['asc', 'desc'] as const) {
        const expected = ordered(matching, direction);
        const filtered = await page(direction, 'planned', typeA, 17);
        expect(filtered.entries.map((row) => [row.subjectId, row.priority])).toEqual(
          expected.slice(0, 17).map((row) => [row.subjectId, row.priority]),
        );
        expect(filtered.more).toBe(expected.length > 17);
      }

      const target = matching.find((row) => row.priority !== null)!;
      await db.admin.query(
        `UPDATE library.entry_personal_fact
         SET priority=1,annotation_revision=annotation_revision+1,annotation_updated_at=$4,
             annotation_transaction_id=$5,updated_at=$4,transaction_id=$5
         WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
        [route, owner, target.subjectId, at, newId(route)],
      );
      const moved = { ...target, priority: 1 };
      const afterMutation = ordered(
        matching.map((row) => (row.subjectId === target.subjectId ? moved : row)),
        'asc',
      );
      const mutatedPage = await page('asc', 'planned', typeA, 3);
      expect(mutatedPage.entries.map((row) => [row.subjectId, row.priority])).toEqual(
        afterMutation.slice(0, 3).map((row) => [row.subjectId, row.priority]),
      );

      const unranked = await page('asc', 'paused', typeA, 17);
      expect(unranked.entries.length).toBeGreaterThan(0);
      expect(unranked.entries.every((row) => row.priority === null)).toBe(true);
    } finally {
      const accounts = [owner, foreign, remote];
      try {
        await db.admin.query('DELETE FROM library.entry_personal_fact WHERE account_id=ANY($1::uuid[])', [accounts]);
        await db.admin.query('DELETE FROM library.entry WHERE account_id=ANY($1::uuid[])', [accounts]);
      } finally {
        await db.close();
      }
    }
  }, 180_000);
