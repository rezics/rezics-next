import { useState } from 'react';
import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { IdentifiersProfile, type IdentifiersProfileProps } from './identifiers-profile-view';
import { IdentifierOriginChoice } from './identifier-current-visit-view';

function IdentifiersProfileSessionLive({
  id,
  locale,
  initialReview,
  origin,
  editorHref,
  originHref,
  globalHref,
}: Pick<
  IdentifiersProfileProps,
  'id' | 'locale' | 'initialReview' | 'origin' | 'editorHref' | 'originHref' | 'globalHref'
>) {
  const [globalChoice, setGlobalChoice] = useState(!origin || origin.kind === 'global');
  if (!globalChoice && origin) {
    return (
      <IdentifierOriginChoice
        locale={locale}
        origin={origin}
        originHref={origin.kind === 'realm' ? originHref : undefined}
        globalHref={globalHref}
        onChooseGlobal={() => setGlobalChoice(true)}
      />
    );
  }
  return (
    <IdentifiersProfileCorrectionSession
      id={id}
      locale={locale}
      initialReview={initialReview}
      origin={origin}
      editorHref={editorHref}
      originHref={originHref}
      globalHref={globalHref}
    />
  );
}

function IdentifiersProfileCorrectionSession({
  id,
  locale,
  initialReview,
  origin,
  editorHref,
  originHref,
  globalHref,
}: Pick<
  IdentifiersProfileProps,
  'id' | 'locale' | 'initialReview' | 'origin' | 'editorHref' | 'originHref' | 'globalHref'
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
