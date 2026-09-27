import { securityCheckup } from '../../../features/account/activity.ts';
import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { calendarDate } from '../../../features/account/format.ts';
import { SecurityOverview } from '../../../features/account/security.tsx';
import { activityPage, deviceViews } from '../../../features/account/views.ts';
import { readSecurityActivity, readSessions } from '../../../features/api/server.ts';

/** How many recent events the overview shows before "Review security activity". */
const RECENT = 4;

export default async function SecurityPage() {
  return renderAccountPage('security', async ({ session, methods, locale, now }) => {
    const [sessions, activity] = await Promise.all([readSessions(), readSecurityActivity()]);
    const known = methods.status === 'ok' ? methods.data : null;
    const failed = activity.status === 'ok' ? activity.data.failedLast24Hours.count : null;
    return <SecurityOverview failedSignIns={failed ?? 0}
      issues={securityCheckup({ emailVerified: session.user.emailVerified, methods: known, failedLast24Hours: failed })}
      signIn={known ? { password: known.password, passkeys: known.passkeys.length, twoStep: known.totp?.verified === true,
        passwordChanged: known.passwordChangedAt ? calendarDate(known.passwordChangedAt, locale) : null } : null}
      devices={sessions.status === 'ok' ? { status: 'ok', items: deviceViews(sessions.data.items, now, locale) }
        : { status: 'unavailable' }}
      activity={activity.status === 'ok' ? { status: 'ok',
        entries: activityPage(activity.data, now, locale).entries.slice(0, RECENT) } : { status: 'unavailable' }} />;
  });
}
