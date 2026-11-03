import { candidateSession } from '../../subject/candidate-lifetime';
import { useLocation } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef } from 'react';
import { getLocale } from '../../paraglide/runtime';
import { csrfHeaders } from '../../threads/composer';
import { publishCuration, readCuration, type CurationRead } from './curate-actions';
import { confirmSubjectCandidate, readSubjectCandidates } from './curate-actions';
import { changeOwnContribution, rereadOwnContribution } from '../catalogue/contribution-lifecycle-actions';
import { editorRequest } from '../catalogue/editor-request';
import { CandidateReview } from '../../subject/candidate-review';
import { useSession } from '../../session/query';
import { PresentationViewEditor } from './curate-view-editor';
import type { PublicationTransport } from './curation-publish';
import { PresentationPreviewPanel, PresentationPreviewContext } from './presentation-preview-view';
import { readPresentationPreview } from './curate-actions';
import { CurationReaderAdmission } from './curation-reader-admission';

const publicationTransport: PublicationTransport = {
  read: (expectedReader) => readCuration({ data: { expectedReader }, headers: csrfHeaders() }),
  publish: (intent, expectedReader) => publishCuration({ data: { intent, expectedReader }, headers: csrfHeaders() }),
};

/** The subject's private curation region shares the existing prepared BFF transport. */
function SubjectCandidateCurationLive({ id, locale }: { id: string; locale: string }) {
  const { state } = useSession();
  const field = new URLSearchParams(useLocation().searchStr).get('candidateField') ?? undefined;
  const initialProperty = field && field.length <= 256 ? field : undefined;
  if (state !== 'signed-in') return null;
  return (
    <CandidateReview
      key={`${id}:${locale}:${initialProperty ?? ''}`}
      initialProperty={initialProperty}
      id={id}
      locale={locale}
      transport={{
        read: (property, cursor, session, work) =>
          !work?.live()
            ? Promise.resolve({ ok: false, reason: 'denied' })
            : readSubjectCandidates({
                data: { id, property, cursor, session, expectedReader: work.reader },
                headers: csrfHeaders(),
              }),
        confirm: (data, work) =>
          !work?.live()
            ? Promise.resolve({ ok: false, reason: 'denied' })
            : confirmSubjectCandidate({ data, headers: csrfHeaders() }),
      }}
      lifecycle={{
        change: (command, work) =>
          changeOwnContribution({ data: editorRequest(command, work), headers: csrfHeaders() }),
        read: (address, work) => rereadOwnContribution({ data: editorRequest(address, work), headers: csrfHeaders() }),
      }}
    />
  );
}

export const SubjectCandidateCuration = candidateSession(SubjectCandidateCurationLive);

/** Keep session/CSRF preparation at the existing BFF boundary; the editor owns only its local drafts. */
export function CurationView({
  initial,
  transport = publicationTransport,
}: {
  initial: CurationRead;
  transport?: PublicationTransport;
}) {
  const preview = useContext(PresentationPreviewContext);
  const queryClient = useQueryClient();
  const admissionRef = useRef<CurationReaderAdmission | null>(null);
  if (!admissionRef.current || admissionRef.current.queryClient !== queryClient) {
    const replaced = admissionRef.current !== null;
    admissionRef.current?.retireForReplacement();
    admissionRef.current = new CurationReaderAdmission(queryClient, initial.ok ? initial.reader : null, {
      forceFresh: replaced,
    });
  } else {
    admissionRef.current.updateInitial(initial.ok ? initial.reader : null);
  }
  const admission = admissionRef.current;
  useLayoutEffect(() => admission.attach(), [admission]);
  const locale = getLocale();
  return (
    <PresentationViewEditor
      initial={initial}
      locale={locale}
      admission={admission}
      transport={transport}
      preview={
        <PresentationPreviewPanel
          key={locale}
          locale={locale}
          read={(input) => readPresentationPreview({ data: input, headers: csrfHeaders() })}
          {...preview}
        />
      }
    />
  );
}
