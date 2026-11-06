import type { PageRead } from '@rezics/composition';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativeId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function nativeType(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function nativeLabels(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((label) => typeof label === 'string');
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nativeCover(value: unknown): boolean {
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

function nativeSummary(value: unknown, id: string, type?: string): boolean {
  return (
    isRecord(value) &&
    nativeId(value.id) &&
    value.id.toLowerCase() === id.toLowerCase() &&
    nativeType(value.type) &&
    (type === undefined || value.type === type) &&
    Array.isArray(value.types) &&
    value.types.every(nativeType) &&
    value.types.includes(value.type) &&
    (value.label === null ||
      (isRecord(value.label) && typeof value.label.value === 'string' && typeof value.label.language === 'string')) &&
    typeof value.creativeWork === 'boolean' &&
    (value.cover === null || nativeCover(value.cover))
  );
}

function plannedLimit(read: PageRead): number | undefined {
  const limit = read.kind === 'search' ? read.body.limit : read.kind === 'members' ? read.limit : undefined;
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? limit : undefined;
}

function nativeNext(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 4864);
}

export type ObservedSearchPage = {
  subjects: {
    id: string;
    type: string;
    labels: Record<string, string>;
    summary: unknown;
  }[];
  next: string | null;
};

export type ObservedMembersPage = {
  members: {
    kind: 'dynamic';
    subjectId: string;
    summary: unknown;
  }[];
  next: string | null;
};

/** Admit a Zone-composed TypeList page: unique canonical IDs, planned limit, opaque continuation. */
export function admitObservedSearchPage(read: PageRead, body: unknown): ObservedSearchPage | undefined {
  const limit = plannedLimit(read);
  if (
    read.kind !== 'search' ||
    limit === undefined ||
    !isRecord(body) ||
    !Array.isArray(body.subjects) ||
    !nativeNext(body.next)
  )
    return;
  if (body.subjects.length > limit) return;
  const seen = new Set<string>();
  const subjects: ObservedSearchPage['subjects'] = [];
  for (const row of body.subjects) {
    if (
      !isRecord(row) ||
      !nativeId(row.id) ||
      seen.has(row.id.toLowerCase()) ||
      !nativeType(row.type) ||
      !nativeLabels(row.labels) ||
      !Object.hasOwn(row, 'summary') ||
      !(row.summary === null || nativeSummary(row.summary, row.id, row.type)) ||
      Object.keys(row).some((key) => key === 'ownerId' || key === 'mounts' || key === 'sources')
    )
      return;
    seen.add(row.id.toLowerCase());
    subjects.push({ id: row.id, type: row.type, labels: row.labels, summary: row.summary });
  }
  return { subjects, next: body.next };
}

/** Admit a Zone-composed Members page: unique canonical IDs, planned limit, opaque continuation. */
export function admitObservedMembersPage(read: PageRead, body: unknown): ObservedMembersPage | undefined {
  const limit = plannedLimit(read);
  if (
    read.kind !== 'members' ||
    limit === undefined ||
    !isRecord(body) ||
    !Array.isArray(body.members) ||
    !nativeNext(body.next)
  )
    return;
  if (body.members.length > limit) return;
  const seen = new Set<string>();
  const members: ObservedMembersPage['members'] = [];
  for (const row of body.members) {
    if (
      !isRecord(row) ||
      !nativeId(row.subjectId) ||
      seen.has(row.subjectId.toLowerCase()) ||
      (row.kind !== undefined && row.kind !== 'dynamic') ||
      !Object.hasOwn(row, 'summary') ||
      !(row.summary === null || nativeSummary(row.summary, row.subjectId)) ||
      Object.keys(row).some((key) => key === 'ownerId' || key === 'mounts' || key === 'sources')
    )
      return;
    seen.add(row.subjectId.toLowerCase());
    members.push({ kind: 'dynamic', subjectId: row.subjectId, summary: row.summary });
  }
  return { members, next: body.next };
}

/** Deduplicate overlapping/alias rows by canonical ID while keeping the first native occurrence. */
export function uniqueCanonicalRows<Row extends { id?: string; subjectId?: string }>(rows: readonly Row[]): Row[] {
  const seen = new Set<string>();
  const unique: Row[] = [];
  for (const row of rows) {
    const id = (typeof row.id === 'string' ? row.id : row.subjectId)?.toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(row);
  }
  return unique;
}
