import { readOperators } from '../../../features/admin/api/server.ts';
import { renderAdminPage } from '../../../features/admin/shell/admin-page.tsx';
import { Unavailable } from '../../../features/admin/shell/admin-states.tsx';
import { StaffPage } from '../../../features/admin/staff/staff.tsx';

export default async function AdminStaffPage() {
  return renderAdminPage('staff', '/admin/staff', async () => {
    const operators = await readOperators();
    return operators.status === 'ok' ? <StaffPage operators={operators.data} /> : <Unavailable />;
  });
}
