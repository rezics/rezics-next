import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
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

function ScreenProfileSessionLive({
  id,
  locale,
  series,
}: {
  id?: string;
  locale: string;
  series?: string | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  return (
    <ScreenProfile
      id={id}
      series={series}
      locale={locale}
      session={state}
      search={search}
      onNavigate={(href) => window.location.assign(href)}
      transport={{
        load: () => loadScreenProfile({ data: { ...(id ? { id } : {}), ...(series ? { series } : {}) } }),
        create: (data) => createCatalogueScreen({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
        createdRelations: (createdId) => ({
          read: (slot, cursor, session) =>
            readSubjectRelationEditor({
              data: editorRequest({ id: createdId, slot, cursor, session }, editorWork),
              headers: csrfHeaders(),
            }),
          propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        }),
        ...(id
          ? {
              facts: {
                read: () => readCorrection({ data: editorRequest({ id }, editorWork), headers: csrfHeaders() }),
                propose: (data) =>
                  submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
              },
              review: (_property, initialSession) => {
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
                    const result = await confirmSubjectCandidate({
                      data: command,
                      headers: csrfHeaders(),
                    });
                    return result;
                  },
                };
              },
              relations: {
                read: (slot, cursor, session) =>
                  readSubjectRelationEditor({
                    data: editorRequest({ id, slot, cursor, session }, editorWork),
                    headers: csrfHeaders(),
                  }),
                propose: (data) =>
                  proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
                confirm: (data) =>
                  confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
              },
            }
          : {}),
      }}
    />
  );
}

export const ScreenProfileSession = candidateSession(ScreenProfileSessionLive);
