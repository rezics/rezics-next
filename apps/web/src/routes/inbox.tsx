import { Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { InboxPageView } from '../inbox/inbox-page';
import { setInboxResponsePolicy } from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/inbox')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 ? { cursor: search.cursor } : {}),
    view: search.view === 'unread' ? ('unread' as const) : ('all' as const),
  }),
  loader: () => setInboxResponsePolicy(),
  head: () => ({ meta: [{ title: m.inbox_heading() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: InboxRoute,
});

function InboxRoute() {
  const isNotice = useMatchRoute()({ to: '/inbox/notice' });
  const { cursor, view } = Route.useSearch();
  const navigate = useNavigate({ from: '/inbox' });
  if (isNotice) return <Outlet />;
  return (
    <InboxPageView
      initialCursor={cursor}
      initialUnreadOnly={view === 'unread'}
      onSelectionChange={({ cursor: nextCursor, view: nextView }) => {
        void navigate({
          search: (current) => ({
            ...current,
            cursor: nextCursor,
            view: nextView,
          }),
          replace: true,
        });
      }}
    />
  );
}
