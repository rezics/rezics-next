import type { FilterDocument } from '@rezics/filter';
import type { ConditionMetadata } from './condition-editor-model';

export type ConditionConceptScheme = Readonly<{ id: string; label?: string | undefined }>;

export type ConditionConceptReference =
  | Readonly<{
      status: 'ready';
      id: string;
      label?: string | undefined;
      schemes: readonly ConditionConceptScheme[];
    }>
  | Readonly<{ status: 'preparing' | 'restart' | 'unsupported' | 'unavailable' | 'refused'; id: string }>;

export type ConditionConceptLookup = Readonly<{
  enabled: boolean;
  filter?: string | undefined;
  releaseDigest?: string | undefined;
  key: string;
  lifetimeKey?: string | undefined;
  blocked?: 'scope' | 'private' | 'metadata' | undefined;
}>;

export type ConditionConceptChoice = Readonly<{ id: string; label: string }>;
export type ConditionConceptReferenceState = Readonly<{
  owner: string;
  value: ConditionConceptReference;
}>;

export function conditionTypeExtends(
  types: Readonly<Record<string, { bases?: readonly string[] | undefined }>>,
  type: string,
  base: string,
): boolean {
  const seen = new Set<string>();
  const visit = (candidate: string): boolean => {
    if (candidate === base) return true;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return (types[candidate]?.bases ?? []).some(visit);
  };
  return visit(type);
}

export function conditionConceptTypeIds(metadata: Pick<ConditionMetadata, 'types'>): string[] {
  return Object.keys(metadata.types).filter((type) => conditionTypeExtends(metadata.types, type, 'skos:Concept'));
}

export function conditionConceptProperty(
  definition: ConditionMetadata['properties'][string] | undefined,
): boolean {
  return (
    definition?.datatype === 'wikibase-item' &&
    definition.relation?.group === 'classification' &&
    definition.targets?.includes('skos:Concept') === true
  );
}

/** Search only released Concept types through Semantic's existing suggestions operation. */
export function conditionConceptSuggestionFilter(metadata: Pick<ConditionMetadata, 'types'>): string | undefined {
  const types = conditionConceptTypeIds(metadata);
  return types.length ? JSON.stringify({ type: { in: types } }) : undefined;
}

/** A Concept choice replaces the value list only after the visitor has selected its scheme and match mode. */
export function conditionConceptSelection(
  value: FilterDocument,
  concept: string,
  scheme: string,
  includeChildren: boolean,
): FilterDocument | undefined {
  if (!('statement' in value) || !('in' in value.statement) || !concept || !scheme) return;
  return {
    statement: {
      ...value.statement,
      in: [concept],
      concept: { scheme, includeChildren },
    },
  };
}

/** Never relabel a retained value from a response for a different identity. */
export function conditionConceptReferenceFor(
  requested: string,
  reference: ConditionConceptReference | undefined,
): ConditionConceptReference | undefined {
  return reference?.id === requested ? reference : undefined;
}

/** A matching Concept ID from a retired request still cannot supply this request's labels. */
export function conditionConceptReferenceForRequest(
  owner: string,
  requested: string,
  state: ConditionConceptReferenceState | undefined,
): ConditionConceptReference | undefined {
  if (!state || state.owner !== owner) return undefined;
  return conditionConceptReferenceFor(requested, state.value);
}

export function parseConditionConceptReference(input: unknown, requested: string): ConditionConceptReference {
  const unavailable: ConditionConceptReference = { status: 'unavailable', id: requested };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return unavailable;
  const value = input as Record<string, unknown>;
  if (value.id !== requested) return unavailable;
  if (
    value.status === 'preparing' ||
    value.status === 'restart' ||
    value.status === 'unsupported' ||
    value.status === 'unavailable' ||
    value.status === 'refused'
  )
    return { status: value.status, id: requested };
  if (value.status !== 'ready' || !Array.isArray(value.schemes)) return unavailable;
  const schemes: ConditionConceptScheme[] = [];
  const seen = new Set<string>();
  for (const entry of value.schemes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const scheme = entry as Record<string, unknown>;
    if (typeof scheme.id !== 'string' || !scheme.id || seen.has(scheme.id)) continue;
    if (scheme.label !== undefined && typeof scheme.label !== 'string') continue;
    seen.add(scheme.id);
    schemes.push({ id: scheme.id, ...(typeof scheme.label === 'string' && scheme.label ? { label: scheme.label } : {}) });
  }
  if (value.label !== undefined && typeof value.label !== 'string') return unavailable;
  return {
    status: 'ready',
    id: requested,
    ...(typeof value.label === 'string' && value.label ? { label: value.label } : {}),
    schemes,
  };
}
