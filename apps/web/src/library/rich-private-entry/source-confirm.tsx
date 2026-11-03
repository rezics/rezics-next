import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../../paraglide/messages.js';
import type { SourceAdmissionOutcome, SourceAdmissionPreview, SourcePrivacyField, SourceTimestampField } from './admission';

export function sourcePreviewFieldText(field: SourcePrivacyField | SourceTimestampField): string {
  if (field.kind === 'unsupported') return field.reason;
  const value = field.value;
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'unknown')
    return 'sourceValue' in value && value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  if ('meaning' in value)
    return value.meaning === 'private' ? m.library_rich_source_private() : m.library_rich_source_visible();
  if ('value' in value) return value.value;
  return m.library_rich_source_unknown();
}

export function sourceAdmissionText(outcome: SourceAdmissionOutcome): string {
  if (outcome.status === 'admitted') return m.library_import_source_admitted();
  if (outcome.status === 'conflict') return m.library_import_source_conflict();
  if (outcome.status === 'unsupported')
    return m.library_import_source_unsupported({ reason: outcome.reason ?? '' });
  return m.library_import_source_failed();
}

export function ImportSourceEvidence({ preview }: { preview: SourceAdmissionPreview }) {
  return (
    <dl className="mt-2 space-y-1 text-sm" data-import-source-record={preview.recordId}>
      <div>
        <dt className="font-medium">{m.library_rich_entry_provider()}</dt>
        <dd data-import-source-provider={preview.provider}>{preview.provider}</dd>
      </div>
      <div>
        <dt className="font-medium">{m.library_rich_entry_record()}</dt>
        <dd className="break-all">{preview.recordId}</dd>
      </div>
      <div>
        <dt className="font-medium">{m.library_rich_entry_privacy()}</dt>
        <dd>{sourcePreviewFieldText(preview.privacy)}</dd>
      </div>
      <div>
        <dt className="font-medium">{m.library_rich_entry_source_created()}</dt>
        <dd className="break-words">{sourcePreviewFieldText(preview.sourceCreated)}</dd>
      </div>
      <div>
        <dt className="font-medium">{m.library_rich_entry_source_updated()}</dt>
        <dd className="break-words">{sourcePreviewFieldText(preview.sourceUpdated)}</dd>
      </div>
    </dl>
  );
}

export function ImportSourceChecks({
  prefix,
  privacy,
  timestamps,
  disabled,
  onPrivacy,
  onTimestamps,
}: {
  prefix: string;
  privacy: boolean;
  timestamps: boolean;
  disabled?: boolean;
  onPrivacy: (checked: boolean) => void;
  onTimestamps: (checked: boolean) => void;
}) {
  const privacyId = `${prefix}-source-privacy`;
  const timestampsId = `${prefix}-source-timestamps`;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{m.library_import_source_help()}</p>
      <Field orientation="horizontal" className="min-w-0">
        <Checkbox
          id={privacyId}
          className="size-11 after:inset-0"
          checked={privacy}
          disabled={disabled}
          onCheckedChange={(value) => onPrivacy(value === true)}
        />
        <FieldLabel className="min-h-11 min-w-0 items-center whitespace-normal [overflow-wrap:anywhere]" htmlFor={privacyId}>
          {m.library_import_source_privacy_confirm()}
        </FieldLabel>
      </Field>
      <Field orientation="horizontal" className="min-w-0">
        <Checkbox
          id={timestampsId}
          className="size-11 after:inset-0"
          checked={timestamps}
          disabled={disabled}
          onCheckedChange={(value) => onTimestamps(value === true)}
        />
        <FieldLabel
          className="min-h-11 min-w-0 items-center whitespace-normal [overflow-wrap:anywhere]"
          htmlFor={timestampsId}
        >
          {m.library_import_source_timestamps_confirm()}
        </FieldLabel>
      </Field>
    </div>
  );
}

export function ImportSourceOutcome({ outcome }: { outcome: SourceAdmissionOutcome | null | undefined }) {
  if (!outcome) return null;
  return (
    <p className="text-sm" data-import-source-admission={outcome.status}>
      {sourceAdmissionText(outcome)}
    </p>
  );
}