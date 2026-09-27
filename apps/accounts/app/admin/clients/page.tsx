import { readClients } from '../../../features/admin/api/server.ts';
import { ClientsPage } from '../../../features/admin/clients/clients.tsx';
import { renderAdminPage } from '../../../features/admin/shell/admin-page.tsx';
import { Unavailable } from '../../../features/admin/shell/admin-states.tsx';

export default async function AdminClientsPage() {
  return renderAdminPage('clients', '/admin/clients', async () => {
    const clients = await readClients();
    return clients.status === 'ok' ? <ClientsPage clients={clients.data} /> : <Unavailable />;
  }, 'clients:manage');
}
