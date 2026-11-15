import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AutomatedAccountCreatePage } from '../automated-account-create-page';

export const Route = createFileRoute('/automated/new')({
  head: () => ({ meta: [{ title: `${m.auth_automated_heading()} · REZICS` }] }),
  component: AutomatedAccountCreatePage,
});

export { AutomatedAccountCreatePage } from '../automated-account-create-page';
