import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { useEffect, useState } from 'react';
import { CopyEditionPicker } from '../copy-edition-picker';
import { m } from '../../paraglide/messages.js';
import { actionClass } from '../private-export/controls';
import {
  RECOVERY_SELECTED_OCCURRENCES,
  RECOVERY_ID,
  type RecoveryCollection,
  type RecoveryCollectionsPage,
  type RecoveryOccurrence,
  type RecoveryOccurrencesPage,
  type RecoveryReview,
} from './contract';
import { canSelectOccurrence, selectionLimitReached, type OccurrenceSelection } from './selection';

function sectionLabel(section: string): string {
  switch (section) {
    case 'entries':
      return m.library_export_section_entries();
    case 'labels':
      return m.library_export_section_labels();
    case 'assignments':
      return m.library_export_section_assignments();
    case 'sessions':
      return m.library_export_section_sessions();
    case 'units':
      return m.library_export_section_units();
    case 'history':
      return m.library_export_section_history();
    case 'holdings':
      return m.library_export_section_holdings();
    case 'collections':
      return m.library_export_section_collections();
    case 'collectionPins':
      return m.library_export_section_pins();
    case 'occurrences':
      return m.library_export_section_occurrences();
    case 'bangumiUploads':
    case 'bangumiEvidence':
      return m.library_export_section_bangumi();
    case 'malImports':
    case 'malEvidence':
      return m.library_export_section_mal();
    default:
      return m.library_export_section_other({ section });
  }
}

