import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { relationTargetSearch } from './relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { readSubjectWorkParts } from './work-parts-actions';
import { WorkPartsPage } from './work-parts-page';

export function WorkPartsSession({ id, locale }: { id: string; locale: string }) {
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  if (state !== 'signed-in') return <p>{state === 'signed-out' ? m.relation_sign_in() : m.candidate_loading()}</p>;
  return (
    <WorkPartsPage
      id={id}
      locale={locale}
      search={search}
      transport={{
        read: (stream, cursor, session) =>
          readSubjectWorkParts({ data: { id, stream, cursor, session }, headers: csrfHeaders() }),
        relation: (holder) => ({
          read: (slot, cursor, session) =>
            readSubjectRelationEditor({ data: { id: holder, slot, cursor, session }, headers: csrfHeaders() }),
          propose: (data) => proposeSubjectRelation({ data, headers: csrfHeaders() }),
          confirm: (data) => confirmSubjectRelation({ data, headers: csrfHeaders() }),
        }),
      }}
    />
  );
}
