import { useSession } from '../session/query';
import { createFileRoute } from '@tanstack/react-router';
import { readSettingsPage } from '../settings/actions';
import { SettingsPageView } from '../settings/settings-page';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/settings')({
  loader: () => readSettingsPage(),
  head: () => ({ meta: [{ title: m.settings_heading() }] }),
  component: SettingsRoute,
});

function SettingsRoute() {
  const { csrfToken } = useSession();
  return <SettingsPageView page={Route.useLoaderData()} csrfToken={csrfToken} />;
}
