import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AccountHome } from '../account-home-view';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: `${m.auth_home_heading()} · REZICS` }] }),
  component: AccountHome,
});
