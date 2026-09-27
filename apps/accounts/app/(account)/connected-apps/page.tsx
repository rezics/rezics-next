import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { SectionHeading } from '../../../features/account/account-shell.tsx';
import { ConnectedApps } from '../../../features/account/connected-apps.tsx';
import { calendarDate } from '../../../features/account/format.ts';
import { readConsents, readPublicClient } from '../../../features/api/server.ts';
import { ReadStatePanel } from '../../../features/shell/state-panel.tsx';
import { getTranslation, requestLocale } from '../../../i18n/server.ts';

export default async function ConnectedAppsPage() {
  return renderAccountPage('connected-apps', async () => {
    const [consents, locale] = await Promise.all([readConsents(), requestLocale()]);
    if (consents.status !== 'ok') {
      const { t } = await getTranslation('account', [locale]);
      return <><SectionHeading title={t.connectedApps} intro={t.appsIntro} />
        <ReadStatePanel status={consents.status} next="/connected-apps" /></>;
    }
    // A removed or disabled app has no public record; it is still listed so
    // its access can be revoked.
    const clients = await Promise.all(consents.data.map(consent => readPublicClient(consent.clientId)));
    return <ConnectedApps apps={consents.data.map((consent, index) => {
      const client = clients[index]?.status === 'ok' ? clients[index].data : null;
      return { consentId: consent.id, name: client?.name ?? null, logo: client?.logo ?? null,
        uri: client?.uri ?? null, scopes: consent.scopes, since: calendarDate(consent.createdAt, locale) };
    })} />;
  });
}
