import type { SubjectSummary } from '../../media/summary';
import { isRecord } from './shared';
import { catalogueRowContext, type CatalogueRowContext } from './catalogue-list-context/model';

export type NativeTypeListPage = {
  subjects: {
    id: string;
    type: string;
    labels: Record<string, string>;
    summary: SubjectSummary;
    catalogue: CatalogueRowContext;
  }[];
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

function configuredTypes(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || !value.every(nativeType)) return undefined;
  const unique = new Set(value);
  return unique.size === value.length ? value : undefined;
}

function plannedTypes(filter: unknown): string[] | undefined {
  if (!isRecord(filter)) return undefined;
  // TypeList planning places its configured restriction first, then intersects any authored public filter.
  const first = Array.isArray(filter.and) ? filter.and[0] : filter;
  if (!isRecord(first) || !isRecord(first.type)) return undefined;
  return configuredTypes(first.type.in);
}

function sameTypes(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.length === right.length && left.every((type) => rightSet.has(type));
}

function plannedSearch(read: unknown, configuration: Record<string, unknown>) {
  if (!isRecord(read) || read.kind !== 'search' || !isRecord(read.body)) return;
  const types = configuredTypes(configuration.types);
  const selectedTypes = plannedTypes(read.body.filter);
  const sort = configuration.sort;
  const limit = configuration.limit;
  const paged = configuration.paged;
  if (
    !types ||
    !selectedTypes ||
    !sameTypes(types, selectedTypes) ||
    (sort !== 'name' && sort !== 'collections') ||
    (paged !== undefined && typeof paged !== 'boolean') ||
    !positiveInteger(limit) ||
    limit > 24
  )
    return;
  const expectedLimit = paged === true ? Math.min(12, limit) : limit;
  if (read.body.sort !== sort || read.body.limit !== expectedLimit) return;
  return { limit: expectedLimit, types: new Set(types) };
}

/** Admit a complete native Search page only when its descriptor and every row match this TypeList. */
export function nativeTypeListPage(
  read: unknown,
  body: unknown,
  configuration: Record<string, unknown>,
): NativeTypeListPage | undefined {
  const plan = plannedSearch(read, configuration);
  if (!plan) return undefined;
  const limit = plan.limit;
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
      !nativeType(row.type) ||
      !plan.types.has(row.type) ||
      !nativeLabels(row.labels) ||
      !Object.hasOwn(row, 'summary') ||
      !(row.summary === null || nativeSummary(row.summary, row.id, row.type))
    )
      return undefined;
    const identity = row.id.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    subjects.push({
      id: row.id,
      type: row.type,
      labels: row.labels,
      summary: row.summary,
      catalogue: catalogueRowContext({
        id: row.id,
        facts: row.facts,
        listPresentation: row.listPresentation,
        catalogueContext: row.catalogueContext,
      }),
    });
  }
  return { subjects, next: body.next };
}
