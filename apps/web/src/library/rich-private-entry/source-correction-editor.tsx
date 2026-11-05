import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import type {
  PersonalEntryObservation,
  PersonalEntryPrivacyValue,
  PersonalEntrySourceCorrection,
  PersonalEntryTimestampInput,
} from '@rezics/client';
import {
  buildSourceCorrection,
  inspectSourceTimestamp,
  sourceCorrectionDraftOf,
  sourceCorrectionHasChanges,
  type CorrectionOperation,
  type PrivacyChoice,
  type PrivacyCorrectionDraft,
  type SourceCorrectionDraft,
  type SourceCorrectionIssue,
  type TimestampShape,
  type TimestampChoice,
  type TimestampCorrectionDraft,
} from './source-correction';

export type SourceCorrectionNotice =
  | 'saved'
  | 'conflict'
  | 'uncertain'
  | 'denied'
  | 'missing'
  | 'retired'
  | 'signed-out'
  | 'unavailable';

type SourceCorrectionEditorProps = {
  baseline: PersonalEntryObservation;
  current: PersonalEntryObservation | null;
  notice: SourceCorrectionNotice | null;
  conflictRevision: number | null;
  pending: boolean;
  savedBody: PersonalEntrySourceCorrection | null;
  savedObservation: PersonalEntryObservation | null;
  disabled: boolean;
  onSubmit: (body: PersonalEntrySourceCorrection) => void;
  onRetry: () => void;
  onRefresh: () => void;
  onReviewLatest: () => void;
  onCancel: () => void;
  onEdit: () => void;
};

function privacyFactText(value: PersonalEntryObservation['privacy']) {
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'cleared') return m.library_rich_source_cleared();
  if (value.status === 'unknown')
    return value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  return value.meaning === 'private' ? m.library_rich_source_private() : m.library_rich_source_visible();
}

function precisionLabel(value: TimestampShape['precision']) {
  if (value === 'year') return m.library_rich_entry_precision_year();
  if (value === 'month') return m.library_rich_entry_precision_month();
  if (value === 'day') return m.library_rich_entry_precision_day();
  if (value === 'minute') return m.library_rich_entry_precision_minute();
  if (value === 'second') return m.library_rich_entry_precision_second();
  return m.library_rich_entry_precision_fraction();
}

function zoneLabel(value: string) {
  if (value === 'utc') return m.library_rich_entry_zone_utc();
  if (value === 'offset') return m.library_rich_entry_zone_offset();
  return m.library_rich_entry_zone_unknown();
}

function timestampFactText(value: PersonalEntryObservation['sourceCreated']) {
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'cleared') return m.library_rich_source_cleared();
  if (value.status === 'unknown')
    return value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  return m.library_rich_source_timestamp({
    value: value.value,
    precision: precisionLabel(value.precision),
    zone: zoneLabel(value.zone),
  });
}

function timestampInputText(value: PersonalEntryTimestampInput) {
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'unknown')
    return value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  const shape = inspectSourceTimestamp(value.value);
  if (typeof shape === 'string') return value.value;
  return m.library_rich_source_timestamp({
    value: value.value,
    precision: precisionLabel(shape.precision),
    zone: zoneLabel(shape.zone),
  });
}

function privacyInputText(value: PersonalEntryPrivacyValue) {
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'unknown')
    return value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  return value.meaning === 'private' ? m.library_rich_source_private() : m.library_rich_source_visible();
}

function issueText(issue: SourceCorrectionIssue | undefined) {
  if (!issue) return null;
  if (issue === 'malformed') return m.library_rich_entry_timestamp_malformed();
  if (issue === 'unsupported-calendar') return m.library_rich_entry_timestamp_calendar_unsupported();
  if (issue === 'invalid-calendar-date') return m.library_rich_entry_timestamp_calendar_invalid();
  if (issue === 'invalid-time') return m.library_rich_entry_timestamp_time_invalid();
  if (issue === 'invalid-offset') return m.library_rich_entry_timestamp_offset_invalid();
  if (issue === 'native-limit') return m.library_rich_entry_timestamp_native_limit();
  if (issue === 'privacy-invalid') return m.library_rich_entry_privacy_value_invalid();
  if (issue === 'privacy-limit') return m.library_rich_entry_privacy_native_limit();
  return m.library_rich_entry_privacy_value_invalid();
}