function Coverage({ page }: { page: RecoveryCollectionsPage }) {
  return (
    <section className="grid gap-3 rounded-xl border p-4" aria-labelledby="recovery-coverage-title">
      <h2 id="recovery-coverage-title" className="text-lg font-semibold">
        {m.library_archive_recovery_coverage_title()}
      </h2>
      <p>{m.library_archive_recovery_coverage_scope()}</p>
      {page.manifest ? (
        <p className="text-sm">{m.library_archive_recovery_manifest_rows({ rows: page.manifest.rows })}</p>
      ) : null}
      <ul className="grid gap-2">
        {page.coverage.map((item) => (
          <li key={item.section} className="grid gap-1 rounded-md bg-muted/40 p-3 text-sm">
            <span className="font-medium">{sectionLabel(item.section)}</span>
            <span>
              {item.capture === 'empty'
                ? m.library_archive_recovery_coverage_empty()
                : item.treatment === 'retained-unsupported'
                  ? m.library_archive_recovery_coverage_unsupported({ rows: item.rows })
                  : m.library_archive_recovery_coverage_requires_mapping({ rows: item.rows })}
            </span>
            <span className="text-muted-foreground">
              {item.capture === 'empty'
                ? m.library_archive_recovery_coverage_empty()
                : item.treatment === 'retained-unsupported'
                  ? m.library_archive_recovery_coverage_scope()
                  : m.library_archive_recovery_coverage_requires_mapping({ rows: item.rows })}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{m.library_archive_recovery_omissions()}</p>
    </section>
  );
}

function CollectionOption({
  collection,
  disabled,
  onChoose,
}: {
  collection: RecoveryCollection;
  disabled: boolean;
  onChoose: (collection: RecoveryCollection) => void;
}) {
  return (
    <li className="grid min-w-0 gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="grid min-w-0 gap-2">
        <h3 className="break-words font-semibold">{collection.title || m.library_archive_recovery_untitled()}</h3>
        {collection.description ? <p className="break-words text-sm">{collection.description}</p> : null}
        <p className="text-sm text-muted-foreground">
          {m.library_archive_recovery_collection_members({ count: collection.memberCount })}
          {' · '}
          {collection.orderComplete
            ? m.library_archive_recovery_order_available()
            : m.library_archive_recovery_order_incomplete()}
        </p>
        <p className="text-sm">
          {collection.eligible
            ? m.library_archive_recovery_private_collection()
            : m.library_archive_recovery_collection_unsupported()}
        </p>
      </div>
      <button
        type="button"
        className={actionClass}
        disabled={disabled || !collection.eligible}
        onClick={() => onChoose(collection)}
      >
        {m.library_archive_recovery_choose_collection()}
      </button>
    </li>
  );
}

export function ArchiveCollectionChooser({
  page,
  busy,
  onChoose,
  onFirst,
  onNext,
}: {
  page: RecoveryCollectionsPage;
  busy: boolean;
  onChoose: (collection: RecoveryCollection) => void;
  onFirst: () => void;
  onNext: (cursor: string) => void;
}) {
  return (
    <div className="grid gap-6">
      <Coverage page={page} />
      <section className="grid gap-4" aria-labelledby="recovery-collections-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="grid gap-1">
            <h2 id="recovery-collections-title" className="text-lg font-semibold">
              {m.library_archive_recovery_collections_title()}
            </h2>
            <p className="text-sm text-muted-foreground">{m.library_archive_recovery_collection_window()}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={actionClass} type="button" disabled={busy} onClick={onFirst}>
              {m.library_archive_recovery_first_page()}
            </button>
            {page.next ? (
              <button className={actionClass} type="button" disabled={busy} onClick={() => onNext(page.next!)}>
                {m.library_archive_recovery_next_page()}
              </button>
            ) : null}
          </div>
        </div>
        {page.collections.length ? (
          <ul className="grid gap-3">
            {page.collections.map((collection) => (
              <CollectionOption key={collection.id} collection={collection} disabled={busy} onChoose={onChoose} />
            ))}
          </ul>
        ) : (
          <p role="status" className="rounded-lg border p-4">
            {page.sourceRecordCount === 0
              ? m.library_archive_recovery_no_collections()
              : m.library_archive_recovery_no_collection_window()}
          </p>
        )}
      </section>
    </div>
  );
}

function noteLabel(row: RecoveryOccurrence): string {
  if (!row.notePresent) return m.library_archive_recovery_note_missing();
  if (!row.noteValid) return m.library_archive_recovery_note_invalid();
  if (row.noteState === 'cleared') return m.library_archive_recovery_note_cleared();
  if (row.noteState === 'empty') return m.library_archive_recovery_note_empty();
  return m.library_archive_recovery_note_value();
}

function OccurrenceRow({
  row,
  selected,
  disabled,
  limitReached,
  index,
  onToggle,
}: {
  row: RecoveryOccurrence;
  selected: boolean;
  disabled: boolean;
  limitReached: boolean;
  index: number;
  onToggle: (row: RecoveryOccurrence) => void;
}) {
  const unavailable = !canSelectOccurrence(row);
  return (
    <li className="grid min-w-0 gap-3 rounded-lg border p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
      <label className="flex min-h-11 items-center gap-3 sm:items-start sm:pt-1">
        <input
          type="checkbox"
          className="size-5 shrink-0 accent-primary"
          checked={selected}
          disabled={disabled || unavailable || (!selected && limitReached)}
          onChange={() => onToggle(row)}
          aria-label={m.library_archive_recovery_select_occurrence({ occurrence: index + 1 })}
        />
        <span className="font-medium">{m.library_archive_recovery_occurrence_number({ occurrence: index + 1 })}</span>
      </label>
      <div className="grid min-w-0 gap-2">
        <p className="break-all text-xs text-muted-foreground">
          {m.library_archive_recovery_occurrence_id({ id: row.sourceOccurrenceId })}
        </p>
        <p className="text-sm">
          {row.sourceSubjectId
            ? m.library_archive_recovery_source_subject({ id: row.sourceSubjectId })
            : m.library_archive_recovery_subject_missing()}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm">
          <span className="font-medium">{noteLabel(row)}: </span>
          {row.note ?? m.library_archive_recovery_note_none()}
        </p>
        <p className="text-sm text-muted-foreground">
          {row.orderState === 'supported'
            ? m.library_archive_recovery_native_order()
            : m.library_archive_recovery_order_unsupported()}
        </p>
        {unavailable ? (
          <p className="text-sm text-destructive-foreground">{m.library_archive_recovery_note_cannot_preserve()}</p>
        ) : null}
      </div>
    </li>
  );
}

export function ArchiveOccurrenceChooser({
  page,
  selected,
  busy,
  onToggle,
  onTogglePage,
  onReview,
  onPage,
  onFirst,
  onCollections,
}: {
  page: RecoveryOccurrencesPage;
  selected: OccurrenceSelection;
  busy: boolean;
  onToggle: (row: RecoveryOccurrence) => void;
  onTogglePage: (rows: readonly RecoveryOccurrence[]) => void;
  onReview: () => void;
  onPage: (cursor: string) => void;
  onFirst: () => void;
  onCollections: () => void;
}) {
  const rows = page.occurrences;
  return (
    <section className="grid gap-4" aria-labelledby="recovery-occurrences-title">
      <div className="grid gap-2">
        <h2 id="recovery-occurrences-title" className="text-lg font-semibold">
          {m.library_archive_recovery_occurrences_title()}
        </h2>
        {page.collection ? (
          <div className="grid gap-2 rounded-lg border p-4">
            <p className="break-words font-medium">{page.collection.title ?? m.library_archive_recovery_untitled()}</p>
            {page.collection.description ? <p className="break-words text-sm">{page.collection.description}</p> : null}
            <p className="text-sm text-muted-foreground">{m.library_archive_recovery_destination_private()}</p>
          </div>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {m.library_archive_recovery_selection_count({ count: selected.size, maximum: RECOVERY_SELECTED_OCCURRENCES })}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={actionClass} type="button" disabled={busy} onClick={onCollections}>
          {m.library_archive_recovery_back_collections()}
        </button>
        <button
          className={actionClass}
          type="button"
          disabled={busy || !rows.some(canSelectOccurrence)}
          onClick={() => onTogglePage(rows)}
        >
          {m.library_archive_recovery_select_page()}
        </button>
        <button className={actionClass} type="button" disabled={busy} onClick={onFirst}>
          {m.library_archive_recovery_first_page()}
        </button>
        <button className={actionClass} type="button" disabled={busy || !selected.size} onClick={onReview}>
          {m.library_archive_recovery_open_review()}
        </button>
        {page.next ? (
          <button className={actionClass} type="button" disabled={busy} onClick={() => onPage(page.next!)}>
            {m.library_archive_recovery_next_page()}
          </button>
        ) : null}
      </div>
      {rows.length ? (
        <ol className="grid gap-3" aria-label={m.library_archive_recovery_occurrences_title()}>
          {rows.map((row, index) => (
            <OccurrenceRow
              key={row.sourceOccurrenceId}
              row={row}
              index={index}
              selected={selected.has(row.sourceOccurrenceId)}
              disabled={busy}
              limitReached={selectionLimitReached(selected)}
              onToggle={onToggle}
            />
          ))}
        </ol>
      ) : (
        <p role="status" className="rounded-lg border p-4">
          {m.library_archive_recovery_empty_occurrences()}
        </p>
      )}
    </section>
  );
}

function subjectSources(selected: OccurrenceSelection): string[] {
  return [
    ...new Set(
      [...selected.values()].flatMap((row) =>
        row.sourceSubjectId && RECOVERY_ID.test(row.sourceSubjectId) ? [row.sourceSubjectId] : [],
      ),
    ),
  ].sort();
}

export function ArchiveRecoveryReview({
  collection,
  selected,
  targets,
  review,
  busy,
  onTarget,
  onSubmit,
  onApply,
}: {
  collection: RecoveryCollection;
  selected: OccurrenceSelection;
  targets: ReadonlyMap<string, EntityPickerSubject>;
  review: RecoveryReview | null;
  busy: boolean;
  onTarget: (sourceSubjectId: string, target: EntityPickerSubject | null) => void;
  onSubmit: () => void;
  onApply: () => void;
}) {
  const sources = subjectSources(selected);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [review?.review?.reviewId]);
  return (
    <section className="grid gap-6" aria-labelledby="recovery-review-title">
      <div className="grid gap-3 rounded-xl border p-4 sm:p-6">
        <h2 id="recovery-review-title" className="text-lg font-semibold">
          {m.library_archive_recovery_review_title()}
        </h2>
        <p>{m.library_archive_recovery_review_help()}</p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <dt className="font-medium">{m.library_archive_recovery_destination()}</dt>
            <dd>{m.library_archive_recovery_new_private_destination()}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="font-medium">{m.library_archive_recovery_title_label()}</dt>
            <dd className="break-words">{collection.title}</dd>
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <dt className="font-medium">{m.library_archive_recovery_description_label()}</dt>
            <dd className="whitespace-pre-wrap break-words">
              {collection.description || m.library_archive_recovery_no_description()}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="font-medium">{m.library_archive_recovery_selected_label()}</dt>
            <dd>
              {m.library_archive_recovery_selection_count({
                count: selected.size,
                maximum: RECOVERY_SELECTED_OCCURRENCES,
              })}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="font-medium">{m.library_archive_recovery_order_label()}</dt>
            <dd>{m.library_archive_recovery_order_native_review()}</dd>
          </div>
        </dl>
      </div>

      <div className="grid gap-3">
        <h3 className="font-semibold">{m.library_archive_recovery_mappings_title()}</h3>
        <p className="text-sm text-muted-foreground">{m.library_archive_recovery_mappings_help()}</p>
        {sources.length ? (
          sources.map((sourceSubjectId) => (
            <div key={sourceSubjectId} className="grid min-w-0 gap-2 rounded-lg border p-4">
              <p className="break-all text-sm">{m.library_archive_recovery_source_subject({ id: sourceSubjectId })}</p>
              <CopyEditionPicker
                value={targets.get(sourceSubjectId) ?? null}
                disabled={busy || Boolean(review)}
                onChange={(target) => onTarget(sourceSubjectId, target)}
              />
            </div>
          ))
        ) : (
          <p role="status">{m.library_archive_recovery_no_mappings()}</p>
        )}
      </div>

      <div className="grid gap-3">
        <h3 className="font-semibold">{m.library_archive_recovery_notes_title()}</h3>
        <ol className="grid max-h-[30rem] gap-3 overflow-auto rounded-lg border p-3">
          {[...selected.values()].map((row) => (
            <li key={row.sourceOccurrenceId} className="grid gap-1 border-b pb-3 last:border-0 last:pb-0">
              <p className="break-all text-xs text-muted-foreground">
                {m.library_archive_recovery_occurrence_id({ id: row.sourceOccurrenceId })}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">
                <span className="font-medium">{noteLabel(row)}: </span>
                {row.note ?? m.library_archive_recovery_note_none()}
              </p>
              <p className="text-xs text-muted-foreground">
                {row.orderState === 'supported'
                  ? m.library_archive_recovery_native_order()
                  : m.library_archive_recovery_order_unsupported()}
              </p>
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">{m.library_archive_recovery_note_choice_help()}</p>
      </div>

      {review ? (
        <div className="grid gap-3 rounded-xl border border-primary/40 p-4" role="status">
          <h3 className="font-semibold">{m.library_archive_recovery_native_review_title()}</h3>
          <p>
            {review.completeMembership
              ? m.library_archive_recovery_membership_complete()
              : m.library_archive_recovery_membership_partial()}
          </p>
          <p>
            {review.completeOrder
              ? m.library_archive_recovery_order_complete()
              : m.library_archive_recovery_order_partial()}
          </p>
          {review.mappings.map((mapping) => (
            <p key={mapping.sourceSubjectId} className="break-all text-sm">
              {mapping.state === 'mapped'
                ? m.library_archive_recovery_mapping_current({
                    id: mapping.currentSubjectId ?? mapping.sourceSubjectId,
                  })
                : mapping.state === 'canonical-changed'
                  ? m.library_archive_recovery_mapping_changed()
                  : m.library_archive_recovery_mapping_unresolved()}
            </p>
          ))}
          <p>
            {review.pin.state === 'unsupported'
              ? m.library_archive_recovery_pin_unsupported()
              : m.library_archive_recovery_pin_state({ state: review.pin.state })}
          </p>
          <label className="flex min-h-11 items-start gap-3 rounded-md bg-muted/40 p-3">
            <input
              type="checkbox"
              className="mt-1 size-5 shrink-0 accent-primary"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            <span>{m.library_archive_recovery_confirm_private()}</span>
          </label>
          <button type="button" className={actionClass} disabled={busy || !confirmed} onClick={onApply}>
            {busy ? m.library_archive_recovery_applying() : m.library_archive_recovery_apply_action()}
          </button>
        </div>
      ) : (
        <button type="button" className={actionClass} disabled={busy || !selected.size} onClick={onSubmit}>
          {m.library_archive_recovery_review_action()}
        </button>
      )}
    </section>
  );
}
