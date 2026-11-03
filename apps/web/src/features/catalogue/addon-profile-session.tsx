import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { AddonProfile } from './addon-profile-view';
import { addonFacts, type AddonAddress } from './addon-profile';
import { loadAddonProfile, createCatalogueAddon } from './addon-profile-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { relationTargetSearch } from './relation-editor-search';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';

function AddonProfileSessionLive({
  locale,
  classificationHandoffToken,
  ...address
}: AddonAddress & { locale: string; classificationHandoffToken?: string }) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  return (
    <AddonProfile
      {...address}
      locale={locale}
      session={state}
      search={search}
      transport={{
        load: (data) => loadAddonProfile({ data }),
        create: (data) => createCatalogueAddon({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      facts={(id) => ({
        read: async () => {
          const read = await loadAddonProfile({ data: { id } });
          return read.ok ? addonFacts(read) : read;
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

export const AddonProfileSession = candidateSession(AddonProfileSessionLive);
