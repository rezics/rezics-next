import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { CharacterProfile } from './character-profile-view';
import { characterFacts, type CharacterAddress } from './character-profile';
import { loadCharacterProfile, createCatalogueCharacter } from './character-profile-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { relationTargetSearch } from './relation-editor-search';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';

export function CharacterProfileSession({ locale, ...address }: CharacterAddress & { locale: string }) {
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  return (
    <CharacterProfile
      {...address}
      locale={locale}
      session={state}
      search={search}
      transport={{
        load: (data) => loadCharacterProfile({ data }),
        create: (data) => createCatalogueCharacter({ data, headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      facts={(id) => ({
        read: async () => {
          const read = await loadCharacterProfile({ data: { id } });
          return read.ok ? characterFacts(read) : read;
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
