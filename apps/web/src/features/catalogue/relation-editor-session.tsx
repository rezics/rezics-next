import { candidateSession } from '../../subject/candidate-lifetime';
import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { RelationEditor } from './relation-editor';
import { relationTargetSearch } from './relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';

export const RelationEditorSession = candidateSession(RelationEditorSessionLive);

function RelationEditorSessionLive({ id, locale }: { id: string; locale: string }) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const router = useRouter();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  if (state !== 'signed-in') return <p>{state === 'signed-out' ? m.relation_sign_in() : m.candidate_loading()}</p>;
  return (
    <RelationEditor
      id={id}
      locale={locale}
      search={search}
      onSelected={() => router.invalidate()}
      transport={{
        read: (slot, cursor, session) =>
          readSubjectRelationEditor({ data: editorRequest({ id, slot, cursor, session }, editorWork), headers: csrfHeaders() }),
        propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      }}
    />
  );
}
