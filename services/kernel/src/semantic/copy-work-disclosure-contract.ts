import type { Release } from '@rezics/definitions';

/** Raw identities, including duplicates, before any source deduplication. */
export const COPY_WORK_DISCLOSURE_MAX_RAW = 100;
/** Disclosed canonical works per source; a fourth current member is overflow. */
export const COPY_WORK_DISCLOSURE_MAX_WORKS = 3;
/** Current-head locators per source: three disclosed members plus one lookahead. */
export const COPY_WORK_DISCLOSURE_LOOKAHEAD = COPY_WORK_DISCLOSURE_MAX_WORKS + 1;
/** Released copy/release-to-work property. Same UUID, digest or label is never membership. */
export const COPY_WORK_PROPERTY = 'schema:exampleOfWork';

export type CopyWorkAdmission = 'admitted' | 'scope' | 'unsupported';

function isType(release: Pick<Release, 'types'>, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

/** One released policy shared by the native prefilter and Semantic result classification. */
export function admittedCopyWork(
  release: Release,
  type: string,
  isRelationProperty: (release: Release, property: string) => boolean,
): CopyWorkAdmission {
  const definition = release.types[type];
  if (!definition || !definition.properties.includes(COPY_WORK_PROPERTY)) return 'scope';
  const property = release.properties[COPY_WORK_PROPERTY];
  if (
    !property ||
    property.datatype !== 'wikibase-item' ||
    !isRelationProperty(release, COPY_WORK_PROPERTY) ||
    property.relation?.group !== 'derivation' ||
    !(property.targets ?? []).some(
      (target) => isType(release, 'schema:CreativeWork', target) || isType(release, target, 'schema:CreativeWork'),
    )
  )
    return 'unsupported';
  return 'admitted';
}

export type CopyWorkDisclosureRequest = Readonly<{
  identities: readonly string[];
  languages?: readonly string[];
}>;

/** Selected labels only; never every stored language or a locally truncated string. */
export type CopyWorkReference = Readonly<{
  id: string;
  labels: Readonly<Record<string, string>>;
}>;

export type CopyWorkDisclosureState =
  | Readonly<{ state: 'available'; works: readonly CopyWorkReference[] }>
  | Readonly<{ state: 'scope' }>
  | Readonly<{ state: 'withheld' }>
  | Readonly<{ state: 'missing' }>
  | Readonly<{ state: 'unsupported' }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{ state: 'denied' }>;

/** One original-keyed batch. `current` re-observes native homes; it is not a future-commit lock. */
export type CopyWorkDisclosureObservation = Readonly<{
  results: ReadonlyMap<string, CopyWorkDisclosureState>;
  current: () => Promise<boolean>;
}>;
