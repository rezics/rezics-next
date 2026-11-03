import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { StoryArcProfile } from './story-arc-profile-view';
import type { StoryArcAddress } from './story-arc-profile';
import { storyArcClassificationCurrent } from './story-arc-classification-review';
import { loadStoryArcProfile } from './story-arc-profile-actions';
import { readCreateDefinitions, createCatalogueSubject, readCreatedCatalogueSubject } from './create-subject-actions';
import { relationTargetSearch } from './relation-editor-search';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';

function StoryArcProfileSessionLive({
  locale,
  realm,
  ...address
}: StoryArcAddress & { locale: string; realm?: string | undefined }) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  // The current generic contribution producers support Global only. Retain the Realm address at navigation.
  if (realm)
    return (
      <article className="p-6">
        <h1 className="font-sans text-2xl font-semibold">{m.story_arc_title()}</h1>
        <p>{m.relation_context()}</p>
      </article>
    );
  return (
    <StoryArcProfile
      {...address}
      locale={locale}
      session={state}
      search={search}
      transport={{
        load: (data) => loadStoryArcProfile({ data }),
        creation: {
          definitions: (data) => readCreateDefinitions({ data }),
          submit: (data) => createCatalogueSubject({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          read: (data) => readCreatedCatalogueSubject({ data }),
        },
      }}
      facts={(id) => ({
        read: async () => storyArcClassificationCurrent(await loadStoryArcProfile({ data: { id } })),
        propose: (data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      })}
      review={(id, _property, initialSession) => {
        return {
          read: async (property, cursor, session = initialSession, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await readSubjectCandidates({
              data: { expectedReader: work.reader, id, property, cursor, session },
              headers: csrfHeaders(),
            });
            return result;
          },
          confirm: async (command, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await confirmSubjectCandidate({ data: command, headers: csrfHeaders() });
            return result;
          },
        };
      }}
      relations={(id) => ({
        read: (slot, cursor, session) =>
          readSubjectRelationEditor({
            data: editorRequest({ id, slot, cursor, session }, editorWork),
            headers: csrfHeaders(),
          }),
        propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      })}
    />
  );
}

export const StoryArcProfileSession = candidateSession(StoryArcProfileSessionLive);
