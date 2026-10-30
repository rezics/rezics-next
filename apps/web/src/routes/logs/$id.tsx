import { createFileRoute } from '@tanstack/react-router';
import { PublishedLogPageView } from '../../library/log-page';
import { readPublishedLog } from '../../library/logs-server';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/logs/$id')({
  loader: ({ params }) => readPublishedLog({ data: { id: params.id } }),
  staleTime: 0,
  head: () => ({ meta: [{ title: m.library_logs_page_heading() }] }),
  component: function PublishedLogRoute() {
    const page = Route.useLoaderData();
    return <PublishedLogPageView key={`${page.log.id}:${page.revision ?? 'public'}`} {...page} />;
  },
});
