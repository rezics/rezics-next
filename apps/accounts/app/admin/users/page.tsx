import { readDirectory } from '../../../features/admin/api/server.ts';
import { renderAdminPage } from '../../../features/admin/shell/admin-page.tsx';
import { type DirectoryRead, UserDirectory } from '../../../features/admin/users/directory.tsx';
import { directoryParams, readState, stateHref } from '../../../features/admin/users/state.ts';
import type { PageSearchParams } from '../../../features/shell/search-params.ts';

export default async function AdminUsersPage({ searchParams }: { searchParams: PageSearchParams }) {
  const state = readState(await searchParams);
  return renderAdminPage('users', stateHref(state), async ({ preferences }) => {
    const directory = await readDirectory(directoryParams(state));
    // A stale cursor (the data moved, or the link is old) is shown as an error
    // the operator can leave with First page, never as a silent empty list.
    const initial: DirectoryRead = directory.status === 'ok' ? { status: 'ok', data: directory.data }
      : { status: 'error', code: directory.status === 'forbidden' ? 'forbidden' : 'temporarily_unavailable' };
    return <UserDirectory initialState={state} initial={initial} preferences={preferences} />;
  });
}
