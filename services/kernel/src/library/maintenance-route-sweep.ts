import type { Pool } from 'pg';
import { withBoundedReadConnection } from '../database/pool.ts';
import { PARTITIONS, ROUTES, partitionOf } from '../route/route.ts';
import { workStepDeadline } from './collection-command-work.ts';

const firstRoute = {
  bulk: 'SELECT route FROM library.bulk_operation WHERE route >= $1 ORDER BY route LIMIT 1',
  consolidation: 'SELECT route FROM library.label_consolidation WHERE route >= $1 ORDER BY route LIMIT 1',
  annotation: 'SELECT route FROM library.entry_annotation_review WHERE route >= $1 ORDER BY route LIMIT 1',
  entry: 'SELECT route FROM library.entry WHERE route >= $1 ORDER BY route LIMIT 1',
  labels: `SELECT route FROM (
    (SELECT route FROM library.personal_label WHERE route >= $1 AND deleted_at IS NOT NULL ORDER BY route LIMIT 1)
    UNION ALL
    (SELECT route FROM library.label_assignment WHERE route >= $1 AND deleted_at IS NOT NULL ORDER BY route LIMIT 1)
  ) candidates ORDER BY route LIMIT 1`,
};

/** A route-leading index locates a possible owner. Its native page still verifies eligibility and custody. */
export async function nextMaintenanceRoute(pool: Pool, family: keyof typeof firstRoute, from: number) {
  const result = await withBoundedReadConnection(pool, workStepDeadline(), (client) =>
    client.query<{ route: number }>(firstRoute[family], [from]),
  );
  return result.rows[0]?.route;
}

type Frontier = { partition: number; after: string | null };
type Page = { next: string | null; nextPartition?: number };

export async function maintenancePartitionPage(
  pool: Pool,
  family: Exclude<keyof typeof firstRoute, 'bulk'>,
  partition: number,
  after: string | null,
  read: (partition: number, after: string | null) => Promise<Page>,
) {
  // A retained cursor can refer to a parent or child already removed. Its owner decides how to resume it.
  if (after === null) {
    const route = await nextMaintenanceRoute(pool, family, partition * (ROUTES / PARTITIONS));
    if (route === undefined) return { next: null, nextPartition: PARTITIONS };
    partition = partitionOf(route);
  }
  const page = await read(partition, after);
  return { ...page, nextPartition: page.next === null ? partition + 1 : partition };
}

export async function advanceMaintenanceSegment(
  { partition, after }: Frontier,
  page: (partition: number, after: string | null) => Promise<Page>,
): Promise<Frontier> {
  for (let n = 0; n < 100 && partition < PARTITIONS; n++) {
    const result = await page(partition, after);
    after = result.next;
    // Steps committed before route discovery returned only their local cursor.
    partition = result.nextPartition ?? (after === null ? partition + 1 : partition);
  }
  return { partition, after };
}
