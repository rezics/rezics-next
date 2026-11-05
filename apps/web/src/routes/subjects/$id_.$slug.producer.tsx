import { createFileRoute, notFound } from '@tanstack/react-router';
import { ProducerHistorySession } from '../../features/catalogue/producer-history/session';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { producerHistoryVisitReturn } from '../../features/catalogue/producer-history/visit';

export const Route = createFileRoute('/subjects/$id_/$slug/producer')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    if (Object.keys(search).some((key) => !['context', 'realm', 'via'].includes(key))) throw notFound();
    const context = search.context;
    if (
      context !== undefined &&
      (typeof context !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context))
    )
      throw notFound();
    const realm = validatePageRealm(search.realm);
    const via = search.via;
    if (via !== undefined && (typeof via !== 'string' || via.length > 2048)) throw notFound();
    return {
      ...(context ? { context } : {}),
      ...(realm ? { realm } : {}),
      ...(via ? { via } : {}),
    };
  },
  head: () => ({ meta: [{ title: m.producer_history_title() }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: ProducerHistoryRoute,
});
function ProducerHistoryRoute() {
  const { id } = Route.useParams();
  const { context, realm, via: requestedVia } = Route.useSearch();
  const locale = getLocale();
  const via = requestedVia ? producerHistoryVisitReturn(requestedVia, { id, locale, context, realm }) : undefined;
  if (requestedVia && !via) throw notFound();
  return (
    <ProducerHistorySession
      key={`${id}:${locale}:${context ?? ''}:${realm ?? ''}:${via ?? ''}`}
      id={id}
      locale={locale}
      context={context}
      realm={realm}
      via={via}
    />
  );
}
