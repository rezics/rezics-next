import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { DevicesPage } from '../../../../features/account/devices-page.tsx';
import { deviceViews, sessionViews } from '../../../../features/account/views.ts';
import { readSessions } from '../../../../features/api/server.ts';
import { type PageSearchParams, pageQuery } from '../../../../features/shell/search-params.ts';

export default async function YourDevicesPage({ searchParams }: { searchParams: PageSearchParams }) {
  const cursor = (await pageQuery(searchParams)).get('cursor') ?? undefined;
  return renderAccountPage('security', async ({ locale, now }) => {
    const sessions = await readSessions(cursor);
    return <DevicesPage devices={sessions.status === 'ok'
      ? { status: 'ok', items: cursor || sessions.data.nextCursor
        ? sessionViews(sessions.data.items, now, locale) : deviceViews(sessions.data.items, now, locale),
      limited: !!sessions.data.nextCursor, older: sessions.data.nextCursor, paged: !!cursor }
      : { status: 'unavailable' }} />;
  }, '/security/devices');
}
