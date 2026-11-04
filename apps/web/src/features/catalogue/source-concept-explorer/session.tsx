import { useQuery } from '@tanstack/react-query';
import { subjectReaderQuery } from '../../pages/subject-queries';
import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { SourceConceptView } from '../../pages/source-concept-view';
import { readSubjectConcept } from './actions';
import type { ConceptWorksRoutePatch, ConceptWorksRouteState } from '../concept-works/view';

export const SourceConceptSession = candidateSession(function SourceConceptSessionLive({
  id,
  locale,
  role,
  returnTo,
  pinUnsupported,
  worksRoute,
  onWorksChange,
}: {
  id: string;
  locale: string;
  role?: string | undefined;
  returnTo?: string | undefined;
  pinUnsupported?: boolean | undefined;
  worksRoute?: ConceptWorksRouteState | undefined;
  onWorksChange?: ((patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => void) | undefined;
}) {
  const work = useCatalogueLifetime(JSON.stringify(['concept-explore', id, locale, role]));
  const { state } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  const preferences = useQuery({
    ...subjectReaderQuery(id, locale, {
      reader: expectedReader,
      admission: work.generation,
      view: 'concepts',
      cacheEpoch: 0,
      isCurrent: work.active,
    }),
    enabled: state === 'signed-in',
  });
  if (state === 'unknown') return <p>{m.concept_explore_loading({}, { locale: locale as never })}</p>;
  return (
    <SourceConceptView
      key={work.generation}
      id={id}
      locale={locale}
      role={role}
      reader={preferences.data?.preferences}
      returnTo={returnTo}
      {...(pinUnsupported === undefined ? {} : { pinUnsupported })}
      worksRoute={worksRoute}
      onWorksChange={onWorksChange}
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
