import type { FilterRelease } from '@rezics/filter';
import type { KindCountEvidence } from './discovery-api.ts';
import { typeFacetLabels } from './facets.ts';

export { typeFacetLabels };

export type TypeFacetSubject = Readonly<{ id: string; type: string }>;
export type TypeFacetDirectoryEntry = Readonly<{
  kind: string;
  metadata: { id: string; labels: Record<string, string>; icon: string };
}>;
export type TypeFacetPropertyValue = Readonly<{
  value: string;
  labels?: Record<string, string>;
  count?: number;
}>;
export type TypeFacetPropertyPage = Readonly<{
  property: string;
  values: readonly TypeFacetPropertyValue[];
  total?: number;
}>;

/**
 * Kind chips are the designated-leaf exception: counts come from current disclosed rows that already
 * satisfied the remaining predicate. Missing kinds stay unavailable; a zero lower bound is never inferred.
 */
export function proveCurrentKindCounts(input: {
  subjects: readonly TypeFacetSubject[];
  directory: readonly string[];
  complete: boolean;
}): ReadonlyMap<string, KindCountEvidence> {
  const distinct = new Map<string, Set<string>>();
  for (const subject of input.subjects) {
    if (!subject.id || !subject.type) continue;
    const ids = distinct.get(subject.type) ?? new Set<string>();
    ids.add(subject.id);
    distinct.set(subject.type, ids);
  }
  const counts = new Map<string, KindCountEvidence>();
  for (const kind of input.directory) {
    const size = distinct.get(kind)?.size ?? 0;
    if (size > 0) {
      counts.set(kind, { kind, value: size, exact: input.complete });
      continue;
    }
    counts.set(kind, { kind, unavailable: true });
  }
  return counts;
}

/** Attach certified kind evidence to the configured directory page. Missing kinds stay unavailable. */
export function attachKindCountMetadata<Entry extends TypeFacetDirectoryEntry>(
  entries: readonly Entry[],
  counts: ReadonlyMap<string, KindCountEvidence>,
): Array<Entry['metadata'] & { count: KindCountEvidence }> {
  return entries.map((entry) => {
    const evidence = counts.get(entry.kind) ?? { kind: entry.kind, unavailable: true as const };
    if ('value' in evidence && evidence.value === 0)
      return { ...entry.metadata, count: { kind: entry.kind, unavailable: true as const } };
    return { ...entry.metadata, count: evidence };
  });
}

/** Type labels belong to the released definition owner; Search never substitutes a fixture map. */
export function nativeTypeFacetLabels(
  release: FilterRelease,
  type: string,
  languages?: readonly string[],
): Record<string, string> {
  const labels = typeFacetLabels(release, type) ?? {};
  if (!languages?.length) return { ...labels };
  for (const language of languages) if (labels[language]) return { [language]: labels[language]! };
  const first = Object.entries(labels)[0];
  return first ? { [first[0]]: first[1] } : {};
}

/** Configured kind directory in owner order, labelled from the active release. */
export function nativeKindDirectory(
  release: FilterRelease,
  kinds: readonly string[],
  languages?: readonly string[],
  icons: Readonly<Record<string, string>> = {},
): TypeFacetDirectoryEntry[] {
  return kinds.map((kind) => ({
    kind,
    metadata: {
      id: kind,
      labels: nativeTypeFacetLabels(release, kind, languages),
      icon: icons[kind] ?? 'catalogue',
    },
  }));
}

export function presentKindChips(
  release: FilterRelease,
  kinds: readonly string[],
  counts: ReadonlyMap<string, KindCountEvidence>,
  languages?: readonly string[],
  icons: Readonly<Record<string, string>> = {},
): Array<TypeFacetDirectoryEntry['metadata'] & { count: KindCountEvidence }> {
  return attachKindCountMetadata(nativeKindDirectory(release, kinds, languages, icons), counts);
}

export function kindChipLabel(
  metadata: { id: string; labels: Record<string, string>; count?: KindCountEvidence },
  locale: string,
): string {
  const label = metadata.labels[locale] ?? Object.values(metadata.labels)[0] ?? metadata.id;
  const count = metadata.count;
  if (!count || !('value' in count)) return label;
  return `${label} (${count.value}${count.exact ? '' : '+'})`;
}

/** Ordinary property facets stay count-free; kind chips are the only count exception. */
export function countFreeFacetValues<Value extends { count?: unknown }>(
  values: readonly Value[],
): Array<Omit<Value, 'count'>> {
  return values.map((value) => {
    const { count: _count, ...rest } = value;
    return rest;
  });
}

export function countFreePropertyFacets(
  pages: readonly TypeFacetPropertyPage[],
): Array<Omit<TypeFacetPropertyPage, 'total' | 'values'> & { values: Array<Omit<TypeFacetPropertyValue, 'count'>> }> {
  return pages.map((page) => ({
    property: page.property,
    values: countFreeFacetValues(page.values),
  }));
}

export function omitPublicSearchTotal<Page extends { total?: unknown }>(page: Page): Omit<Page, 'total'> {
  const { total: _total, ...rest } = page;
  return rest;
}

export function kindCountIsUnavailable(evidence: KindCountEvidence | undefined): boolean {
  return !evidence || 'unavailable' in evidence || ('value' in evidence && evidence.value === 0);
}
