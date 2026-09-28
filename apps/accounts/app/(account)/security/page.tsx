import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { SecurityOverview } from '../../../features/account/security.tsx';
import { checkupView } from '../../../features/account/views.ts';
import { readConnectedApps, readSecurityActivity, readSessions } from '../../../features/api/server.ts';

/** How many recent events the overview shows before "Review security activity". */
const RECENT = 4;

export default async function SecurityPage() {
  return renderAccountPage('security', async ({ session, methods, locale, now }) => {
    const [sessions, activity, apps] = await Promise.all([readSessions(), readSecurityActivity(), readConnectedApps()]);
    const checkup = checkupView({ user: session.user, methods, sessions, activity, apps, now, locale, recent: RECENT });
    return <SecurityOverview failedSignIns={checkup.failedSignIns} issues={checkup.issues}
      checkupComplete={checkup.complete}
      unusedApps={checkup.apps.status === 'ok' ? checkup.apps.items.filter(app => app.unused).length : 0}
      signIn={checkup.signIn} devices={checkup.devices} activity={checkup.activity} />;
  });
}
