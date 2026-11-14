import { formatJournalDate, type ProgressSessionJournalDate } from '@rezics/progress';
import { m } from '../../paraglide/messages.js';
import { EvidenceDetails, progressStateLabel } from '../archive-progress-recovery/review';
import type { ArchiveReviewItem, ArchiveRow } from './native';

export function sectionLabel(section: string): string {
  switch (section) {
    case 'entries': return m.library_export_section_entries();
    case 'labels': return m.library_export_section_labels();
    case 'assignments': return m.library_export_section_assignments();
    case 'annotations': return m.library_archive_present_annotations();
    case 'journals': return m.library_archive_present_journals();
    case 'provenance': return m.library_archive_present_observations();
    case 'sessions': return m.library_export_section_sessions();
    case 'units': return m.library_export_section_units();
    case 'history': return m.library_export_section_history();
    case 'holdings': return m.library_export_section_holdings();
    case 'collections': return m.library_export_section_collections();
    case 'collectionPins': return m.library_export_section_pins();
    case 'occurrences': return m.library_export_section_occurrences();
    case 'bangumiUploads':
    case 'bangumiEvidence': return m.library_export_section_bangumi();
    case 'malImports':
    case 'malEvidence': return m.library_export_section_mal();
    case 'vndbUploads':
    case 'vndbEvidence': return m.library_export_section_vndb();
    case 'anilistUploads':
    case 'anilistEvidence': return m.library_export_section_anilist();
    default: return m.library_archive_present_other_section();
  }
}
export function statusLabel(status: string): string {
  switch (status) {
    case 'unresolved': return m.library_archive_recovery_effect_unresolved();
    case 'unsupported': return m.library_archive_recovery_effect_unsupported();
    case 'create': return m.library_archive_present_create();
    case 'already_equal': return m.library_archive_present_equal();
    case 'current_conflict':
    case 'stale': return m.library_archive_recovery_conflict_title();
    case 'mapped': return m.library_archive_present_mapped();
    case 'preserved': return m.library_archive_present_preserved();
    case 'applying': return m.library_archive_recovery_applying();
    case 'acknowledged': return m.library_archive_present_acknowledged();
    case 'complete': return m.library_archive_recovery_complete_title();
    case 'failed': return m.library_archive_recovery_effect_failed();
    case 'cancelled': return m.library_archive_recovery_cancelled_help();
    case 'expired': return m.library_archive_entry_expired();
    case 'recoverable':
    case 'uncertain': return m.library_archive_recovery_uncertain();
    case 'cancelling': return m.library_archive_present_cancelling();
    case 'reviewed': return m.library_archive_present_mapped();
    default: return m.library_archive_present_unknown();
  }
}
export function recordTitle(row: ArchiveRow): string {
  const title = row.evidence.title ?? row.evidence.name ?? row.evidence.normalized_name;
  return typeof title === 'string' && title.length ? title : m.library_archive_present_title_unavailable();
}
function fieldLabel(field: string): string {
  switch (field) {
    case 'note': return m.library_archive_personal_note();
    case 'priority': return m.library_archive_personal_priority();
    case 'startDate': return m.library_archive_personal_start_date();
    case 'finishDate': return m.library_archive_personal_finish_date();
    case 'reflection': return m.library_archive_personal_reflection();
    case 'assessment': return m.library_occurrence_assessment();
    case 'privacy': return m.library_rich_entry_privacy();
    case 'sourceCreated': return m.library_rich_entry_source_created();
    case 'sourceUpdated': return m.library_rich_entry_source_updated();
    default: return m.library_archive_present_other_section();
  }
}
function fieldOperation(operation: string) {
  switch (operation) {
    case 'set': return m.library_archive_personal_set();
    case 'clear': return m.library_archive_personal_clear();
    default: return m.library_archive_entry_preserve();
  }
}
function valueText(value: unknown, field?: string): string {
  if (value === null || value === undefined) return m.library_progress_measure_absent();
  if (field === 'privacy' && value === 'private') return m.library_visibility_private();
  if (field === 'privacy' && value === 'public') return m.library_visibility_public();
  if (field === 'privacy' && value === 'unlisted') return m.library_visibility_unlisted();
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  // Native JSON fields can carry structured dates, assessments and observation facts.
  // Only supplied readable values lead; their complete representation remains in details.
  if (typeof value !== 'object') return m.library_rich_source_unknown();
  const fact = value as Record<string, unknown>;
  if (field === 'startDate' || field === 'finishDate') return formatJournalDate(value as ProgressSessionJournalDate);
  if (fact.status === 'cleared') return m.library_rich_source_cleared();
  if (fact.status === 'absent') return m.library_rich_source_not_supplied();
  if (fact.status === 'unknown') return typeof fact.sourceValue === 'string'
    ? m.library_rich_source_unknown_value({ value: fact.sourceValue }) : m.library_rich_source_unknown();
  if (field === 'privacy' && fact.status === 'known') return fact.meaning === 'private'
    ? m.library_rich_source_private() : m.library_rich_source_visible();
  if ('units' in fact) return valueText(fact.units);
  if ('value' in fact && (typeof fact.value === 'string' || typeof fact.value === 'number')) return valueText(fact.value, field);
  return m.library_rich_source_unknown();
}
function FieldFacts({ fields }: { fields: Record<string, unknown> }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {Object.entries(fields).map(([field, value]) => (
        <div key={field} className="min-w-0 space-y-1 rounded-md bg-muted/40 p-3">
          <dt className="font-medium">{fieldLabel(field)}</dt>
          <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{valueText(value, field)}</dd>
        </div>
      ))}
    </dl>
  );
}
const personalFields = ['note', 'priority', 'startDate', 'finishDate', 'reflection', 'assessment', 'privacy', 'sourceCreated', 'sourceUpdated'];
function suppliedFields(value: Record<string, unknown>) {
  return Object.fromEntries(personalFields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]));
}
export function ArchiveRecordSummary({ row }: { row: ArchiveRow }) {
  const source = (row.section === 'journals' ? row.evidence.journal
    : row.section === 'provenance' ? row.evidence.observation : row.evidence) as Record<string, unknown>;
  const facts = suppliedFields(source ?? {});
  return (
    <div className="space-y-3">
      {Object.keys(facts).length ? <FieldFacts fields={facts} /> : null}
      {!['entries', 'labels', 'assignments', 'annotations', 'journals', 'provenance'].includes(row.section)
        ? <p>{m.library_archive_entry_retained()}</p> : null}
      <EvidenceDetails value={{ ordinal: row.ordinal, section: row.section, evidence: row.evidence }} />
    </div>
  );
}
export function ArchiveChoiceSummary({ choice, row }: { choice: ArchiveReviewItem; row?: ArchiveRow }) {
  return (
    <div className="space-y-3">
      <p className="font-medium">{row ? recordTitle(row) : m.library_archive_present_title_unavailable()}</p>
      {choice.kind === 'entry' ? <>
        <p>{choice.action === 'create' ? m.library_archive_entry_create() : choice.action === 'update'
          ? m.library_archive_entry_update() : m.library_archive_entry_preserve()}</p>
        {choice.action === 'update' ? <p>{m.library_archive_present_replacement()}</p> : null}
      </> : choice.kind === 'label' ? (
        <p>{choice.target.mode === 'create' ? m.library_archive_entry_create_label() : m.library_archive_entry_existing_label()}</p>
      ) : choice.kind === 'assignment' ? (
        <p>{choice.action === 'assign' ? m.library_archive_entry_assign() : m.library_archive_entry_preserve()}</p>
      ) : <>
        {choice.kind === 'observation' ? <p>{choice.action === 'admit'
          ? m.library_archive_observation_admit() : m.library_archive_observation_correct()}</p> : null}
        <dl className="grid gap-2 sm:grid-cols-2">
          {Object.entries(choice.fields).map(([field, operation]) => (
            <div key={field} className="rounded-md border p-3">
              <dt className="font-medium">{fieldLabel(field)}</dt>
              <dd>{fieldOperation(operation ?? 'preserve')}</dd>
              {operation === 'clear' ? <dd className="text-sm">{m.library_archive_present_clear_warning()}</dd> : null}
            </div>
          ))}
        </dl>
      </>}
      <EvidenceDetails value={choice} title={m.library_archive_progress_exact()} />
    </div>
  );
}
export function ArchiveNativeReviewSummary({ row }: { row: ArchiveRow }) {
  const review = row.review;
  if (!review) return null;
  const current = review.current as Record<string, unknown> | null | undefined;
  return (
    <section className="space-y-3 rounded-md border p-3" aria-label={m.library_archive_entry_review()}>
      <p className="font-medium">{statusLabel(row.status)}</p>
      {typeof review.name === 'string' ? <p>{review.name}</p> : null}
      {row.status === 'current_conflict' ? <p>{m.library_archive_recovery_conflict_help()}</p> : null}
      {row.status === 'unresolved' ? <p>{m.library_archive_recovery_mapping_unresolved()}</p> : null}
      {row.status === 'unsupported' ? <p>{m.library_archive_entry_retained()}</p> : null}
      {current ? <>
        <h4 className="font-medium">{m.library_archive_entry_current()}</h4>
        {typeof current.state === 'string' ? <p>{row.section === 'journals'
          ? progressStateLabel(current.state) : m.library_archive_present_state_unavailable()}</p> : null}
        <FieldFacts fields={suppliedFields(current)} />
      </> : null}
      <EvidenceDetails value={{ ordinal: row.ordinal, reviewRevision: row.reviewRevision, status: row.status, review }} />
    </section>
  );
}
export function ArchiveCurrentFacts({ value }: { value: unknown }) {
  const envelope = value as Record<string, unknown> | null;
  const facts = (envelope?.libraryEntry ?? envelope?.label ?? envelope) as Record<string, unknown> | null;
  return (
    <section className="space-y-3 rounded-md border p-4">
      <h3 className="font-semibold">{m.library_archive_entry_current()}</h3>
      {facts ? <>
        {typeof facts.name === 'string' ? <p className="font-medium">{facts.name}</p> : null}
        {typeof facts.state === 'string' ? <p>{m.library_archive_present_state_unavailable()}</p> : null}
        <FieldFacts fields={suppliedFields(facts)} />
      </> : null}
      <p>{m.library_archive_present_current_help()}</p>
      <EvidenceDetails value={value} />
    </section>
  );
}
