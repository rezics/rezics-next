import type { Pool, PoolClient } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import viewsRead from './account-views-read.sql';

export type PublicViews = Readonly<{ posts: boolean; reviews: boolean; collections: boolean }>;

/** Presentation visibility only: callers still enforce each item's own visibility. */
export async function readPublicViews(
  client: Pick<Pool | PoolClient, 'query'>,
  accountIds: readonly string[],
): Promise<Map<string, PublicViews>> {
  if (accountIds.length > 100) throw new RangeError('Public view batches must contain at most 100 ids');
  const results = new Map<string, PublicViews>();
  const groups = new Map<number, { routes: number[]; ids: string[] }>();
  for (const id of new Set(accountIds)) {
    results.set(id, { posts: false, reviews: false, collections: false });
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    let group = groups.get(partition);
    if (!group) {
      group = { routes: [], ids: [] };
      groups.set(partition, group);
    }
    group.routes.push(route);
    group.ids.push(id);
  }
  for (const [partition, { routes, ids }] of groups) {
    const rows = await viewsRead.run(client, { partition, routes, account_ids: ids });
    for (const row of rows) {
      const flags = row.publicViews as Partial<PublicViews> | null;
      results.set(row.accountId, {
        posts: flags?.posts === true,
        reviews: flags?.reviews === true,
        collections: flags?.collections === true,
      });
    }
  }
  return results;
}
