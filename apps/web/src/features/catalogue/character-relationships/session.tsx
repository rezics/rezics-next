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
import { readCharacterRelationshipsPage } from './actions';
import { CharacterRelationshipsView } from './view';

export const CharacterRelationshipsSession = candidateSession(CharacterRelationshipsSessionLive);

function CharacterRelationshipsSessionLive({
  id,
  locale,
  context,
  realm,
  work,
  stream,
  cursor,
}: {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  work?: string | undefined;
  stream?: string | undefined;
  cursor?: string | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  if (realm || (context && context !== candidateContext)) return <p>{m.relation_context()}</p>;
  if (state !== 'signed-in')
    return <p>{state === 'signed-out' ? m.character_relationships_signed_out() : m.candidate_loading()}</p>;
  return (
    <CharacterRelationshipsView
      id={id}
      locale={locale}
      search={search}
      signedIn
      {...(work ? { work } : {})}
      {...(stream ? { stream } : {})}
      {...(cursor ? { cursor } : {})}
      transport={{
        read: (stream, cursor, session) =>
          readCharacterRelationshipsPage({
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
