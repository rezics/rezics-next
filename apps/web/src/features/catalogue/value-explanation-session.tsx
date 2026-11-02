import { useMemo } from 'react';
import { candidateSession, useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import type { ValueAddress, ValueRead } from './value-explanation';
import { loadValueExplanation } from './value-explanation-actions';
import { ValueExplanation, ValueExplanationPage } from './value-explanation-page';

/** Loader data identifies a visit, but only a fresh observed-reader request supplies its displayed explanation. */
export const ValueExplanationSession = candidateSession(function ValueExplanationSession({
  id,
  address,
  locale,
  episode,
}: {
  id: string;
  address: Omit<ValueAddress, 'id'>;
  locale: string;
  episode: ValueRead;
}) {
  const observed = useSession();
  const work = useCatalogueLifetime('value-explanation-entry');
  const transport = useMemo(() => {
    const headers = observed.csrfToken ? { 'X-CSRF-Token': observed.csrfToken } : {};
    return (cursor?: string, session?: string) => {
      if (!work.active()) return Promise.resolve<ValueRead>({ kind: 'unavailable' });
      return loadValueExplanation({
        data: { id, ...address, locale, cursor, session, expectedReader: work.reader || null },
        headers,
      });
    };
  }, [id, address.property, address.statement, address.context, locale, work, observed.csrfToken]);
  if (observed.state === 'unknown') return <ValueExplanationPage locale={locale} />;
  if (observed.state === 'unavailable')
    return (
      <ValueExplanationPage
        locale={locale}
        result={{ kind: 'unavailable' }}
        onReload={() => {
          if (work.active()) window.location.reload();
        }}
      />
    );
  return <ValueExplanation locale={locale} transport={transport} episode={episode} />;
});
