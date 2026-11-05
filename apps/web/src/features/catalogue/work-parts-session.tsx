import { candidateSession } from '../../subject/candidate-lifetime';
import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { candidateContext } from '../../subject/candidates';
import { relationTargetSearch } from './relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { readSubjectWorkParts } from './work-parts-actions';
import { WorkPartsPage } from './work-parts-page';

export const WorkPartsSession = candidateSession(WorkPartsSessionLive);

function WorkPartsSessionLive({
  id,
  locale,
  context,
  realm,
  child,
}: {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  child?: string | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  // Current relation contribution APIs admit Global only; retain other addresses without substituting it.
  if (realm || (context && context !== candidateContext)) return <p>{m.relation_context()}</p>;
  if (state !== 'signed-in') return <p>{state === 'signed-out' ? m.relation_sign_in() : m.candidate_loading()}</p>;
  return (
    <WorkPartsPage
      id={id}
      locale={locale}
      search={search}
      child={child}
      transport={{
        read: (stream, cursor, session) =>
          readSubjectWorkParts({
            data: editorRequest({ id, stream, cursor, session }, editorWork),
            headers: csrfHeaders(),
          }),
        relation: (holder) => ({
          read: (slot, cursor, session) =>
            readSubjectRelationEditor({
              data: editorRequest({ id: holder, slot, cursor, session }, editorWork),
              headers: csrfHeaders(),
            }),
          propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        }),
      }}
    />
  );
}
