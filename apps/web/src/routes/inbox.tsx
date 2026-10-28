import { createFileRoute } from '@tanstack/react-router';
import { InboxPageView } from '../inbox/inbox-page';
import { setInboxResponsePolicy } from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/inbox')({
  loader: () => setInboxResponsePolicy(),
  head: () => ({ meta: [{ title: m.inbox_heading() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: InboxPageView,
});
