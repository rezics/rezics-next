import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { SourceConceptView } from '../../pages/source-concept-view';
import { readSubjectConcept } from './actions';

export const SourceConceptSession = candidateSession(function SourceConceptSessionLive({
  id,
  locale,
  role,
  returnTo,
  pinUnsupported,
}: {
  id: string;
  locale: string;
  role?: string | undefined;
  returnTo?: string | undefined;
  pinUnsupported?: boolean | undefined;
}) {
  const work = useCatalogueLifetime('concept-explore');
  const { state } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  if (state === 'unknown') return <p>{m.concept_explore_loading({}, { locale: locale as never })}</p>;
  return (
    <SourceConceptView
      key={`${id}:${locale}:${state}:${expectedReader ?? 'anonymous'}`}
      id={id}
      locale={locale}
      role={role}
      returnTo={returnTo}
      {...(pinUnsupported === undefined ? {} : { pinUnsupported })}
      transport={{
        read: (next) =>
          readSubjectConcept({
            data: { id, locale, expectedReader, role, cursor: next.cursor, session: next.session },
            headers: csrfHeaders(),
          }),
      }}
    />
  );
});
