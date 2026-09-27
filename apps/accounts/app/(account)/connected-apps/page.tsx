import { renderAccountPage } from '../../../features/account/account-page.tsx';
import { SectionHeading } from '../../../features/account/account-shell.tsx';
import { ConnectedApps } from '../../../features/account/connected-apps.tsx';
import { connectedAppViews } from '../../../features/account/views.ts';
import { readConnectedApps } from '../../../features/api/server.ts';
import { ReadStatePanel } from '../../../features/shell/state-panel.tsx';

export default async function ConnectedAppsPage() {
  return renderAccountPage('connected-apps', async ({ locale, now, t }) => {
    const apps = await readConnectedApps();
    if (apps.status !== 'ok') {
      return <><SectionHeading title={t.connectedApps} intro={t.appsIntro} />
        <ReadStatePanel status={apps.status} next="/connected-apps" /></>;
    }
    return <ConnectedApps apps={connectedAppViews(apps.data.items, now, locale)} />;
  });
}
