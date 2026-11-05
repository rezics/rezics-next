import { useMemo, useRef } from 'react';
import { candidateSession, useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import type { ValueAddress, ValueRead } from './value-explanation';
import { loadValueExplanation } from './value-explanation-actions';
import type { PageLink } from '../pages/shared';
import { ValueExplanation, ValueExplanationPage } from './value-explanation-page';

/** Loader data identifies a visit, but only a fresh observed-reader request supplies its displayed explanation. */
export const ValueExplanationSession = candidateSession(function ValueExplanationSession({
  id,
  address,
  locale,
  episode,
  embedded,
  link,
  onRead,
}: {
  id: string;
  address: Omit<ValueAddress, 'id'>;
  locale: string;
  episode: ValueRead;
  embedded?: boolean;
  link?: PageLink | undefined;
  onRead?: (result: ValueRead) => void;
}) {
  const received = useRef(onRead);
  received.current = onRead;
  const observed = useSession();
  const work = useCatalogueLifetime('value-explanation-entry');
  const transport = useMemo(() => {
    const headers = observed.csrfToken ? { 'X-CSRF-Token': observed.csrfToken } : {};
    return async (cursor?: string, session?: string) => {
      if (!work.active()) return Promise.resolve<ValueRead>({ kind: 'unavailable' });
      const result = await loadValueExplanation({
        data: { id, ...address, locale, cursor, session, expectedReader: work.reader || null },
        headers,
      });
      if (!work.active()) return { kind: 'unavailable' } as ValueRead;
      received.current?.(result);
      return result;
    };
  }, [id, address.property, address.statement, address.context, locale, work, observed.csrfToken]);
  if (observed.state === 'unknown') return <ValueExplanationPage locale={locale} embedded={embedded} link={link} />;
  if (observed.state === 'unavailable')
    return (
      <ValueExplanationPage
        locale={locale}
        embedded={embedded}
        link={link}
        result={{ kind: 'unavailable' }}
        onReload={() => {
          if (work.active()) window.location.reload();
        }}
      />
    );
  return <ValueExplanation locale={locale} transport={transport} episode={episode} embedded={embedded} link={link} />;
});
