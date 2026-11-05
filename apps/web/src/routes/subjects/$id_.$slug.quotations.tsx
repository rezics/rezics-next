import { createFileRoute, notFound } from '@tanstack/react-router';
import { QuotationSession } from '../../features/catalogue/quotation/session';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug/quotations')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const quote = search.quote;
    const returnTo = search.returnTo;
    const quotationReturn = search.quotationReturn;
    const context = search.context;
    if (
      quotationReturn !== undefined &&
      (typeof quotationReturn !== 'string' ||
        quotationReturn.length > 128 ||
        !/^[^\s~]{1,91}~[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          quotationReturn,
        ))
    )
      throw notFound();
    if (quote !== undefined && (typeof quote !== 'string' || !/^[0-9a-f-]{36}$/i.test(quote))) throw notFound();
    if (
      context !== undefined &&
      (typeof context !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context))
    )
      throw notFound();
    if (
      returnTo !== undefined &&
      (typeof returnTo !== 'string' ||
        returnTo.length > 2048 ||
        !returnTo.startsWith('/') ||
        returnTo.startsWith('//') ||
        returnTo.startsWith('/\\'))
    )
      throw notFound();
    return {
      quotationReturn: typeof quotationReturn === 'string' ? quotationReturn : undefined,
      quote: typeof quote === 'string' ? quote : undefined,
      returnTo: typeof returnTo === 'string' ? returnTo : undefined,
      context: typeof context === 'string' ? context : undefined,
    };
  },
  head: () => ({ meta: [{ title: m.quotation_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: QuotationsRoute,
});

function QuotationsRoute() {
  const { id } = Route.useParams();
  const { quote, returnTo, context } = Route.useSearch();
  return (
    <QuotationSession
      key={`${id}:${getLocale()}:${context ?? 'global'}`}
      id={id}
      locale={getLocale()}
      context={context}
      quote={quote}
      returnTo={returnTo}
    />
  );
}
