import { useLocation } from '@tanstack/react-router';
import { useContext } from 'react';
import { getLocale } from '../../paraglide/runtime';
import { csrfHeaders } from '../../threads/composer';
import { publishCuration, readCuration, type CurationRead } from './curate-actions';
import { confirmSubjectCandidate, readSubjectCandidates } from './curate-actions';
import { CandidateReview } from '../../subject/candidate-review';
import { useSession } from '../../session/query';
import { PresentationViewEditor } from './curate-view-editor';
import type { PublicationTransport } from './curation-publish';
import { PresentationPreviewPanel, PresentationPreviewContext } from './presentation-preview-view';
import { readPresentationPreview } from './curate-actions';

const publicationTransport: PublicationTransport = {
  read: (expectedReader) => readCuration({ data: { expectedReader }, headers: csrfHeaders() }),
  publish: (intent, expectedReader) => publishCuration({ data: { intent, expectedReader }, headers: csrfHeaders() }),
};

/** The subject's private curation region shares the existing prepared BFF transport. */
export function SubjectCandidateCuration({ id, locale }: { id: string; locale: string }) {
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
        read: (property, cursor, session) =>
          readSubjectCandidates({ data: { id, property, cursor, session }, headers: csrfHeaders() }),
        confirm: (data) => confirmSubjectCandidate({ data, headers: csrfHeaders() }),
      }}
    />
  );
}

/** Keep session/CSRF preparation at the existing BFF boundary; the editor owns only its local drafts. */
export function CurationView({
  initial,
  transport = publicationTransport,
}: {
  initial: CurationRead;
  transport?: PublicationTransport;
}) {
  const preview = useContext(PresentationPreviewContext);
  const session = useSession();
  const locale = getLocale();
  return (
    <PresentationViewEditor
      initial={initial}
      locale={locale}
      observedSession={session}
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