function privacyAfter(field: PrivacyCorrectionDraft, before: PersonalEntryObservation['privacy']) {
  if (field.operation === 'preserve') return privacyFactText(before);
  if (field.operation === 'clear') return m.library_rich_source_cleared();
  if (field.choice === 'absent') return m.library_rich_source_not_supplied();
  if (field.choice === 'unknown')
    return field.sourceValue
      ? m.library_rich_source_unknown_value({ value: field.sourceValue })
      : m.library_rich_source_unknown();
  return field.choice === 'private' ? m.library_rich_source_private() : m.library_rich_source_visible();
}

function timestampAfter(field: TimestampCorrectionDraft, before: PersonalEntryObservation['sourceCreated']) {
  if (field.operation === 'preserve') return timestampFactText(before);
  if (field.operation === 'clear') return m.library_rich_source_cleared();
  if (field.choice === 'absent') return m.library_rich_source_not_supplied();
  if (field.choice === 'unknown')
    return field.sourceValue
      ? m.library_rich_source_unknown_value({ value: field.sourceValue })
      : m.library_rich_source_unknown();
  return timestampInputText({ status: 'known', value: field.value });
}

function valueForPrivacy(field: PrivacyCorrectionDraft): string {
  if (field.choice === 'private') return 'private';
  if (field.choice === 'source_visible') return 'source_visible';
  return field.choice;
}

function valueForTimestamp(field: TimestampCorrectionDraft): string {
  return field.choice;
}

function correctionRows(body: PersonalEntrySourceCorrection, current: PersonalEntryObservation | null) {
  return (['privacy', 'sourceCreated', 'sourceUpdated'] as const).map((field) => {
    const now =
      current && field === 'privacy'
        ? privacyFactText(current.privacy)
        : current && field === 'sourceCreated'
          ? timestampFactText(current.sourceCreated)
          : current && field === 'sourceUpdated'
            ? timestampFactText(current.sourceUpdated)
            : m.library_rich_entry_source_record_missing();
    return { field, value: now };
  });
}

function FieldStatus({ title, before, after }: { title: string; before: string; after: string }) {
  return (
    <div className="grid gap-1 rounded-md border p-3 sm:grid-cols-[8rem_1fr_1fr] sm:items-start">
      <dt className="font-medium">{title}</dt>
      <dd>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {m.library_rich_entry_before()}
        </span>
        <span className="break-words">{before}</span>
      </dd>
      <dd>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {m.library_rich_entry_after()}
        </span>
        <span className="break-words">{after}</span>
      </dd>
    </div>
  );
}

function ModeSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: CorrectionOperation;
  disabled: boolean;
  onChange: (value: CorrectionOperation) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <select
        className="min-h-11 w-full rounded-md border bg-background px-3"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value as CorrectionOperation)}
      >
        <option value="preserve">{m.library_rich_entry_preserve()}</option>
        <option value="clear">{m.library_rich_entry_clear_fact()}</option>
        <option value="set">{m.library_rich_entry_set_fact()}</option>
      </select>
    </label>
  );
}

function PrivacyCorrectionField({
  draft,
  before,
  disabled,
  issue,
  onChange,
}: {
  draft: PrivacyCorrectionDraft;
  before: PersonalEntryObservation['privacy'];
  disabled: boolean;
  issue: SourceCorrectionIssue | undefined;
  onChange: (draft: PrivacyCorrectionDraft) => void;
}) {
  const errorId = 'source-correction-privacy-error';
  return (
    <fieldset className="space-y-3 rounded-md border p-3" aria-describedby={issue ? errorId : undefined}>
      <legend className="px-1 font-semibold">{m.library_rich_entry_privacy()}</legend>
      <p className="text-sm text-muted-foreground">{m.library_rich_entry_privacy_correction_help()}</p>
      <p className="text-sm">
        <span className="font-medium">{m.library_rich_entry_current_value()}</span> {privacyFactText(before)}
      </p>
      <ModeSelect
        label={m.library_rich_entry_field_action()}
        value={draft.operation}
        disabled={disabled}
        onChange={(operation) => onChange({ ...draft, operation })}
      />
      {draft.operation === 'set' ? (
        <>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{m.library_rich_entry_value_kind()}</span>
            <select
              className="min-h-11 w-full rounded-md border bg-background px-3"
              value={valueForPrivacy(draft)}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...draft, choice: event.currentTarget.value as PrivacyChoice, sourceValue: '' })
              }
            >
              <option value="private">{m.library_rich_source_private()}</option>
              <option value="source_visible">{m.library_rich_source_visible()}</option>
              <option value="unknown">{m.library_rich_source_unknown()}</option>
              <option value="absent">{m.library_rich_source_not_supplied()}</option>
            </select>
          </label>
          {draft.choice === 'unknown' ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{m.library_rich_entry_raw_privacy_value()}</span>
              <input
                className="min-h-11 w-full rounded-md border bg-background px-3"
                type="text"
                maxLength={192}
                value={draft.sourceValue}
                disabled={disabled}
                aria-describedby={issue ? errorId : undefined}
                onChange={(event) => onChange({ ...draft, sourceValue: event.currentTarget.value })}
              />
              <span className="mt-1 block text-sm text-muted-foreground">
                {m.library_rich_entry_privacy_value_help()}
              </span>
            </label>
          ) : null}
        </>
      ) : null}
      {issue ? (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {issueText(issue)}
        </p>
      ) : null}
    </fieldset>
  );
}

