import { readClients } from '../../../features/admin/api/server.ts';
import { ClientsPage } from '../../../features/admin/clients/clients.tsx';
import { renderAdminPage } from '../../../features/admin/shell/admin-page.tsx';
import { Unavailable } from '../../../features/admin/shell/admin-states.tsx';
import type { PageSearchParams } from '../../../features/shell/search-params.ts';

export default async function AdminClientsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const query = await searchParams;
  const focus = typeof query.client === 'string' ? query.client.slice(0, 256) : null;
  return renderAdminPage('clients', focus ? `/admin/clients?client=${encodeURIComponent(focus)}` : '/admin/clients', async () => {
    const clients = await readClients();
    return clients.status === 'ok' ? <ClientsPage clients={clients.data} focus={focus} /> : <Unavailable />;
  }, 'clients:manage');
}
