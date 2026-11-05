import { subjectVisitReturn } from './subject-visit-navigation';
import { m } from '../../paraglide/messages.js';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useLocation } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef, useCallback } from 'react';
import { getLocale } from '../../paraglide/runtime';
import { csrfHeaders } from '../../threads/composer';
import {
  activateCuration,
  publishCuration,
  publishCurationOnly,
  readCuration,
  readCurationActive,
  readDraftPreview,
  type CurationRead,
} from './curate-actions';
import { confirmSubjectCandidate, readSubjectCandidates } from './curate-actions';
import { changeOwnContribution, rereadOwnContribution } from '../catalogue/contribution-lifecycle-actions';
import { editorRequest } from '../catalogue/editor-request';
import { CandidateReview } from '../../subject/candidate-review';
import { useSession } from '../../session/query';
import { PresentationViewEditor, type CurationEditorTransport } from './curate-view-editor';
import { PresentationPreviewPanel, PresentationPreviewContext } from './presentation-preview-view';
import { readPresentationPreview } from './curate-actions';
import { CurationReaderAdmission } from './curation-reader-admission';
import type { PresentationPreviewRead } from './presentation-preview';

const publicationTransport: CurationEditorTransport = {
  previewDraft: (input, signal) => readDraftPreview({ data: input, headers: csrfHeaders(), signal }),
  read: (expectedReader) => readCurationActive({ data: { expectedReader }, headers: csrfHeaders() }),
  publish: (intent, expectedReader) => publishCuration({ data: { intent, expectedReader }, headers: csrfHeaders() }),
  publishOnly: (intent, expectedReader) =>
    publishCurationOnly({ data: { intent, expectedReader }, headers: csrfHeaders() }),
  activate: (intent, expectedReader) =>
    activateCuration({ data: { ...intent, expectedReader }, headers: csrfHeaders() }),
  readOpening: (expectedReader, signal) => readCuration({ data: { expectedReader }, signal, headers: csrfHeaders() }),
};

/** The subject's private curation region shares the existing prepared BFF transport. */
function SubjectCandidateCurationLive({ id, locale }: { id: string; locale: string }) {
  const { state } = useSession();
  const location = useLocation();
  const params = new URLSearchParams(location.searchStr);
  const field = params.get('candidateField') ?? undefined;
  const statement = params.get('sourceStatement');
  const sourceReturn = subjectVisitReturn(params.get('via'), locale);
  const correction =
    sourceReturn?.endsWith('/sources#subject-sources-heading') &&
    statement &&
    /^[0-9a-f-]{36}$/i.test(statement) &&
    field
      ? `${location.pathname.replace(/\/details$/, '/edit')}?${new URLSearchParams({ property: field, statement, returnTo: 'sources' })}`
      : undefined;
  const initialProperty = field && field.length <= 256 ? field : undefined;
  if (state !== 'signed-in') return null;
  return (
    <div className="space-y-4">
      {correction && (
        <a className="inline-flex min-h-11 items-center underline" href={correction}>
          {m.correction_title()}
        </a>
      )}
      <CandidateReview
        key={`${id}:${locale}:${initialProperty ?? ''}`}
        initialProperty={initialProperty}
        {...(sourceReturn ? { returnHref: sourceReturn, returnLabel: m.subject_sources() } : {})}
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
          read: (address, work) =>
            rereadOwnContribution({ data: editorRequest(address, work), headers: csrfHeaders() }),
        }}
      />
    </div>
  );
}

export const SubjectCandidateCuration = candidateSession(SubjectCandidateCurationLive);

/** Keep session/CSRF preparation at the existing BFF boundary; the editor owns only its local drafts. */
export function CurationView({
  initial,
  transport = publicationTransport,
}: {
  initial: CurationRead;
  transport?: CurationEditorTransport;
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
  const readPublished = useCallback<PresentationPreviewRead>(
    (input, signal) => readPresentationPreview({ data: input, signal, headers: csrfHeaders() }),
    [],
  );
  return (
    <PresentationViewEditor
      initial={initial}
      locale={locale}
      admission={admission}
      transport={transport}
      preview={<PresentationPreviewPanel key={locale} locale={locale} read={readPublished} {...preview} />}
    />
  );
}
