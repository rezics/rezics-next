import { createFileRoute } from '@tanstack/react-router';
import { InboxNoticeDetailPage } from '../inbox/inbox-notice-detail';
import { setInboxResponsePolicy } from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/inbox/notice')({
  validateSearch: (search: Record<string, unknown>) => ({
    noticeId: typeof search.noticeId === 'string' ? search.noticeId : '',
  }),
  loader: () => setInboxResponsePolicy(),
  head: () => ({ meta: [{ title: m.inbox_notice_detail_heading() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: InboxNoticeRoute,
});

function InboxNoticeRoute() {
  const { noticeId, cursor, view } = Route.useSearch();
  return <InboxNoticeDetailPage noticeId={noticeId} view={view} {...(cursor === undefined ? {} : { cursor })} />;
}
