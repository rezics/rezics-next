import { useMemo, useState } from 'react';
import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { IdentifiersProfile, type IdentifiersProfileProps } from './identifiers-profile-view';
import { IdentifierCurrentVisit, IdentifierOriginChoice } from './identifier-current-visit-view';

import { readIdentifierOrigin } from './identifier-current-visit-actions';

function IdentifiersProfileSessionLive({
  id,
  locale,
  initialReview,
  initialInspection,
  origin,
  editorHref,
  originHref,
  globalHref,
}: Pick<
  IdentifiersProfileProps,
  'id' | 'locale' | 'initialReview' | 'initialInspection' | 'origin' | 'editorHref' | 'originHref' | 'globalHref'
>) {
  const [globalChoice, setGlobalChoice] = useState(!origin || origin.kind === 'global');
  const [reviewRevision, setReviewRevision] = useState(0);
  const publicWork = useCatalogueLifetime('identifier-public-origin');
  const publicTransport = useMemo(
    () => ({
      read: () =>
        readIdentifierOrigin({
          data: {
            id,
            locale,
            expectedReader: publicWork.reader || null,
            search: editorHref ? new URL(editorHref, 'https://rezics.invalid').search : '',
          },
          headers: csrfHeaders(),
        }),
    }),
    [id, locale, editorHref, publicWork],
  );
  return (
    <>
      {editorHref && (
        <IdentifierCurrentVisit
          key={reviewRevision}
          id={id}
          locale={locale}
          origin={origin}
          initialInspection={reviewRevision === 0 ? initialInspection : undefined}
          initialReview={initialReview}
          editorHref={editorHref}
          transport={publicTransport}
        />
      )}
      {!globalChoice && origin ? (
        <IdentifierOriginChoice
          locale={locale}
          origin={origin}
          originHref={origin.kind === 'realm' ? originHref : undefined}
          globalHref={globalHref}
          onChooseGlobal={() => setGlobalChoice(true)}
        />
      ) : (
        <IdentifiersProfileCorrectionSession
          onReviewIntent={() => setReviewRevision((value) => value + 1)}
          id={id}
          locale={locale}
          initialReview={initialReview}
          origin={origin}
          editorHref={editorHref}
          originHref={originHref}
          globalHref={globalHref}
        />
      )}
    </>
  );
}

function IdentifiersProfileCorrectionSession({
  id,
  locale,
  initialReview,
  onReviewIntent,
  origin,
  editorHref,
  originHref,
  globalHref,
}: Pick<
  IdentifiersProfileProps,
  'id' | 'locale' | 'initialReview' | 'onReviewIntent' | 'origin' | 'editorHref' | 'originHref' | 'globalHref'
>) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  return (
    <IdentifiersProfile
      key={`${id}:${locale}:${origin?.context ?? ''}:${origin?.realm ?? ''}:${origin?.realmTitle ?? ''}:${origin?.state ?? ''}:${initialReview?.property ?? ''}:${initialReview?.candidate ?? ''}`}
      id={id}
      locale={locale}
      session={state}
      initialReview={initialReview}
      onReviewIntent={onReviewIntent}
      origin={origin}
      editorHref={editorHref}
      originHref={originHref}
      globalHref={globalHref}
      transport={{
        read: () => readCorrection({ data: editorRequest({ id }, editorWork), headers: csrfHeaders() }),
        propose: (data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      }}
      review={(_property, initialSession) => {
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
    />
  );
}

export const IdentifiersProfileSession = candidateSession(IdentifiersProfileSessionLive);
