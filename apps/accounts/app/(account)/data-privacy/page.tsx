import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { DataPrivacy } from '../../../features/account/data-privacy.tsx';
import { readConnectedApps } from '../../../features/api/server.ts';

export default async function DataPrivacyPage() {
  return renderAccountPage('data-privacy', async () => {
    const apps = await readConnectedApps();
    return <DataPrivacy apps={apps.status === 'ok' ? apps.data.items.length : null} />;
  });
}
