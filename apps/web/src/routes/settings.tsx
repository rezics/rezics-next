import { requirePrivatePageAccess } from '../session/guard';
import { loadPrivatePage } from '../session/private-page';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';
import { sessionQuery } from '../session/query';
import { createFileRoute } from '@tanstack/react-router';
import { BoundCollectionPrivacySection, BoundShelfPreferencesCard } from '../settings/adapters/library.tsx';
import { readSettingsPage } from '../settings/actions';
import { SettingsPageView } from '../settings/settings-page';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/settings')({
  beforeLoad: async (context) => {
    const sessionAccess = await requirePrivatePageAccess(context);
    // Settings hashes choose a job. Its composition owns deliberate heading focus;
    // initial links and reloads must not trigger the router's fragment scroll.
    context.location.state.__hashScrollIntoViewOptions = false;
    return { sessionAccess };
  },
  loader: async ({ context }) =>
    loadPrivatePage(context.sessionAccess, async () => ({
      page: await readSettingsPage(),
      requestSession: context.queryClient.getQueryData(sessionQuery.queryKey) ?? null,
    })),
  head: ({ match }) =>
    pageHead({ title: m.settings_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: SettingsRoute,
});

function SettingsRoute() {
  const data = Route.useLoaderData();
  const { page, requestSession } = data;
  return (
    <SettingsPageView
      page={page}
      csrfToken={requestSession?.csrfToken ?? null}
      requestSession={requestSession}
      ShelfCard={BoundShelfPreferencesCard}
      PrivacySection={BoundCollectionPrivacySection}
    />
  );
}
