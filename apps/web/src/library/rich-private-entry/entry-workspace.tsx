import type { MouseEvent, RefObject } from 'react';
import type {
  PersonalEntry,
  PersonalEntryObservation,
  PersonalEntrySourceCorrection,
} from '@rezics/client';
import { m } from '../../paraglide/messages.js';
import type { AnnotationDraft, AnnotationConfirmation, AnnotationField, AnnotationIssues } from './contract';
import {
  AnnotationEditor,
  type AnnotationEditorRefs,
} from './annotation-editor';
import { AnnotationNote, AnnotationPriority, AnnotationReview, AnnotationSaved } from './annotation-review';
import { AnnotationDeparture, type AnnotationDepartureIntent } from './annotation-departure';
import {
  SourceCorrectionEditor,
  type SourceCorrectionNotice,
} from './source-correction-editor';

function privacyText(value: PersonalEntryObservation['privacy']) {
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'cleared') return m.library_rich_source_cleared();
  if (value.status === 'unknown')
    return value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  return value.meaning === 'private' ? m.library_rich_source_private() : m.library_rich_source_visible();
}

function timestampText(value: PersonalEntryObservation['sourceCreated']) {
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'cleared') return m.library_rich_source_cleared();
  if (value.status === 'unknown')
    return value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  return m.library_rich_source_timestamp({
    value: value.value,
    precision:
      value.precision === 'year'
        ? m.library_rich_entry_precision_year()
        : value.precision === 'month'
          ? m.library_rich_entry_precision_month()
          : value.precision === 'day'
            ? m.library_rich_entry_precision_day()
            : value.precision === 'minute'
              ? m.library_rich_entry_precision_minute()
              : value.precision === 'second'
                ? m.library_rich_entry_precision_second()
                : m.library_rich_entry_precision_fraction(),
    zone:
      value.zone === 'utc'
        ? m.library_rich_entry_zone_utc()
        : value.zone === 'offset'
          ? m.library_rich_entry_zone_offset()
          : m.library_rich_entry_zone_unknown(),
  });
}

type AnnotationWorkspaceProps = {
  draft: AnnotationDraft;
  issues: AnnotationIssues;
  disabled: boolean;
  reviewDisabled: boolean;
  canDiscard: boolean;
  refs: AnnotationEditorRefs;
  confirmation: AnnotationConfirmation | null;
  submitted: boolean;
  blocked: boolean;
  savedEntry: PersonalEntry | null;
  localOutcome: 'unchanged' | 'discarded' | null;
  pending: boolean;
  uncertain: boolean;
  denied: boolean;
  missing: boolean;
  conflict: boolean;
  refreshing: boolean;
  reviewLatestAvailable: boolean;
  departure: AnnotationDepartureIntent | null;
  unresolved: boolean;
  sourceOpen: boolean;
  returnFocus: HTMLElement | null;
  onChange: (draft: AnnotationDraft) => void;
  onReview: () => void;
  onAskDiscard: (trigger: HTMLButtonElement) => void;
  onEdit: (field: AnnotationField) => void;
  onSave: () => void;
  onCloseReview: () => void;
  onRetry: () => void;
  onReviewLatest: () => void;
  onRefreshConflict: () => void;
  onStay: () => void;
  onDepartureDiscard: (leave: boolean) => void;
};

type SourceWorkspaceProps = {
  factsReady: boolean;
  editorKey: string | null;
  baseline: PersonalEntryObservation | null;
  displayed: PersonalEntryObservation | null;
  notice: SourceCorrectionNotice | null;
  conflictRevision: number | null;
  pending: boolean;
  savedBody: PersonalEntrySourceCorrection | null;
  savedObservation: PersonalEntryObservation | null;
  disabled: boolean;
  writeAllowed: boolean;
  viewer: string | null;
  originLifetime: string;
  announceConflict: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onOpen: (observation: PersonalEntryObservation, event: MouseEvent<HTMLButtonElement>) => void;
  onSubmit: (body: PersonalEntrySourceCorrection) => void;
  onRetry: () => void;
  onRefresh: () => void;
  onReviewLatest: () => void;
  onCancel: () => void;
  onEdit: () => void;
};

export type EntryWorkspaceProps = {
  subject: { id: string; label: string };
  entry: PersonalEntry;
  diaryHref: string;
  onDiaryClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  annotation: AnnotationWorkspaceProps;
  source: SourceWorkspaceProps;
};

