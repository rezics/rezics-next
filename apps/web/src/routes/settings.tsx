import { requireSignedIn } from '../session/guard';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';
import { sessionQuery } from '../session/query';
import { createFileRoute } from '@tanstack/react-router';
import { readSettingsPage } from '../settings/actions';
import { SettingsPageView } from '../settings/settings-page';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/settings')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    // Settings hashes choose a job. Its composition owns deliberate heading focus;
    // initial links and reloads must not trigger the router's fragment scroll.
    context.location.state.__hashScrollIntoViewOptions = false;
  },
  loader: async ({ context }) => ({
    page: await readSettingsPage(),
    requestSession: context.queryClient.getQueryData(sessionQuery.queryKey) ?? null,
  }),
  head: ({ match }) =>
    pageHead({ title: m.settings_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: SettingsRoute,
});

function SettingsRoute() {
  const { page, requestSession } = Route.useLoaderData();
  return <SettingsPageView page={page} csrfToken={requestSession?.csrfToken ?? null} requestSession={requestSession} />;
}
