import type { ImportSourceRecord, ImportSourceRecordMetadataResult } from './import-contract.ts';

/** Closed wire validation; callers snapshot data descriptors before invoking this. */
export function isImportSourceRecord(value: unknown): value is ImportSourceRecord {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const scalar = (v: unknown, max: number): v is string =>
    typeof v === 'string' &&
    v.length <= max &&
    v.trim().length > 0 &&
    v.isWellFormed() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
  const url = (v: unknown) => {
    if (!scalar(v, 2048) || /\s/u.test(v)) return false;
    try {
      const parsed = new URL(v);
      return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  };
  if (
    !object(value) ||
    Object.keys(value).some((k) => !['name', 'url', 'licence', 'attribution'].includes(k)) ||
    !scalar(value.name, 255) ||
    !url(value.url)
  )
    return false;
  if (Object.hasOwn(value, 'attribution') && !scalar(value.attribution, 500)) return false;
  if (Object.hasOwn(value, 'licence')) {
    if (
      !object(value.licence) ||
      !scalar(value.licence.id, 128) ||
      Object.keys(value.licence).some((k) => !['id', 'url'].includes(k)) ||
      (Object.hasOwn(value.licence, 'url') && !url(value.licence.url))
    )
      return false;
  }
  return true;
}

export function isImportSourceRecordMetadataResult(value: unknown): value is ImportSourceRecordMetadataResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).sort().join(',') === 'effect,metadata_revision,record' &&
    isImportSourceRecord(result.record) &&
    Number.isSafeInteger(result.metadata_revision) &&
    Number(result.metadata_revision) > 0 &&
    ['filled', 'corrected', 'noEffect'].includes(String(result.effect))
  );
}
