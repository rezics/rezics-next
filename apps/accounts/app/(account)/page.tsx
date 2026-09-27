import { securityCheckup } from '../../features/account/activity.ts';
import { AccountHome } from '../../features/account/account-home.tsx';
import { renderAccountPage } from '../../features/account/account-page.tsx';
import { readConnectedApps, readSecurityActivity, readSessions } from '../../features/api/server.ts';

export default async function HomePage() {
  return renderAccountPage('home', async ({ session, methods }) => {
    const [sessions, apps, activity] = await Promise.all([readSessions(), readConnectedApps(), readSecurityActivity()]);
    const known = methods.status === 'ok' ? methods.data : null;
    const failed = activity.status === 'ok' ? activity.data.failedLast24Hours.count : null;
    return <AccountHome summary={{ user: session.user, failedSignIns: failed ?? 0,
      issues: securityCheckup({ emailVerified: session.user.emailVerified, methods: known, failedLast24Hours: failed }),
      security: known ? { passkeys: known.passkeys.length, twoStep: known.totp?.verified === true } : null,
      devices: sessions.status === 'ok' ? sessions.data.items.length : null,
      apps: apps.status === 'ok' ? apps.data.items.length : null }} />;
  });
}
