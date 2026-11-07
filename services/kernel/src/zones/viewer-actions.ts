import type { ViewerActionResource } from '../access/viewer-actions.ts';
import { routeOf } from '../route/route.ts';
import { zoneResourceAccess } from './resource-access-port.ts';
import read from './viewer-actions.sql';

type ZoneViewerActionRow = Awaited<ReturnType<typeof read.run>>[number];

/** Batch form of the current Zone reader's lifecycle and public eligibility.
 * Owner accounts supply only the existing account fence, never action authority.
 * Native Access resolves current resource grants on this same RR client.
 */
export const zoneViewerActionResource: ViewerActionResource = {
  readAction: 'zone:read',
  async read(client, ids) {
    const rows = await read.run(client, { routes: ids.map((id) => routeOf(id)!), ids: [...ids] });
    const ownerIds = [...new Set(rows.flatMap((row: ZoneViewerActionRow) => (row.ownerId ? [row.ownerId] : [])))];
    const accounts = ownerIds.length ? await zoneResourceAccess().readAccountActionStates(client, ownerIds) : [];
    const active = new Set(
      accounts.filter((account) => account.state === 'active' && !account.fenced).map((account) => account.id),
    );
    // Retain private heads with a false public floor: an explicit current read
    // grant can admit them. Missing or ineligible heads remain absent even with a grant.
    return Object.fromEntries(
      rows
        .filter((row: ZoneViewerActionRow) => row.ownerId && active.has(row.ownerId))
        .map((row: ZoneViewerActionRow) => [row.id, row.public]),
    );
  },
};
