import { createFileRoute, notFound } from '@tanstack/react-router';
import { QuotationSession } from '../../features/catalogue/quotation/session';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug/quotations')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const quote = search.quote;
    const returnTo = search.returnTo;
    if (quote !== undefined && (typeof quote !== 'string' || !/^[0-9a-f-]{36}$/i.test(quote))) throw notFound();
    if (returnTo !== undefined && (typeof returnTo !== 'string' || returnTo.length > 2048 || !returnTo.startsWith('/')))
      throw notFound();
    return {
      quote: typeof quote === 'string' ? quote : undefined,
      returnTo: typeof returnTo === 'string' ? returnTo : undefined,
    };
  },
  head: () => ({ meta: [{ title: m.quotation_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: QuotationsRoute,
});

function QuotationsRoute() {
  const { id } = Route.useParams();
  const { quote, returnTo } = Route.useSearch();
  return <QuotationSession key={`${id}:${getLocale()}`} id={id} locale={getLocale()} quote={quote} returnTo={returnTo} />;
}
