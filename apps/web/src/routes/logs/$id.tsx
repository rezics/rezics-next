import { createFileRoute } from '@tanstack/react-router';
import { CurrentPublishedLog } from '../../library/log-current';
import { readPublishedLogCurrent } from '../../library/logs-server';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/logs/$id')({
  loader: ({ params }) => readPublishedLogCurrent({ data: { id: params.id } }),
  staleTime: 0,
  head: () => ({ meta: [{ title: m.library_logs_page_heading() }] }),
  component: function PublishedLogRoute() {
    const page = Route.useLoaderData();
    const { id } = Route.useParams();
    return <CurrentPublishedLog loaded={page} id={id} />;
  },
});
