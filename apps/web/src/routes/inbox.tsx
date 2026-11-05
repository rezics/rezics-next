import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { InboxPageView } from '../inbox/inbox-page';
import { setInboxResponsePolicy } from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/inbox')({
  loader: () => setInboxResponsePolicy(),
  head: () => ({ meta: [{ title: m.inbox_heading() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: InboxRoutePage,
});

function InboxRoutePage() {
  const historyKey = useRouterState({ select: (state) => state.location.state.key ?? '' });
  return <InboxPageView historyKey={historyKey} />;
}
