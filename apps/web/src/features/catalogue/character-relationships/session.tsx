import { candidateSession } from '../../../subject/candidate-lifetime';
import { editorRequest } from '../editor-request';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { candidateContext } from '../../../subject/candidates';
import { relationTargetSearch } from '../relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from '../relation-editor-actions';
import { readCharacterRelationshipsPage } from './actions';
import { CharacterRelationshipsView } from './view';
import type { CharacterRelationshipsOrigin, CharacterRelationshipsVisit } from './navigation';

export const CharacterRelationshipsSession = candidateSession(CharacterRelationshipsSessionLive);

function CharacterRelationshipsSessionLive({
  id,
  locale,
  context,
  realm,
  work,
  stream,
  cursor,
  origin,
  visit,
}: {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  work?: string | undefined;
  stream?: string | undefined;
  cursor?: string | undefined;
  origin: CharacterRelationshipsOrigin;
  visit?: CharacterRelationshipsVisit | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const router = useRouter({ warn: false });
  const { state } = useSession();
  const saveVisit = useCallback(
    (value: CharacterRelationshipsVisit) =>
      router.history.replace(router.history.location.href, {
        ...router.history.location.state,
        characterRelationshipsVisit: value,
      } as never),
    [router],
  );
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
      origin={origin}
      {...(visit ? { visit } : {})}
      saveVisit={saveVisit}
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
