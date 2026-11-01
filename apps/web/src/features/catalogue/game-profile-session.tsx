import { candidateSession } from '../../subject/candidate-lifetime';
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

function GameProfileSessionLive({ id, locale }: { id?: string; locale: string }) {
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
          return {
            read: async (_property, cursor, session = initialSession, work) => {
              if (!work?.live()) return { ok: false, reason: 'denied' };
              const result = await readCorrectionReview({
                data: {
                  expectedReader: work.reader,
                  id: id!,
                  property,
                  ...(cursor ? { cursor } : {}),
                  ...(session ? { session } : {}),
                },
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
        classificationReview: (property, initialSession) => {
          return {
            read: async (_property, cursor, session = initialSession, work) => {
              if (!work?.live()) return { ok: false, reason: 'denied' };
              const result = await loadGameClassificationReview({
                data: {
                  expectedReader: work.reader,
                  id: id!,
                  property,
                  ...(cursor ? { cursor } : {}),
                  ...(session ? { session } : {}),
                },
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
      }}
    />
  );
}

export const GameProfileSession = candidateSession(GameProfileSessionLive);
