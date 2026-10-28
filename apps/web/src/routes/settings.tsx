import { requireSignedIn } from '../session/guard';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';
import { useSession } from '../session/query';
import { createFileRoute } from '@tanstack/react-router';
import { readSettingsPage } from '../settings/actions';
import { SettingsPageView } from '../settings/settings-page';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/settings')({
  beforeLoad: requireSignedIn,
  loader: () => readSettingsPage(),
  head: ({ match }) =>
    pageHead({ title: m.settings_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: SettingsRoute,
});

function SettingsRoute() {
  const { csrfToken } = useSession();
  const page = Route.useLoaderData() as Extract<Awaited<ReturnType<typeof readSettingsPage>>, { signedIn: true }>;
  return <SettingsPageView page={page} csrfToken={csrfToken} />;
}
