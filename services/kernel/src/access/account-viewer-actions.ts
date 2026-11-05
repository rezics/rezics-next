import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { ViewerActionResource } from './viewer-actions.ts';
import read from './account-viewer-actions.sql';

/** Shared update-command anchor selection. This selects a formula, never grants it. */
export function accountProfileAuthorityAnchor(
  account: { kind: string; state: string; operatorAccountId: string | null } | null | undefined,
  accountId: string,
) {
  const operatorId = account?.kind === 'actor' && account.state === 'active' ? account.operatorAccountId : null;
  return { operatorId, id: operatorId ?? accountId, action: operatorId ? 'account:manage' : 'account:update' } as const;
}

/** Shared full-key read for native Account authority and public eligibility. */
export function readAccountActionStates(client: AccessClient, ids: readonly string[]) {
  return read.run(client, { routes: ids.map((id) => routeOf(id)!), ids: [...ids] });
}

export const accountViewerActionResource: ViewerActionResource = {
  readAction: 'account:read_public_identity',
  async read(client, ids) {
    const rows = await readAccountActionStates(client, ids);
    // A private management reference never distinguishes a pending, fenced or
    // deleted account from an unknown key, even with an independent read grant.
    return Object.fromEntries(rows.filter((row) => row.state === 'active' && !row.fenced).map((row) => [row.id, true]));
  },
};
