import { candidateSession } from '../../subject/candidate-lifetime';
import { useCallback, useMemo } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { createCatalogueAlbum, loadAlbumProfile } from './album-profile-actions';
import { AlbumProfile, type AlbumEditors } from './album-profile-view';
import { relationTargetSearch } from './relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { readCorrection, readCorrectionReview, confirmCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import type { AlbumTransport } from './album-profile';

function AlbumProfileSessionLive({ id, locale }: { id?: string; locale: string }) {
  const { state } = useSession();
  const router = useRouter();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  const transport = useMemo<AlbumTransport>(
    () => ({
      load: () => loadAlbumProfile({ data: id }),
      create: (data) => createCatalogueAlbum({ data, headers: csrfHeaders() }),
      read: (data: string) => readCreatedCatalogueSubject({ data }),
    }),
    [id],
  );
  const editors = useMemo<AlbumEditors | undefined>(
    () =>
      id
        ? {
            facts: {
              read: () => readCorrection({ data: { id }, headers: csrfHeaders() }),
              propose: (data) => submitFactCorrection({ data, headers: csrfHeaders() }),
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
                readSubjectRelationEditor({ data: { id, slot, cursor, session }, headers: csrfHeaders() }),
              propose: (data) => proposeSubjectRelation({ data, headers: csrfHeaders() }),
              confirm: (data) => confirmSubjectRelation({ data, headers: csrfHeaders() }),
            },
            onSelected: () => router.invalidate(),
          }
        : undefined,
    [id, router],
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
