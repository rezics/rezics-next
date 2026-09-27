import { AccountHome } from '../../features/account/account-home.tsx';
import { count, renderAccountPage } from '../../features/account/account-page.tsx';
import { readConsents, readDeviceSessions, readLinkedAccounts } from '../../features/api/server.ts';

export default async function HomePage() {
  return renderAccountPage('home', async ({ user }) => {
    const [accounts, devices, consents] = await Promise.all([readLinkedAccounts(), readDeviceSessions(),
      readConsents()]);
    return <AccountHome summary={{ user, signInMethods: count(accounts), devices: count(devices),
      apps: count(consents) }} />;
  });
}
