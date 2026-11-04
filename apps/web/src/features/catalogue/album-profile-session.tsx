import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useCallback, useMemo } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readCatalogueCreateEligibility, readCreatedCatalogueSubject } from './create-subject-actions';
import { createCatalogueAlbum, loadAlbumProfile } from './album-profile-actions';
import { AlbumProfile, type AlbumEditors } from './album-profile-view';
import { relationTargetSearch } from './relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { readCorrection, readCorrectionReview, confirmCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import type { AlbumTransport } from './album-profile';

function AlbumProfileSessionLive({ id, locale }: { id?: string; locale: string }) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const router = useRouter();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  const transport = useMemo<AlbumTransport>(
    () => ({
      load: () => loadAlbumProfile({ data: id }),
      create: (data) => createCatalogueAlbum({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      read: (data: string) => readCreatedCatalogueSubject({ data }),
      eligibility: () => readCatalogueCreateEligibility(),
    }),
    [id, editorWork],
  );
  const editors = useMemo<AlbumEditors | undefined>(
    () =>
      id
        ? {
            facts: {
              read: () => readCorrection({ data: editorRequest({ id }, editorWork), headers: csrfHeaders() }),
              propose: (data) =>
                submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
            },
            review: (property, initialSession) => {
              return {
                read: async (_property, cursor, session = initialSession, work) => {
                  if (!work?.live()) return { ok: false, reason: 'denied' };
                  const result = await readCorrectionReview({
                    data: { expectedReader: work.reader, id, property, cursor, session },
                    headers: csrfHeaders(),
                  });
                  return result;
                },
                confirm: async (command, work) => {
                  if (!work?.live()) return { ok: false, reason: 'denied' };
                  const result = await confirmCorrection({
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
            onSelected: () => router.invalidate(),
          }
        : undefined,
    [id, router, editorWork],
  );
  return (
    <AlbumProfile
      {...(id ? { id } : {})}
      locale={locale}
      session={state}
      transport={transport}
      search={search}
      {...(editors ? { editors } : {})}
    />
  );
}

export const AlbumProfileSession = candidateSession(AlbumProfileSessionLive);
