import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { CharacterProfile } from './character-profile-view';
import { characterFacts, type CharacterAddress } from './character-profile';
import { loadCharacterProfile, createCatalogueCharacter } from './character-profile-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { readCurrentTypeDescriptor } from './type-directory';
import { relationTargetSearch } from './relation-editor-search';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';

function CharacterProfileSessionLive({
  locale,
  classificationHandoffToken,
  ...address
}: CharacterAddress & { locale: string; classificationHandoffToken?: string }) {
  const editorWork = useCatalogueLifetime('transport');
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
        create: (data) => createCatalogueCharacter({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
        workType: (data) => readCurrentTypeDescriptor({ data }),
      }}
      facts={(id) => ({
        read: async () => {
          const read = await loadCharacterProfile({ data: { id } });
          return read.ok ? characterFacts(read) : read;
        },
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
      {...(classificationHandoffToken ? { classificationHandoffToken } : {})}
      handoffReader={editorWork.reader}
      handoffReaderLive={editorWork.live}
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

export const CharacterProfileSession = candidateSession(CharacterProfileSessionLive);