function TimestampCorrectionField({
  name,
  draft,
  before,
  disabled,
  issue,
  onChange,
}: {
  name: 'sourceCreated' | 'sourceUpdated';
  draft: TimestampCorrectionDraft;
  before: PersonalEntryObservation['sourceCreated'];
  disabled: boolean;
  issue: SourceCorrectionIssue | undefined;
  onChange: (draft: TimestampCorrectionDraft) => void;
}) {
  const created = name === 'sourceCreated';
  const title = created ? m.library_rich_entry_source_created() : m.library_rich_entry_source_updated();
  const errorId = `source-correction-${name}-error`;
  const valueId = `source-correction-${name}-value`;
  return (
    <fieldset className="space-y-3 rounded-md border p-3" aria-describedby={issue ? errorId : undefined}>
      <legend className="px-1 font-semibold">{title}</legend>
      <p className="text-sm text-muted-foreground">{m.library_rich_entry_timestamp_correction_help()}</p>
      <p className="text-sm">
        <span className="font-medium">{m.library_rich_entry_current_value()}</span> {timestampFactText(before)}
      </p>
      <ModeSelect
        label={m.library_rich_entry_field_action()}
        value={draft.operation}
        disabled={disabled}
        onChange={(operation) => onChange({ ...draft, operation })}
      />
      {draft.operation === 'set' ? (
        <>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{m.library_rich_entry_value_kind()}</span>
            <select
              className="min-h-11 w-full rounded-md border bg-background px-3"
              value={valueForTimestamp(draft)}
              disabled={disabled}
              onChange={(event) => {
                const choice = event.currentTarget.value as TimestampChoice;
                onChange({
                  ...draft,
                  choice,
                  value: choice === 'known' ? draft.value : '',
                  sourceValue: choice === 'unknown' ? draft.sourceValue : '',
                });
              }}
            >
              <option value="known">{m.library_rich_entry_known_timestamp()}</option>
              <option value="unknown">{m.library_rich_entry_unknown_timestamp()}</option>
              <option value="absent">{m.library_rich_source_not_supplied()}</option>
            </select>
          </label>
          {draft.choice === 'known' ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{m.library_rich_entry_timestamp_text()}</span>
              <input
                id={valueId}
                className="min-h-11 w-full rounded-md border bg-background px-3 font-mono"
                type="text"
                inputMode="text"
                autoComplete="off"
                maxLength={64}
                placeholder={m.library_rich_entry_timestamp_input_placeholder()}
                value={draft.value}
                disabled={disabled}
                aria-describedby={`${name}-help${issue ? ` ${errorId}` : ''}`}
                onChange={(event) => onChange({ ...draft, value: event.currentTarget.value })}
              />
              <span id={`${name}-help`} className="mt-1 block text-sm text-muted-foreground">
                {m.library_rich_entry_timestamp_input_help()} {m.library_rich_entry_timestamp_is_source_evidence()}
              </span>
            </label>
          ) : null}
          {draft.choice === 'unknown' ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{m.library_rich_entry_raw_timestamp_value()}</span>
              <input
                className="min-h-11 w-full rounded-md border bg-background px-3 font-mono"
                type="text"
                inputMode="text"
                autoComplete="off"
                maxLength={64}
                value={draft.sourceValue}
                disabled={disabled}
                aria-describedby={`${name}-help${issue ? ` ${errorId}` : ''}`}
                onChange={(event) => onChange({ ...draft, sourceValue: event.currentTarget.value })}
              />
              <span id={`${name}-help`} className="mt-1 block text-sm text-muted-foreground">
                {m.library_rich_entry_raw_timestamp_help()}
              </span>
            </label>
          ) : null}
        </>
      ) : null}
      {issue ? (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {issueText(issue)}
        </p>
      ) : null}
    </fieldset>
  );
}

