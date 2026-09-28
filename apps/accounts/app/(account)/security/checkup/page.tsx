import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { SecurityCheckup } from '../../../../features/account/security-checkup.tsx';
import { checkupView } from '../../../../features/account/views.ts';
import { readConnectedApps, readSecurityActivity, readSessions } from '../../../../features/api/server.ts';

export default async function SecurityCheckupPage() {
  return renderAccountPage('security', async ({ session, methods, locale, now }) => {
    const [sessions, activity, apps] = await Promise.all([readSessions(), readSecurityActivity(), readConnectedApps()]);
    return <SecurityCheckup checkup={checkupView({ user: session.user, methods, sessions, activity, apps, now, locale })} />;
  }, '/security/checkup');
}
