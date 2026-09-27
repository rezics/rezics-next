import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { SecurityActivityPage } from '../../../../features/account/activity-page.tsx';
import { activityPage } from '../../../../features/account/views.ts';
import { readSecurityActivity } from '../../../../features/api/server.ts';
import { type PageSearchParams, pageQuery } from '../../../../features/shell/search-params.ts';

export default async function ActivityPage({ searchParams }: { searchParams: PageSearchParams }) {
  const cursor = (await pageQuery(searchParams)).get('cursor') ?? undefined;
  return renderAccountPage('security', async ({ locale, now }) => {
    const activity = await readSecurityActivity(cursor);
    return <SecurityActivityPage activity={activity.status === 'ok'
      ? { status: 'ok', failed: activity.data.failedLast24Hours, paged: !!cursor,
        ...activityPage(activity.data, now, locale) }
      : { status: activity.status }} />;
  }, '/security/activity');
}
