import { createFileRoute, notFound } from '@tanstack/react-router';
import { ProducerHistorySession } from '../../features/catalogue/producer-history/session';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug/producer')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const context = search.context;
    if (
      context !== undefined &&
      (typeof context !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context))
    )
      throw notFound();
    return { context, realm: validatePageRealm(search.realm) };
  },
  head: () => ({ meta: [{ title: m.producer_history_title() }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: ProducerHistoryRoute,
});
function ProducerHistoryRoute() {
  const { id } = Route.useParams();
  const { context, realm } = Route.useSearch();
  return (
    <ProducerHistorySession
      key={`${id}:${getLocale()}:${context ?? ''}:${realm ?? ''}`}
      id={id}
      locale={getLocale()}
      context={context}
      realm={realm}
    />
  );
}
