import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { OperatorSessionOpeningPage } from '../operator-session-opening-page';

export const Route = createFileRoute('/automated/open')({
  head: () => ({ meta: [{ title: `${m.auth_opening_heading()} · REZICS` }] }),
  component: OperatorSessionOpeningPage,
});

export { OperatorSessionOpeningPage } from '../operator-session-opening-page';
