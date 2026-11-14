import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ContentItem } from '@rezics/ui/content-item';
import { formatJournalAssessment, formatJournalDate } from '@rezics/progress';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { DiaryOccurrence, DiaryPage } from '@rezics/client';
import { displayLibraryTitle } from '../title';
import { diaryReturnContext, type DiaryAddress } from './address';

type ReportedDate = Extract<DiaryOccurrence['reportedDates'], { availability: 'available' }>['startDate'];

function dateReading(occurrence: DiaryOccurrence, value: ReportedDate) {
  if (occurrence.reportedDates.availability === 'unavailable') return m.library_diary_reported_unavailable();
  return value === null ? m.library_diary_reported_not_reported() : formatJournalDate(value);
}

function stateLabel(state: DiaryOccurrence['state']) {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

function nativeTime(value: string | null): ReactNode {
  if (value === null) return m.library_diary_not_completed();
  return (
    <span className="block min-w-0">
      <time dateTime={value}>
        {new Intl.DateTimeFormat(getLocale(), {
          year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
          second: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
        }).format(new Date(value))}
      </time>
      <code className="mt-1 block break-all text-xs text-muted-foreground" aria-label={m.library_diary_recorded_timestamp_exact()}>
        {value}
      </code>
    </span>
  );
}

function AssessmentReading({ occurrence }: { occurrence: DiaryOccurrence }) {
  const assessment = occurrence.assessment;
  const supported = assessment !== undefined && assessment.meaningRevision === 1;
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">{m.library_occurrence_assessment()}</h4>
      <p className="text-sm">
        {!supported ? m.library_occurrence_assessment_unavailable() : assessment.units === null
          ? m.library_diary_assessment_cleared()
          : m.library_diary_assessment_value({ value: formatJournalAssessment(assessment.units) })}
      </p>
      <p className="text-sm text-muted-foreground">{m.library_diary_assessment_scope()}</p>
      {supported ? <p className="text-xs text-muted-foreground">
        {m.library_diary_assessment_meaning_revision({ revision: String(assessment.meaningRevision) })}
      </p> : null}
    </div>
  );
}

/** This compact native projection contains no reflection or amount. Open the occurrence for those owner reads. */
export function ReadingOccurrence({ occurrence, page, address, returnTo }: {
  occurrence: DiaryOccurrence;
  page: DiaryPage;
  address: DiaryAddress;
  returnTo: string;
}) {
  const subjectLabel = occurrence.subject?.label ?? m.library_diary_subject_unavailable();
  const subjectLanguage = occurrence.subject?.language ?? m.library_diary_language_unavailable();
  const title = occurrence.subject?.label && occurrence.subject.language
    ? displayLibraryTitle({ value: occurrence.subject.label, language: occurrence.subject.language }, getLocale())
    : { text: subjectLabel, lang: undefined };
  const versionAttached = occurrence.versionSubjectId !== null;
  const versionLabel = !versionAttached ? m.library_diary_version_not_attached()
    : (occurrence.versionSubject?.label ?? m.library_diary_version_unavailable());
  const versionLanguage = !versionAttached ? m.library_diary_version_not_attached()
    : (occurrence.versionSubject?.language ?? m.library_diary_language_unavailable());
  const dates = occurrence.reportedDates;
  const startDate = dateReading(occurrence, dates.availability === 'available' ? dates.startDate : null);
  const finishDate = dateReading(occurrence, dates.availability === 'available' ? dates.finishDate : null);
  const facts = [
    { id: 'subject-label', label: m.library_diary_subject_label(), value: subjectLabel },
    { id: 'subject-language', label: m.library_diary_subject_language(), value: subjectLanguage },
    { id: 'version-subject', label: m.library_diary_version_subject(), value: versionLabel },
    { id: 'version-language', label: m.library_diary_version_language(), value: versionLanguage },
    { id: 'reported-start', label: m.library_diary_reported_start(), value: startDate },
    { id: 'reported-finish', label: m.library_diary_reported_finish(), value: finishDate },
    { id: 'recorded-start', label: m.library_diary_recorded_start(), value: nativeTime(occurrence.recordedStartedAt) },
    { id: 'recorded-completion', label: m.library_diary_recorded_completion(), value: nativeTime(occurrence.recordedCompletedAt) },
  ];
  const returnContext = diaryReturnContext({ ...address, snapshot: page.currentness?.revision, focus: occurrence.id, returnTo });
  return (
    <ContentItem
      title={title.text}
      {...(title.lang ? { titleLang: title.lang } : {})}
      headingLevel={3}
      className="min-w-0 rounded-xl border bg-card px-4 sm:px-5 [&_h3]:text-lg [&_h3]:[overflow-wrap:anywhere]"
      state={<span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
        {m.library_diary_state({ state: stateLabel(occurrence.state) })}
      </span>}
      metadata={<div className="space-y-1 text-sm text-muted-foreground">
        <p>{m.library_history_recorded_event()}</p>
        {versionAttached ? <p lang={occurrence.versionSubject?.language ?? undefined} className="[overflow-wrap:anywhere]">{versionLabel}</p> : null}
      </div>}
      preview={<div className="min-w-0 space-y-3">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">{m.library_diary_reported_start()}</dt><dd className="mt-0.5">{startDate}</dd></div>
          <div><dt className="text-muted-foreground">{m.library_diary_reported_finish()}</dt><dd className="mt-0.5">{finishDate}</dd></div>
        </dl>
        <details className="min-w-0 border-t">
          <summary className="min-h-11 cursor-pointer content-center rounded px-1 text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.library_diary_review_details()}
          </summary>
          <div className="space-y-4 pb-4 pt-2">
            <p className="text-sm">{m.library_diary_review_read_only()}</p>
            <dl className="grid min-w-0 gap-x-5 gap-y-3 sm:grid-cols-2">
              {facts.map(({ id, label, value }) => <div className="min-w-0" key={id}>
                <dt className="text-sm font-medium">{label}</dt><dd className="mt-1 min-w-0 break-words">{value}</dd>
              </div>)}
              <div className="min-w-0"><dt className="text-sm font-medium">{m.library_diary_occurrence_id()}</dt><dd className="mt-1 break-all font-mono text-sm">{occurrence.id}</dd></div>
              <div className="min-w-0"><dt className="text-sm font-medium">{m.library_diary_occurrence_revision()}</dt><dd className="mt-1 font-mono text-sm">{String(occurrence.revision)}</dd></div>
              <div className="min-w-0"><dt className="text-sm font-medium">{m.library_diary_page_revision()}</dt><dd className="mt-1 break-all font-mono text-sm">{page.currentness?.revision ?? m.library_diary_page_revision_unavailable()}</dd></div>
              <div className="min-w-0"><dt className="text-sm font-medium">{m.library_diary_page_order()}</dt><dd className="mt-1 break-all font-mono text-sm">{page.order}</dd></div>
            </dl>
            <AssessmentReading occurrence={occurrence} />
          </div>
        </details>
      </div>}
      actions={<Link
        className="inline-flex min-h-11 w-full items-center justify-center rounded-md border px-4 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto"
        id={'diary-occurrence-' + occurrence.id}
        to="/library/progress/$id" params={{ id: occurrence.id }} search={{ history: returnContext }}
      >{m.library_diary_open_occurrence()}</Link>}
    />
  );
}
