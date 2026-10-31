import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { relationTargetSearch } from './relation-editor-search';
import { createCatalogueScreen, loadScreenProfile } from './screen-profile-actions';
import { ScreenProfile } from './screen-profile-view';

export function ScreenProfileSession({ id, locale }: { id?: string; locale: string }) {
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  return (
    <ScreenProfile
      id={id}
      locale={locale}
      session={state}
      search={search}
      onNavigate={(href) => window.location.assign(href)}
      transport={{
        load: () => loadScreenProfile({ data: id }),
        create: (data) => createCatalogueScreen({ data, headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
        ...(id
          ? {
              facts: {
                read: () => readCorrection({ data: { id }, headers: csrfHeaders() }),
                propose: (data) => submitFactCorrection({ data, headers: csrfHeaders() }),
              },
              review: (_property, initialSession) => {
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
                    const result = await confirmSubjectCandidate({
                      data: { ...command, session },
                      headers: csrfHeaders(),
                    });
                    if (result.ok) session = result.session ?? session;
                    return result;
                  },
                };
              },
              relations: {
                read: (slot, cursor, session) =>
                  readSubjectRelationEditor({ data: { id, slot, cursor, session }, headers: csrfHeaders() }),
                propose: (data) => proposeSubjectRelation({ data, headers: csrfHeaders() }),
                confirm: (data) => confirmSubjectRelation({ data, headers: csrfHeaders() }),
              },
            }
          : {}),
      }}
    />
  );
}
