import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { describeUserAgent } from '../../../features/account/device.ts';
import { relativeTime } from '../../../features/account/format.ts';
import { type DevicesView, SecurityOverview } from '../../../features/account/security.tsx';
import { readDeviceSessions, readLinkedAccounts } from '../../../features/api/server.ts';
import { getTranslation, requestLocale } from '../../../i18n/server.ts';

export default async function SecurityPage() {
  return renderAccountPage('security', async ({ sessionId }) => {
    const [accounts, sessions, locale] = await Promise.all([readLinkedAccounts(), readDeviceSessions(),
      requestLocale()]);
    const { t } = await getTranslation('account', [locale]);
    const now = new Date();
    const devices: DevicesView = sessions.status === 'ok' ? { status: 'ok', items: sessions.data
      .toSorted((a, b) => Number(b.id === sessionId) - Number(a.id === sessionId)
        || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map(session => {
        const device = describeUserAgent(session.userAgent);
        const current = session.id === sessionId;
        return { id: session.id, token: session.token, current, kind: device.kind,
          title: device.browser && device.os ? t.deviceOn({ browser: device.browser, os: device.os })
            : device.browser ?? device.os ?? t.unknownDevice,
          activity: current ? t.activeNow : t.lastActive({ time: relativeTime(session.updatedAt, now, locale) }) };
      }) } : { status: sessions.status === 'stale' ? 'stale' : 'unavailable' };
    return <SecurityOverview devices={devices} hasPassword={accounts.status === 'ok'
      ? accounts.data.some(account => account.providerId === 'credential') : null} />;
  });
}
