import {
  absentPrivacy,
  absentTimestamp,
  privacyFromToken,
  sourceAdmissionBody,
  sourceAdmissionBlock,
  timestampFromText,
  unsupportedField,
  type SourceAdmissionPreview,
} from '../rich-private-entry/admission';
import type { MalPreviewRow, MalValue } from './contract';

function textOf(value: MalValue | undefined): string | undefined {
  if (!value || value.kind === 'missing') return undefined;
  if (typeof value.value === 'string' || typeof value.value === 'number') return String(value.value);
  if (typeof value.raw === 'string') return value.raw;
  return undefined;
}

function malPrivacy(row: MalPreviewRow): SourceAdmissionPreview['privacy'] {
  const raw = row.fields.my_privacy ?? textOf(row.privacy);
  if (raw === undefined) return absentPrivacy();
  if (raw === '') return unsupportedField('The retained privacy token cannot fit native evidence.');
  return privacyFromToken(raw);
}

function malUpdated(row: MalPreviewRow): SourceAdmissionPreview['sourceUpdated'] {
  const fieldKeys = Object.keys(row.fields).filter((field) => /updated|timestamp|last_updated/i.test(field));
  const stampKeys = Object.keys(row.timestamps).filter((field) => /updated|timestamp|last_updated/i.test(field));
  const keys = fieldKeys.length ? fieldKeys : stampKeys;
  if (keys.length === 0) return absentTimestamp();
  if (keys.length !== 1)
    return unsupportedField('MAL retains multiple update-time fields; their source meanings are not interchangeable.');
  const field = keys[0]!;
  const raw = fieldKeys.length ? row.fields[field]! : textOf(row.timestamps[field]);
  if (raw === undefined) return absentTimestamp();
  return timestampFromText(raw, 'parse');
}

export function malSourcePreview(row: MalPreviewRow): SourceAdmissionPreview {
  return {
    provider: 'mal',
    recordId: `${row.kind}/${row.identifier.value}`,
    privacy: malPrivacy(row),
    sourceCreated: absentTimestamp(),
    sourceUpdated: malUpdated(row),
  };
}

export function malSourceAdmission(row: MalPreviewRow) {
  const preview = malSourcePreview(row);
  return { preview, body: sourceAdmissionBody(preview), blocked: sourceAdmissionBlock(preview) };
}
