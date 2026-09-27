import { readOverview } from '../../features/admin/api/server.ts';
import { Overview } from '../../features/admin/overview/overview.tsx';
import { renderAdminPage } from '../../features/admin/shell/admin-page.tsx';
import { Unavailable } from '../../features/admin/shell/admin-states.tsx';

export default async function AdminOverviewPage() {
  return renderAdminPage('overview', '/admin', async () => {
    const overview = await readOverview();
    return overview.status === 'ok' ? <Overview data={overview.data} /> : <Unavailable />;
  });
}
