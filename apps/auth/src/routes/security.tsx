import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { SecurityPage } from '../security-page';

export const Route = createFileRoute('/security')({
  head: () => ({ meta: [{ title: `${m.auth_security_heading()} · REZICS` }] }),
  component: SecurityRoute,
});

function SecurityRoute() {
  return <SecurityPage />;
}

export { SecurityPage };
