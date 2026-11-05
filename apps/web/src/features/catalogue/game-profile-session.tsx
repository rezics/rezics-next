import { gameVisitSearch, type GameCurrentVisit } from './game-current-visit';
import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
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
import { readCatalogueCreateEligibility, readCreatedCatalogueSubject } from './create-subject-actions';
import { readCorrectionReview, confirmCorrection, readCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { relationTargetSearch } from './relation-editor-search';

function GameProfileSessionLive({
  id,
  locale,
  visit,
  address,
}: {
  id?: string;
  locale: string;
  visit?: GameCurrentVisit | undefined;
  /** Included in the existing session and editor lifetime, including source release replacement. */
  address?: string | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  const eligibility = useCallback(() => readCatalogueCreateEligibility(), []);
  return (
    <GameProfile
      {...(id ? { id } : {})}
      locale={locale}
      visit={visit}
      address={address}
      session={state}
      search={search}
      onNavigate={(href) => {
        window.location.assign(href);
      }}
      transport={{
        load: () => loadGameProfile({ data: id && visit ? { id, locale, search: gameVisitSearch(visit) } : id }),
        create: (data) => createCatalogueGame({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        eligibility,
        read: (data) => readCreatedCatalogueSubject({ data }),
        facts: {
          read: () => readCorrection({ data: editorRequest({ id: id! }, editorWork) }),
          propose: (data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        },
        classifications: {
          read: () => readCorrection({ data: editorRequest({ id: id! }, editorWork) }),
          propose: (data) =>
            proposeGameClassification({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        },
        relations: {
          read: (slot, cursor, session) =>
            readSubjectRelationEditor({
              data: editorRequest({ id: id!, slot, cursor, session }, editorWork),
              headers: csrfHeaders(),
            }),
          propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
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
