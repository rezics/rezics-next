import { readAudit, readOperators, readTimeline, readUser } from '../../../../features/admin/api/server.ts';
import { renderAdminPage } from '../../../../features/admin/shell/admin-page.tsx';
import { NotFound, Unavailable } from '../../../../features/admin/shell/admin-states.tsx';
import { UserPage } from '../../../../features/admin/user/user-page.tsx';
import { type TabData, timelineShows, userTabs, type UserTab } from '../../../../features/admin/user/tabs.ts';
import type { PageSearchParams } from '../../../../features/shell/search-params.ts';
import type { TimelineCategory } from '../../../../features/admin/api/types.ts';

export default async function AdminUserPage({ params, searchParams }: { params: Promise<{ userId: string }>;
  searchParams: PageSearchParams }) {
  const [{ userId }, query] = await Promise.all([params, searchParams]);
  const requested = typeof query.tab === 'string' ? query.tab : 'overview';
  // Sanctions became the timeline's staff view; old links still land there.
  const tab: UserTab = requested === 'sanctions' ? 'overview' : userTabs.includes(requested as UserTab) ? requested as UserTab : 'overview';
  const shown = requested === 'sanctions' ? 'staff' : typeof query.show === 'string' ? query.show : 'all';
  const show: TimelineCategory = timelineShows.includes(shown as TimelineCategory) ? shown as TimelineCategory : 'all';
  const self = `/admin/users/${encodeURIComponent(userId)}${tab !== 'overview' ? `?tab=${tab}` : show !== 'all' ? `?show=${show}` : ''}`;
  return renderAdminPage('users', self, async ({ me }) => {
    const detail = await readUser(userId);
    if (detail.status === 'not-found') return <NotFound />;
    if (detail.status !== 'ok') return <Unavailable />;
    const current = tab === 'audit' && !me.permissions.includes('audit:read') ? 'overview' : tab;
    let data: TabData;
    if (current === 'audit') {
      const page = await readAudit({ targetId: userId });
      if (page.status !== 'ok') return <Unavailable />;
      data = { tab: 'audit', page: page.data };
    } else if (current === 'roles') {
      const operators = await readOperators();
      data = { tab: 'roles', permissions: operators.status === 'ok' ? operators.data.permissions : null };
    } else if (current === 'overview') {
      data = { tab: 'overview', show };
      if (show !== 'all') {
        const timeline = await readTimeline(userId, show);
        if (timeline.status !== 'ok') return <Unavailable />;
        detail.data.timeline = timeline.data;
      }
    } else data = { tab: current };
    return <UserPage key={userId} initial={detail.data} data={data} />;
  });
}
