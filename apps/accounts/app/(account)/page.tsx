import { AccountHome } from '../../features/account/account-home.tsx';
import { renderAccountPage } from '../../features/account/account-page.tsx';
import { checkupView } from '../../features/account/views.ts';
import { readConnectedApps, readSecurityActivity, readSessions } from '../../features/api/server.ts';

export default async function HomePage() {
  return renderAccountPage('home', async ({ session, methods, locale, now }) => {
    const [sessions, apps, activity] = await Promise.all([readSessions(), readConnectedApps(), readSecurityActivity()]);
    const checkup = checkupView({ user: session.user, methods, sessions, activity, apps, now, locale, recent: 0 });
    return <AccountHome summary={{ user: session.user, issues: checkup.issues, checkupComplete: checkup.complete,
      failedSignIns: checkup.failedSignIns,
      unusedApps: checkup.apps.status === 'ok' ? checkup.apps.items.filter(app => app.unused).length : 0,
      security: checkup.signIn ? { passkeys: checkup.signIn.passkeys, twoStep: checkup.signIn.twoStep } : null,
      devices: checkup.devices.status === 'ok' ? checkup.devices.items.length : null,
      apps: checkup.apps.status === 'ok' ? checkup.apps.items.length : null }} />;
  });
}
