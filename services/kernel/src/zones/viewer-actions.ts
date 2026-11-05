import { readAccountActionStates } from '../access/account-viewer-actions.ts';
import type { ViewerActionResource } from '../access/viewer-actions.ts';
import { routeOf } from '../route/route.ts';
import read from './viewer-actions.sql';

/** Batch form of the current Zone reader's lifecycle and public eligibility.
 * Owner accounts supply only the existing account fence, never action authority.
 * Native Access resolves current resource grants on this same RR client.
 */
export const zoneViewerActionResource: ViewerActionResource = {
  readAction: 'zone:read',
  async read(client, ids) {
    const rows = await read.run(client, { routes: ids.map((id) => routeOf(id)!), ids: [...ids] });
    const ownerIds = [...new Set(rows.flatMap((row) => (row.ownerId ? [row.ownerId] : [])))];
    const accounts = ownerIds.length ? await readAccountActionStates(client, ownerIds) : [];
    const active = new Set(
      accounts.filter((account) => account.state === 'active' && !account.fenced).map((a) => a.id),
    );
    // Retain private heads with a false public floor: an explicit current read
    // grant can admit them. Missing or ineligible heads remain absent even with a grant.
    return Object.fromEntries(
      rows.filter((row) => row.ownerId && active.has(row.ownerId)).map((row) => [row.id, row.public]),
    );
  },
};
