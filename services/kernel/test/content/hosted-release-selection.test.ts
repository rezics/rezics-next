import { expect, test } from 'bun:test';
import type { AccessClient } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { hostedReleasePlacements, type HostedPlacementRow } from '../../src/content/hosted-chapters-store.ts';
import { selectHostedRelease } from '../../src/content/hosted-chapters-tree.ts';

function fixture() {
  const route = 7;
  const catalogueId = newId(route),
    revisionId = newId(route);
  const rows: HostedPlacementRow[] = Array.from({ length: 8 }, (_, ordinal) => ({
    occurrence_id: newId(route),
    parent_id: null,
    position: ordinal,
    ordinal,
    title: `Part ${ordinal}`,
    kind: 'part',
    thread_id: null,
    post_id: null,
    target_revision_id: null,
    sha256: null,
  }));
  rows[3]!.parent_id = rows[1]!.occurrence_id;
  rows[3]!.position = 1;
  const byId = new Map(rows.map((row) => [row.occurrence_id, row]));
  const examined: HostedPlacementRow[] = [];
  let queries = 0;
  const client: AccessClient = {
    query: (async (sql: string, values: unknown[]) => {
      queries++;
      expect(values.slice(0, 3)).toEqual([route, catalogueId, revisionId]);
      expect(sql).toContain('p.route=$1 AND p.catalogue_id=$2 AND p.revision_id=$3');
      expect(sql).toContain('p.occurrence_id = ANY($4::uuid[]) ORDER BY p.ordinal');
      // Model the indexed source boundary, separately from manifest output. A
      // whole-revision query must examine all rows even if JS later filters them.
      const selected = (values[3] as string[]).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      examined.push(...selected);
      return { rows: [...new Set(selected)].sort((a, b) => a.ordinal - b.ordinal) };
    }) as AccessClient['query'],
  };
  const release = async (ids: string[]) =>
    selectHostedRelease(await hostedReleasePlacements(client, catalogueId, revisionId, ids), ids);
  return { rows, examined, release, queries: () => queries };
}

test('sparse release reads only explicit source rows and preserves stored order with dense positions', async () => {
  const f = fixture();
  const ids = [f.rows[7]!, f.rows[3]!, f.rows[1]!].map((row) => row.occurrence_id);
  const release = await f.release(ids);
  expect(f.queries()).toBe(1);
  expect(f.examined).toHaveLength(3);
  expect(f.examined.map((row) => row.occurrence_id)).toEqual(ids);
  expect(release.map((row) => [row.occurrenceId, row.parentId, row.position, row.ordinal])).toEqual([
    [ids[2], null, 0, 0],
    [ids[1], ids[2], 0, 1],
    [ids[0], null, 1, 2],
  ]);
  expect(f.rows[7]!.position).toBe(7);
  expect(f.rows[3]!.position).toBe(1);
});

test('withdrawal reads no source placements and invalid selections never refill omitted ancestors or IDs', async () => {
  const f = fixture();
  expect(await f.release([])).toEqual([]);
  expect(f.queries()).toBe(0);
  expect(f.examined).toHaveLength(0);
  const child = f.rows[3]!.occurrence_id;
  await expect(f.release([child])).rejects.toThrow('Release must include selected ancestors');
  await expect(f.release([child, child])).rejects.toThrow('Duplicate selection');
  await expect(f.release([newId(7)])).rejects.toThrow('Unknown occurrence');
  const queries = f.queries();
  await expect(f.release(Array(513).fill(child))).rejects.toThrow();
  expect(f.queries()).toBe(queries);
  expect(f.examined.every((row) => row.occurrence_id === child)).toBe(true);
});
