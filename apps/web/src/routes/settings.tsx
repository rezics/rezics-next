import { createFileRoute, useLoaderData } from '@tanstack/react-router';
import { readSettingsPage } from '../settings/actions';
import { SettingsPageView } from '../settings/settings-page';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/settings')({
  loader: () => readSettingsPage(),
  head: () => ({ meta: [{ title: m.settings_heading() }] }),
  component: SettingsRoute,
});

function SettingsRoute() {
  const { csrfToken } = useLoaderData({ from: '__root__' });
  return <SettingsPageView page={Route.useLoaderData()} csrfToken={csrfToken} />;
}
