import {
  absentPrivacy,
  absentTimestamp,
  booleanPrivacy,
  sourceAdmissionBody,
  sourceAdmissionBlock,
  timestampFromText,
  timestampFromUnix,
  unknownPrivacy,
  unsupportedField,
  type SourceAdmissionPreview,
} from '../rich-private-entry/admission';
import type { AniListRecord, AniListRow } from './contract';

function has(record: AniListRecord, field: string): boolean {
  return Object.hasOwn(record, field);
}

function anilistPrivacy(evidence: AniListRecord): SourceAdmissionPreview['privacy'] {
  if (!has(evidence, 'private')) return absentPrivacy();
  const value = evidence.private;
  if (typeof value === 'boolean') return booleanPrivacy(value);
  if (value === null) return unknownPrivacy();
  if (typeof value === 'string') return unknownPrivacy(value);
  return unsupportedField('AniList private must be a retained boolean.');
}

function anilistTimestamp(
  evidence: AniListRecord,
  field: 'createdAt' | 'updatedAt',
): SourceAdmissionPreview['sourceCreated'] {
  if (!has(evidence, field)) return absentTimestamp();
  const value = evidence[field];
  if (value === null) return { kind: 'ready', value: { status: 'unknown' } };
  if (typeof value === 'number') return timestampFromUnix(value);
  if (typeof value === 'string') return timestampFromText(value, 'unknown');
  return unsupportedField('The retained timestamp cannot keep its original precision.');
}

function recordIdOf(row: AniListRow): string {
  const evidence = row.source.evidence;
  if (typeof evidence.id === 'number' && Number.isSafeInteger(evidence.id) && evidence.id > 0)
    return String(evidence.id);
  return row.source.identifiers.find((item) => item.source === 'anilist')?.externalId ?? '';
}

export function aniListSourcePreview(row: AniListRow): SourceAdmissionPreview {
  const evidence = row.source.evidence;
  return {
    provider: 'anilist',
    recordId: recordIdOf(row),
    privacy: anilistPrivacy(evidence),
    sourceCreated: anilistTimestamp(evidence, 'createdAt'),
    sourceUpdated: anilistTimestamp(evidence, 'updatedAt'),
  };
}

export function aniListSourceAdmission(row: AniListRow) {
  const preview = aniListSourcePreview(row);
  return { preview, body: sourceAdmissionBody(preview), blocked: sourceAdmissionBlock(preview) };
}
