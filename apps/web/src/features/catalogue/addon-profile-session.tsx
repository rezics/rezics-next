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

export function AddonProfileSession({ locale, ...address }: AddonAddress & { locale: string }) {
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
        create: (data) => createCatalogueAddon({ data, headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      facts={(id) => ({
        read: async () => {
          const read = await loadAddonProfile({ data: { id } });
          return read.ok ? addonFacts(read) : read;
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
