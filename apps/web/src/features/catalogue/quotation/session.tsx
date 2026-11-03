import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { QuotationView } from '../../pages/quotation-view';
import { readSubjectQuotations } from './actions';

export const QuotationSession = candidateSession(function QuotationSessionLive({
  id,
  locale,
  quote,
  returnTo,
}: {
  id: string;
  locale: string;
  quote?: string | undefined;
  returnTo?: string | undefined;
}) {
  const work = useCatalogueLifetime('quotation-explore');
  const { state } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  if (state === 'unknown') return <p>{m.quotation_loading({}, { locale: locale as never })}</p>;
  return (
    <QuotationView
      id={id}
      locale={locale}
      quote={quote}
      returnTo={returnTo}
      transport={{
        read: (next) =>
          readSubjectQuotations({
            data: { id, locale, expectedReader, quote: next.quote ?? quote, cursor: next.cursor, session: next.session },
            headers: csrfHeaders(),
          }),
      }}
    />
  );
});
