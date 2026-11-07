import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { createInboxShellPort, InboxPageView, InboxShellProvider, setInboxResponsePolicy } from '../inbox';
import { inboxContent } from '../inbox/adapters/presentation';
import { m } from '../paraglide/messages.js';

const inboxShell = createInboxShellPort();

export const Route = createFileRoute('/inbox')({
  loader: () => setInboxResponsePolicy(),
  head: () => ({ meta: [{ title: m.inbox_heading() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: InboxRoutePage,
});

function InboxRoutePage() {
  const historyKey = useRouterState({
    select: (state) => {
      const routeState = state.location.state as { key?: unknown; __TSR_key?: unknown };
      const key = typeof routeState.key === 'string' ? routeState.key : routeState.__TSR_key;
      return typeof key === 'string' ? key : state.location.href;
    },
  });
  return (
    <InboxShellProvider port={inboxShell}>
      <InboxPageView historyKey={historyKey} content={inboxContent} />
    </InboxShellProvider>
  );
}
