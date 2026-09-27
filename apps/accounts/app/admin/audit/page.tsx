import { readAudit, readUser } from '../../../features/admin/api/server.ts';
import { type AuditRead, AuditExplorer } from '../../../features/admin/audit/audit-explorer.tsx';
import { auditHref, auditParams, readAuditState } from '../../../features/admin/audit/state.ts';
import { renderAdminPage } from '../../../features/admin/shell/admin-page.tsx';
import type { PageSearchParams } from '../../../features/shell/search-params.ts';

export default async function AdminAuditPage({ searchParams }: { searchParams: PageSearchParams }) {
  const state = readAuditState(await searchParams);
  return renderAdminPage('audit', auditHref(state), async () => {
    const name = async (id: string | null) => {
      if (!id) return null;
      const user = await readUser(id);
      return user.status === 'ok' ? user.data.profile.name || user.data.profile.email : null;
    };
    const [audit, actor, target] = await Promise.all([readAudit(auditParams(state)), name(state.actor), name(state.target)]);
    const initial: AuditRead = audit.status === 'ok' ? { status: 'ok', data: audit.data }
      : { status: 'error', code: audit.status === 'forbidden' ? 'forbidden' : 'temporarily_unavailable' };
    return <AuditExplorer initialState={state} initial={initial} names={{ actor, target }} />;
  }, 'audit:read');
}