export function EntryWorkspace({ subject, entry, diaryHref, onDiaryClick, annotation, source }: EntryWorkspaceProps) {
  function correctionEditor(baseline: PersonalEntryObservation, current: PersonalEntryObservation | null) {
    return (
      <SourceCorrectionEditor
        key={`${subject.id}:${source.viewer}:${source.originLifetime}:${baseline.provider}:${baseline.recordId}`}
        baseline={baseline}
        current={current}
        notice={source.notice}
        conflictRevision={source.conflictRevision}
        pending={source.pending}
        savedBody={source.savedBody}
        savedObservation={source.savedObservation}
        disabled={source.disabled}
        onSubmit={source.onSubmit}
        onRetry={source.onRetry}
        onRefresh={source.onRefresh}
        onReviewLatest={source.onReviewLatest}
        onCancel={source.onCancel}
        onEdit={source.onEdit}
      />
    );
  }

  return (
    <section aria-labelledby="rich-private-entry-heading" className="mt-5 rounded-lg border p-4 sm:p-5">
      <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="rich-private-entry-heading" className="text-lg font-semibold">
            {m.library_rich_entry_heading()}
          </h2>
          <p className="mt-1 break-words text-sm font-medium">{subject.label}</p>
          <p className="mt-1 text-sm text-muted-foreground">{m.library_rich_entry_private_help()}</p>
        </div>
        <a
          className="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-md border px-3 text-sm sm:w-auto"
          href={diaryHref}
          onClick={onDiaryClick}
        >
          {m.library_rich_entry_diary_link()}
        </a>
      </header>

      <div className="grid gap-6 pt-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(17rem,0.85fr)]">
        <section aria-label={m.library_annotation_edit_title()} className="min-w-0 space-y-4">
          <div hidden={annotation.confirmation !== null}>
            <AnnotationEditor
              draft={annotation.draft}
              issues={annotation.issues}
              disabled={annotation.disabled}
              reviewDisabled={annotation.reviewDisabled}
              canDiscard={annotation.canDiscard}
              refs={annotation.refs}
              onChange={annotation.onChange}
              onReview={annotation.onReview}
              onDiscard={annotation.onAskDiscard}
            />
          </div>
          {annotation.confirmation ? (
            <AnnotationReview
              subject={subject}
              confirmation={annotation.confirmation}
              submitted={annotation.submitted}
              blocked={annotation.blocked}
              onEdit={annotation.onEdit}
              onSave={annotation.onSave}
              onClose={annotation.onCloseReview}
              onDiscard={annotation.onAskDiscard}
            />
          ) : null}

          {annotation.savedEntry ? <AnnotationSaved entry={annotation.savedEntry} /> : null}
          {annotation.localOutcome ? (
            <p role="status" className="rounded-md border p-3 text-sm">
              {annotation.localOutcome === 'unchanged' ? m.library_annotation_no_change() : m.library_annotation_discarded()}
            </p>
          ) : null}
          {annotation.pending ? (
            <div className="space-y-2 rounded-md border p-3" role="status" aria-live="polite">
              <p>{annotation.uncertain ? m.library_rich_entry_uncertain() : m.library_annotation_saving()}</p>
              <p className="text-sm text-muted-foreground">{m.library_annotation_pending_help()}</p>
              {annotation.uncertain ? (
                <button
                  type="button"
                  className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground"
                  onClick={annotation.onRetry}
                >
                  {m.library_rich_entry_retry()}
                </button>
              ) : null}
            </div>
          ) : null}
          {annotation.denied ? <p role="status">{m.library_rich_entry_denied()}</p> : null}
          {annotation.missing ? <p role="status">{m.library_rich_entry_missing()}</p> : null}

          {annotation.conflict ? (
            <div
              role="group"
              aria-label={m.library_rich_entry_conflict()}
              className="space-y-3 rounded-md border border-amber-600 p-3"
            >
              <h3 className="font-semibold">{m.library_rich_entry_conflict()}</h3>
              <dl className="grid gap-3 break-words sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-sm font-medium">{m.library_rich_entry_note()}</dt>
                  <dd className="mt-1">
                    <AnnotationNote value={entry.note} />
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium">{m.library_rich_entry_priority()}</dt>
                  <dd className="mt-1">
                    <AnnotationPriority value={entry.priority} />
                  </dd>
                </div>
              </dl>
              {annotation.refreshing ? (
                <p role="status">{m.library_rich_entry_refreshing()}</p>
              ) : annotation.reviewLatestAvailable ? (
                <button
                  type="button"
                  className="min-h-11 w-full rounded-md bg-primary px-4 text-primary-foreground sm:w-auto"
                  onClick={annotation.onReviewLatest}
                >
                  {m.library_rich_entry_review_latest()}
                </button>
              ) : (
                <button
                  type="button"
                  className="min-h-11 w-full rounded-md border px-3 sm:w-auto"
                  onClick={annotation.onRefreshConflict}
                >
                  {m.library_selection_retry()}
                </button>
              )}
            </div>
          ) : null}

          <AnnotationDeparture
            intent={annotation.departure}
            unresolved={annotation.unresolved}
            sourceOpen={annotation.sourceOpen}
            diaryHref={diaryHref}
            onStay={annotation.onStay}
            onDiscard={annotation.onDepartureDiscard}
            returnFocus={annotation.returnFocus}
          />
        </section>

        <aside
          aria-labelledby="rich-private-entry-sources-heading"
          className="min-w-0 space-y-4 border-t pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"
        >
          <header>
            <h3
              ref={source.headingRef}
              id="rich-private-entry-sources-heading"
              tabIndex={-1}
              className="font-semibold outline-none"
            >
              {m.library_rich_entry_sources()}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{m.library_rich_entry_sources_help()}</p>
            <p className="mt-1 text-sm text-muted-foreground">{m.library_rich_entry_timestamp_is_source_evidence()}</p>
          </header>

          {!source.factsReady ? (
            <p role="status">{m.library_rich_entry_source_retired()}</p>
          ) : entry.sourceObservations.length === 0 ? (
            <p>{m.library_rich_entry_no_sources()}</p>
          ) : (
            <ul className="space-y-3">
              {entry.sourceObservations.map((observation) => {
                const identity = observation.provider + '\u0000' + observation.recordId;
                const open = source.editorKey === identity;
                return (
                  <li key={observation.provider + ':' + observation.recordId} className="min-w-0 rounded-md border p-3">
                    <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                      <div className="min-w-0 sm:col-span-2">
                        <dt className="text-sm font-medium">{m.library_rich_entry_privacy()}</dt>
                        <dd className="mt-1 break-words">{privacyText(observation.privacy)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-sm font-medium">{m.library_rich_entry_source_created()}</dt>
                        <dd className="mt-1 break-words">{timestampText(observation.sourceCreated)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-sm font-medium">{m.library_rich_entry_source_updated()}</dt>
                        <dd className="mt-1 break-words">{timestampText(observation.sourceUpdated)}</dd>
                      </div>
                    </dl>

                    <div className="mt-3 space-y-2 border-t pt-3 text-sm">
                      <p className="break-words text-muted-foreground">
                        {m.library_rich_entry_current_source_revision({ revision: observation.revision })}
                      </p>
                      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                        <div className="min-w-0">
                          <dt className="font-medium text-muted-foreground">{m.library_rich_entry_provider()}</dt>
                          <dd className="mt-1 break-words">{observation.provider}</dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="font-medium text-muted-foreground">{m.library_rich_entry_record()}</dt>
                          <dd className="mt-1 break-all">{observation.recordId}</dd>
                        </div>
                        <div className="min-w-0 sm:col-span-2">
                          <dt className="font-medium text-muted-foreground">{m.library_rich_entry_native_recorded()}</dt>
                          <dd className="mt-1 break-words">{observation.recordedAt}</dd>
                        </div>
                      </dl>
                    </div>

                    <button
                      type="button"
                      className="mt-3 min-h-11 w-full rounded-md border px-3 sm:w-auto"
                      disabled={!source.writeAllowed || annotation.pending || source.pending}
                      onClick={(event) => source.onOpen(observation, event)}
                    >
                      {m.library_rich_entry_edit_source_facts()}
                    </button>
                    {open && source.baseline ? correctionEditor(source.baseline, source.displayed) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {source.factsReady && source.editorKey && source.baseline && !source.displayed ? (
            <div className="rounded-md border p-3">{correctionEditor(source.baseline, null)}</div>
          ) : null}
        </aside>
      </div>
      <span className="sr-only" aria-live="polite">
        {source.announceConflict ? m.library_rich_entry_source_conflict() : ''}
      </span>
    </section>
  );
}
