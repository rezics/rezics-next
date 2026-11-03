import { candidateSession } from '../../../subject/candidate-lifetime';
import { editorRequest } from '../editor-request';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { candidateContext } from '../../../subject/candidates';
import { relationTargetSearch } from '../relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from '../relation-editor-actions';
import { readCorrection } from '../statement-editor-actions';
import { submitFactCorrection } from '../subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../../pages/curate-actions';
import { readSubjectReleaseFidelity } from './actions';
import { ReleaseFidelityPage } from './view';

export const ReleaseFidelitySession = candidateSession(ReleaseFidelitySessionLive);

function ReleaseFidelitySessionLive({
  id,
  locale,
  context,
  realm,
  initialReview,
}: {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  initialReview?: { property: string; candidate: string } | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  if (realm || (context && context !== candidateContext))
    return <p role="status">{m.relation_context({}, { locale: locale as never })}</p>;
  if (state !== 'signed-in')
    return (
      <p role="status">
        {state === 'signed-out'
          ? m.catalogue_create_signed_out({}, { locale: locale as never })
          : m.candidate_loading({}, { locale: locale as never })}
      </p>
    );
  return (
    <ReleaseFidelityPage
      id={id}
      locale={locale}
      search={search}
      initialReview={initialReview}
      transport={{
        read: (stream, cursor, detail, session) =>
          readSubjectReleaseFidelity({
            data: editorRequest({ id, stream, cursor, detail, session }, editorWork),
            headers: csrfHeaders(),
          }),
        facts: {
          read: () => readCorrection({ data: editorRequest({ id }, editorWork), headers: csrfHeaders() }),
          propose: (data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        },
        relation: (holder) => ({
          read: (slot, cursor, session) =>
            readSubjectRelationEditor({
              data: editorRequest({ id: holder, slot, cursor, session }, editorWork),
              headers: csrfHeaders(),
            }),
          propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        }),
        review: (_property, initialSession) => ({
          read: async (property, cursor, session = initialSession, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            return readSubjectCandidates({
              data: { expectedReader: work.reader, id, property, cursor, session },
              headers: csrfHeaders(),
            });
          },
          confirm: async (command, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            return confirmSubjectCandidate({ data: command, headers: csrfHeaders() });
          },
        }),
      }}
    />
  );
}
