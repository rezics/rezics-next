import { readAudit, readOperators, readSanctions, readUser } from '../../../../features/admin/api/server.ts';
import { renderAdminPage } from '../../../../features/admin/shell/admin-page.tsx';
import { NotFound, Unavailable } from '../../../../features/admin/shell/admin-states.tsx';
import { UserPage } from '../../../../features/admin/user/user-page.tsx';
import { type TabData, userTabs, type UserTab } from '../../../../features/admin/user/tabs.ts';
import type { PageSearchParams } from '../../../../features/shell/search-params.ts';

export default async function AdminUserPage({ params, searchParams }: { params: Promise<{ userId: string }>;
  searchParams: PageSearchParams }) {
  const [{ userId }, query] = await Promise.all([params, searchParams]);
  const requested = typeof query.tab === 'string' ? query.tab : 'overview';
  const tab: UserTab = userTabs.includes(requested as UserTab) ? requested as UserTab : 'overview';
  const self = `/admin/users/${encodeURIComponent(userId)}${tab === 'overview' ? '' : `?tab=${tab}`}`;
  return renderAdminPage('users', self, async ({ me }) => {
    const detail = await readUser(userId);
    if (detail.status === 'not-found') return <NotFound />;
    if (detail.status !== 'ok') return <Unavailable />;
    let data: TabData = { tab: tab === 'audit' && !me.permissions.includes('audit:read') ? 'overview' : tab } as TabData;
    if (data.tab === 'sanctions' || data.tab === 'audit') {
      const page = data.tab === 'sanctions' ? await readSanctions(userId) : await readAudit({ targetId: userId });
      if (page.status !== 'ok') return <Unavailable />;
      data = { tab: data.tab, page: page.data };
    } else if (data.tab === 'roles') {
      const operators = await readOperators();
      data = { tab: 'roles', permissions: operators.status === 'ok' ? operators.data.permissions : null };
    }
    return <UserPage key={userId} initial={detail.data} data={data} />;
  });
}