function CurrentFacts({ observation }: { observation: PersonalEntryObservation | null }) {
  if (!observation) return <p>{m.library_rich_entry_source_record_missing()}</p>;
  return (
    <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-3">
      <p className="font-medium">{m.library_rich_entry_current_source_revision({ revision: observation.revision })}</p>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-sm font-medium">{m.library_rich_entry_privacy()}</dt>
          <dd className="break-words">{privacyFactText(observation.privacy)}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium">{m.library_rich_entry_source_created()}</dt>
          <dd className="break-words">{timestampFactText(observation.sourceCreated)}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium">{m.library_rich_entry_source_updated()}</dt>
          <dd className="break-words">{timestampFactText(observation.sourceUpdated)}</dd>
        </div>
      </dl>
    </div>
  );
}

function SavedResult({
  body,
  observation,
  current,
}: {
  body: PersonalEntrySourceCorrection;
  observation: PersonalEntryObservation | null;
  current: PersonalEntryObservation | null;
}) {
  const labels: Record<'privacy' | 'sourceCreated' | 'sourceUpdated', string> = {
    privacy: m.library_rich_entry_privacy(),
    sourceCreated: m.library_rich_entry_source_created(),
    sourceUpdated: m.library_rich_entry_source_updated(),
  };
  const rows = correctionRows(body, observation ?? current);
  return (
    <section
      className="space-y-2 rounded-md border border-green-600/40 bg-green-600/5 p-3"
      role="status"
      aria-live="polite"
    >
      <h4 className="font-semibold" tabIndex={-1}>
        {m.library_rich_entry_source_saved({ revision: observation?.revision ?? body.revision })}
      </h4>
      <ul className="space-y-2">
        {rows.map(({ field, value }) => (
          <li key={field} className="grid gap-1 sm:grid-cols-[8rem_1fr]">
            <span className="font-medium">{labels[field]}</span>
            <span className="break-words">
              {body[field].op === 'unchanged'
                ? m.library_rich_entry_source_preserved({ value })
                : m.library_rich_entry_source_field_saved({ value })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SourceCorrectionEditor({
  baseline,
  current,
  notice,
  conflictRevision,
  pending,
  savedBody,
  savedObservation,
  disabled,
  onSubmit,
  onRetry,
  onRefresh,
  onReviewLatest,
  onCancel,
  onEdit,
}: SourceCorrectionEditorProps) {
  const [draft, setDraft] = useState<SourceCorrectionDraft>(() => sourceCorrectionDraftOf(baseline));
  const [reviewed, setReviewed] = useState(false);
  const baselineIdentity = `${baseline.provider}\u0000${baseline.recordId}\u0000${baseline.revision}`;
  useEffect(() => {
    setReviewed(false);
  }, [baselineIdentity]);

  const built = useMemo(() => buildSourceCorrection(baseline, draft), [baseline, draft]);
  const issues = built.kind === 'invalid' ? built.issues : {};
  const hasChanges = sourceCorrectionHasChanges(draft);
  const basisIsCurrent =
    current !== null && current.provider === baseline.provider && current.recordId === baseline.recordId;
  const revisionIsCurrent = basisIsCurrent && current.revision === baseline.revision;
  const editingLocked =
    disabled || pending || notice === 'saved' || notice === 'conflict' || notice === 'retired' || notice === 'missing';
  const valid = built.kind === 'ready' && revisionIsCurrent;
  const canSubmit = valid && reviewed && hasChanges && !editingLocked;

  function changed(next: SourceCorrectionDraft) {
    setDraft(next);
    setReviewed(false);
    onEdit();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || built.kind !== 'ready') return;
    onSubmit(built.body);
  }

  const privacyAfterValue = privacyAfter(draft.privacy, baseline.privacy);
  const createdAfterValue = timestampAfter(draft.sourceCreated, baseline.sourceCreated);
  const updatedAfterValue = timestampAfter(draft.sourceUpdated, baseline.sourceUpdated);

  return (
    <form className="mt-3 space-y-4 border-t pt-4" onSubmit={submit}>
      <header className="space-y-1">
        <h4 className="font-semibold">{m.library_rich_entry_source_correction_heading()}</h4>
        <p className="text-sm text-muted-foreground">{m.library_rich_entry_source_correction_help()}</p>
        <p className="text-sm">
          {m.library_rich_entry_review_binding({
            provider: baseline.provider,
            recordId: baseline.recordId,
            revision: baseline.revision,
          })}
        </p>
      </header>

      {notice === 'saved' && savedBody ? (
        <SavedResult body={savedBody} observation={savedObservation} current={current} />
      ) : null}
      {notice === 'denied' ? <p role="status">{m.library_rich_entry_source_refused()}</p> : null}
      {notice === 'missing' ? <p role="status">{m.library_rich_entry_source_record_missing()}</p> : null}
      {notice === 'retired' ? <p role="status">{m.library_rich_entry_source_retired()}</p> : null}
      {notice === 'signed-out' ? <p role="status">{m.library_rich_entry_signed_out()}</p> : null}
      {notice === 'unavailable' ? <p role="status">{m.library_rich_entry_source_unavailable()}</p> : null}
      {notice === 'uncertain' ? (
        <div className="space-y-2 rounded-md border border-amber-500/50 p-3" role="status">
          <p>{m.library_rich_entry_source_unknown_outcome()}</p>
          {pending ? (
            <button type="button" className="min-h-11 rounded-md border px-3" disabled={disabled} onClick={onRetry}>
              {m.library_rich_entry_source_retry_original()}
            </button>
          ) : null}
        </div>
      ) : null}
      {notice === 'conflict' ? (
        <section className="space-y-3 rounded-md border border-amber-500/50 p-3" role="status" aria-live="polite">
          <p>{m.library_rich_entry_source_conflict()}</p>
          <div>
            <h5 className="mb-2 font-medium">{m.library_rich_entry_current_facts()}</h5>
            <CurrentFacts observation={current} />
          </div>
          {current && current.revision !== conflictRevision ? (
            <button type="button" className="min-h-11 rounded-md border px-3" onClick={onReviewLatest}>
              {m.library_rich_entry_review_latest()}
            </button>
          ) : (
            <button type="button" className="min-h-11 rounded-md border px-3" onClick={onRefresh}>
              {m.library_selection_retry()}
            </button>
          )}
        </section>
      ) : null}

      {!revisionIsCurrent && notice !== 'conflict' && notice !== 'saved' && !pending ? (
        <section className="space-y-3 rounded-md border border-amber-500/50 p-3" role="status" aria-live="polite">
          <p>{m.library_rich_entry_source_revision_changed()}</p>
          <CurrentFacts observation={current} />
          {current && basisIsCurrent ? (
            <button type="button" className="min-h-11 rounded-md border px-3" onClick={onReviewLatest}>
              {m.library_rich_entry_review_latest()}
            </button>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-3">
        <PrivacyCorrectionField
          draft={draft.privacy}
          before={baseline.privacy}
          disabled={editingLocked}
          issue={issues.privacy}
          onChange={(privacy) => changed({ ...draft, privacy })}
        />
        <TimestampCorrectionField
          name="sourceCreated"
          draft={draft.sourceCreated}
          before={baseline.sourceCreated}
          disabled={editingLocked}
          issue={issues.sourceCreated}
          onChange={(sourceCreated) => changed({ ...draft, sourceCreated })}
        />
        <TimestampCorrectionField
          name="sourceUpdated"
          draft={draft.sourceUpdated}
          before={baseline.sourceUpdated}
          disabled={editingLocked}
          issue={issues.sourceUpdated}
          onChange={(sourceUpdated) => changed({ ...draft, sourceUpdated })}
        />
      </div>

      <section
        className="space-y-3 rounded-md border bg-muted/20 p-3"
        aria-label={m.library_rich_entry_review_change()}
      >
        <div>
          <h5 className="font-semibold">{m.library_rich_entry_review_change()}</h5>
          <p className="text-sm text-muted-foreground">{m.library_rich_entry_review_required()}</p>
        </div>
        <dl className="grid gap-2">
          <FieldStatus
            title={m.library_rich_entry_privacy()}
            before={privacyFactText(baseline.privacy)}
            after={privacyAfterValue}
          />
          <FieldStatus
            title={m.library_rich_entry_source_created()}
            before={timestampFactText(baseline.sourceCreated)}
            after={createdAfterValue}
          />
          <FieldStatus
            title={m.library_rich_entry_source_updated()}
            before={timestampFactText(baseline.sourceUpdated)}
            after={updatedAfterValue}
          />
        </dl>
        {!hasChanges ? (
          <p className="text-sm text-destructive" role="alert">
            {m.library_rich_entry_source_no_changes()}
          </p>
        ) : null}
        <label className="flex min-h-11 items-start gap-2">
          <input
            className="mt-1"
            type="checkbox"
            checked={reviewed}
            disabled={editingLocked || !valid || !hasChanges}
            onChange={(event) => setReviewed(event.currentTarget.checked)}
          />
          <span>{m.library_rich_entry_confirm_source()}</span>
        </label>
      </section>

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
          disabled={!canSubmit}
        >
          {m.library_rich_entry_save_source_correction()}
        </button>
        <button type="button" className="min-h-11 rounded-md border px-3" onClick={onCancel}>
          {m.library_rich_entry_cancel()}
        </button>
      </div>
    </form>
  );
}
