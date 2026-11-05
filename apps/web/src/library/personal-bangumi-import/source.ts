import {
  absentPrivacy,
  absentTimestamp,
  booleanPrivacy,
  sourceAdmissionBody,
  sourceAdmissionBlock,
  timestampFromText,
  unknownPrivacy,
  unsupportedField,
  type SourceAdmissionPreview,
} from '../rich-private-entry/admission';
import type { BangumiRecord, BangumiRow } from './contract';

function has(record: BangumiRecord, field: string): boolean {
  return Object.hasOwn(record, field);
}

function bangumiPrivacy(source: BangumiRecord): SourceAdmissionPreview['privacy'] {
  if (!has(source, 'private')) return absentPrivacy();
  const value = source.private;
  if (typeof value === 'boolean') return booleanPrivacy(value);
  if (value === null) return unknownPrivacy();
  if (typeof value === 'string') return unknownPrivacy(value);
  if (typeof value === 'number' && Number.isFinite(value)) return unknownPrivacy(String(value));
  return unsupportedField('The retained private value cannot fit the native provenance evidence bound.');
}

function bangumiTimestamp(
  source: BangumiRecord,
  field: 'created_at' | 'updated_at',
): SourceAdmissionPreview['sourceCreated'] {
  if (!has(source, field)) return absentTimestamp();
  const raw = source[field];
  if (typeof raw !== 'string') return unsupportedField('The retained timestamp is not text.');
  return timestampFromText(raw, 'parse');
}

function recordIdOf(source: BangumiRecord): string {
  return typeof source.subject_id === 'number' && Number.isSafeInteger(source.subject_id) && source.subject_id > 0
    ? String(source.subject_id)
    : typeof source.subject_id === 'string'
      ? source.subject_id
      : '';
}

export function bangumiSourcePreview(row: BangumiRow): SourceAdmissionPreview {
  const source = row.evidence.source;
  return {
    provider: 'bangumi',
    recordId: recordIdOf(source),
    privacy: bangumiPrivacy(source),
    sourceCreated: bangumiTimestamp(source, 'created_at'),
    sourceUpdated: bangumiTimestamp(source, 'updated_at'),
  };
}

export function bangumiSourceAdmission(row: BangumiRow) {
  const preview = bangumiSourcePreview(row);
  return { preview, body: sourceAdmissionBody(preview), blocked: sourceAdmissionBlock(preview) };
}
