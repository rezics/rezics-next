import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { GameProfile } from './game-profile-view';
import {
  loadGameProfile,
  createCatalogueGame,
  proposeGameClassification,
  loadGameClassificationReview,
} from './game-profile-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { readCorrectionReview, confirmCorrection, readCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { relationTargetSearch } from './relation-editor-search';

export function GameProfileSession({ id, locale }: { id?: string; locale: string }) {
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  return (
    <GameProfile
      {...(id ? { id } : {})}
      locale={locale}
      session={state}
      search={search}
      onNavigate={(href) => {
        window.location.assign(href);
      }}
      transport={{
        load: () => loadGameProfile({ data: id }),
        create: (data) => createCatalogueGame({ data, headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
        facts: {
          read: () => readCorrection({ data: { id: id! } }),
          propose: (data) => submitFactCorrection({ data, headers: csrfHeaders() }),
        },
        classifications: {
          read: () => readCorrection({ data: { id: id! } }),
          propose: (data) => proposeGameClassification({ data, headers: csrfHeaders() }),
        },
        relations: {
          read: (slot, cursor, session) =>
            readSubjectRelationEditor({ data: { id: id!, slot, cursor, session }, headers: csrfHeaders() }),
          propose: (data) => proposeSubjectRelation({ data, headers: csrfHeaders() }),
          confirm: (data) => confirmSubjectRelation({ data, headers: csrfHeaders() }),
        },
        review: (property, initialSession) => {
          let session = initialSession;
          return {
            read: async (_property, cursor) => {
              const result = await readCorrectionReview({
                data: { id: id!, property, ...(cursor ? { cursor } : {}), ...(session ? { session } : {}) },
                headers: csrfHeaders(),
              });
              if (result.ok) session = result.session ?? session;
              return result;
            },
            confirm: async (command) => {
              const result = await confirmCorrection({
                data: { ...command, ...(session ? { session } : {}) },
                headers: csrfHeaders(),
              });
              if (result.ok) session = result.session ?? session;
              return result;
            },
          };
        },
        classificationReview: (property, initialSession) => {
          let session = initialSession;
          return {
            read: async (_property, cursor) => {
              const result = await loadGameClassificationReview({
                data: { id: id!, property, ...(cursor ? { cursor } : {}), ...(session ? { session } : {}) },
                headers: csrfHeaders(),
              });
              if (result.ok) session = result.session ?? session;
              return result;
            },
            confirm: async (command) => {
              const result = await confirmCorrection({
                data: { ...command, ...(session ? { session } : {}) },
                headers: csrfHeaders(),
              });
              if (result.ok) session = result.session ?? session;
              return result;
            },
          };
        },
      }}
    />
  );
}
