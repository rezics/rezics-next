import { candidateSession } from '../../../subject/candidate-lifetime';
import { editorRequest } from '../editor-request';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { candidateContext } from '../../../subject/candidates';
import { relationTargetSearch } from '../relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from '../relation-editor-actions';
import { readSubjectProducerHistory } from './actions';
import { ProducerHistoryPage } from '../../pages/producer-history';

export const ProducerHistorySession = candidateSession(ProducerHistorySessionLive);

function ProducerHistorySessionLive({
  id,
  locale,
  context,
  realm,
}: {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  if (realm || (context && context !== candidateContext)) return <p>{m.relation_context()}</p>;
  if (state !== 'signed-in') return <p>{state === 'signed-out' ? m.relation_sign_in() : m.candidate_loading()}</p>;
  return (
    <ProducerHistoryPage
      id={id}
      locale={locale}
      search={search}
      transport={{
        read: (stream, cursor, session) =>
          readSubjectProducerHistory({
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
