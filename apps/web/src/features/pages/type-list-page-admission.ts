import type { SubjectSummary } from '../../media/summary';
import { isRecord } from './shared';

export type NativeTypeListPage = {
  subjects: { id: string; type: string; labels: Record<string, string>; summary: SubjectSummary }[];
  next: string | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nativeType(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function nativeId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nativeLabels(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((label) => typeof label === 'string');
}

function nativeCover(value: unknown): value is NonNullable<Exclude<SubjectSummary, null>['cover']> {
  if (
    !isRecord(value) ||
    !nativeId(value.media) ||
    !positiveInteger(value.width) ||
    !positiveInteger(value.height) ||
    !isRecord(value.placeholder) ||
    typeof value.placeholder.thumbhash !== 'string' ||
    typeof value.placeholder.color !== 'string' ||
    !Array.isArray(value.variants) ||
    !value.variants.every(
      (variant) =>
        isRecord(variant) && (variant.format === 'avif' || variant.format === 'webp') && positiveInteger(variant.width),
    ) ||
    !(
      value.focalPoint === null ||
      (isRecord(value.focalPoint) &&
        typeof value.focalPoint.x === 'number' &&
        Number.isFinite(value.focalPoint.x) &&
        typeof value.focalPoint.y === 'number' &&
        Number.isFinite(value.focalPoint.y))
    ) ||
    !isRecord(value.credit) ||
    typeof value.credit.rightsHolder !== 'string' ||
    !isRecord(value.credit.via) ||
    typeof value.credit.via.name !== 'string' ||
    typeof value.credit.via.url !== 'string' ||
    typeof value.credit.license !== 'string' ||
    !Array.isArray(value.credit.obligations) ||
    !value.credit.obligations.every((obligation) => typeof obligation === 'string')
  )
    return false;
  return true;
}

function nativeSummary(value: unknown, id: string, type: string): value is Exclude<SubjectSummary, null> {
  return (
    isRecord(value) &&
    nativeId(value.id) &&
    value.id.toLowerCase() === id.toLowerCase() &&
    nativeType(value.type) &&
    value.type === type &&
    Array.isArray(value.types) &&
    value.types.every(nativeType) &&
    value.types.includes(type) &&
    (value.label === null ||
      (isRecord(value.label) && typeof value.label.value === 'string' && typeof value.label.language === 'string')) &&
    typeof value.creativeWork === 'boolean' &&
    (value.cover === null || nativeCover(value.cover))
  );
}

function plannedSearchLimit(read: unknown): number | undefined {
  if (!isRecord(read) || read.kind !== 'search' || !isRecord(read.body) || !positiveInteger(read.body.limit))
    return undefined;
  return read.body.limit;
}

/** Admit a native TypeList page only when it is a search read at or under its planned limit. */
export function nativeTypeListPage(read: unknown, body: unknown): NativeTypeListPage | undefined {
  const limit = plannedSearchLimit(read);
  if (
    limit === undefined ||
    !isRecord(body) ||
    !Array.isArray(body.subjects) ||
    body.subjects.length > limit ||
    !(body.next === null || (typeof body.next === 'string' && body.next.trim().length > 0))
  )
    return undefined;

  const seen = new Set<string>();
  const subjects: NativeTypeListPage['subjects'] = [];
  for (const row of body.subjects) {
    if (
      !isRecord(row) ||
      !nativeId(row.id) ||
      seen.has(row.id.toLowerCase()) ||
      !nativeType(row.type) ||
      !nativeLabels(row.labels) ||
      !Object.hasOwn(row, 'summary') ||
      !(row.summary === null || nativeSummary(row.summary, row.id, row.type))
    )
      return undefined;
    seen.add(row.id.toLowerCase());
    subjects.push({ id: row.id, type: row.type, labels: row.labels, summary: row.summary });
  }
  return { subjects, next: body.next };
}
