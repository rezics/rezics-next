import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { StoryArcProfile } from './story-arc-profile-view';
import { storyArcFacts, type StoryArcAddress } from './story-arc-profile';
import { loadStoryArcProfile } from './story-arc-profile-actions';
import { readCreateDefinitions, createCatalogueSubject, readCreatedCatalogueSubject } from './create-subject-actions';
import { relationTargetSearch } from './relation-editor-search';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';

export function StoryArcProfileSession({
  locale,
  realm,
  ...address
}: StoryArcAddress & { locale: string; realm?: string | undefined }) {
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
          submit: (data) => createCatalogueSubject({ data, headers: csrfHeaders() }),
          read: (data) => readCreatedCatalogueSubject({ data }),
        },
      }}
      facts={(id) => ({
        read: async () => {
          const read = await loadStoryArcProfile({ data: { id } });
          return read.ok ? storyArcFacts(read) : read;
        },
        propose: (data) => submitFactCorrection({ data, headers: csrfHeaders() }),
      })}
      review={(id, _property, initialSession) => {
        let session = initialSession;
        return {
          read: async (property, cursor) => {
            const result = await readSubjectCandidates({
              data: { id, property, cursor, session },
              headers: csrfHeaders(),
            });
            if (result.ok) session = result.session ?? session;
            return result;
          },
          confirm: async (command) => {
            const result = await confirmSubjectCandidate({ data: { ...command, session }, headers: csrfHeaders() });
            if (result.ok) session = result.session ?? session;
            return result;
          },
        };
      }}
      relations={(id) => ({
        read: (slot, cursor, session) =>
          readSubjectRelationEditor({ data: { id, slot, cursor, session }, headers: csrfHeaders() }),
        propose: (data) => proposeSubjectRelation({ data, headers: csrfHeaders() }),
        confirm: (data) => confirmSubjectRelation({ data, headers: csrfHeaders() }),
      })}
    />
  );
}
