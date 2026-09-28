import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { DevicesPage } from '../../../../features/account/devices-page.tsx';
import { deviceViews } from '../../../../features/account/views.ts';
import { readSessions } from '../../../../features/api/server.ts';

export default async function YourDevicesPage() {
  return renderAccountPage('security', async ({ locale, now }) => {
    const sessions = await readSessions();
    return <DevicesPage devices={sessions.status === 'ok'
      ? { status: 'ok', items: deviceViews(sessions.data.items, now, locale) } : { status: 'unavailable' }} />;
  }, '/security/devices');
}
