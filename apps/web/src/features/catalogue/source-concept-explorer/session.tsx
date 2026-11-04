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
  worksRoute?: ConceptWorksRouteState;
  onWorksChange?: (patch: ConceptWorksRoutePatch, options?: { replace?: boolean }) => void;
}) {
  const work = useCatalogueLifetime(JSON.stringify(['concept-explore', id, locale, role]));
  const { state } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  if (state === 'unknown') return <p>{m.concept_explore_loading({}, { locale: locale as never })}</p>;
  return (
    <SourceConceptView
      key={work.generation}
      id={id}
      locale={locale}
      role={role}
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
