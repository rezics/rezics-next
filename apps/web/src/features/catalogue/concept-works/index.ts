import { FILTER_LIMITS, parseFilter, type FilterDocument, type FilterQualifier } from '@rezics/filter';
import { conditionTreeAdmission } from '../../../search/condition-editor-model';
import { discoveryRequest } from '../../../search/search-request';
import type { SearchLoaderDeps } from '../../../search/search-params';
import { readDiscovery, type DiscoverySender } from '../../../search/discovery';
import type { ConceptWorksAdmission, ConceptSchemeRef } from '../source-concept-explorer';
import { isExploreId } from '../../pages/graph-browser';
import type { DiscoveryRequest, DiscoveryState } from '../../../search/discovery';

export const conceptWorksLimit = 24;
export const conceptWorksRequestByteLimit = 65_536;
export const conceptWorksPageByteLimit = 65_536;

export type ConceptWorksSelection = {
  conceptId: string;
  property?: string;
  scheme?: string;
  type?: string;
  includeChildren?: boolean;
  spoilerThreshold?: 0 | 1 | 2;
  qualifiers?: readonly FilterQualifier[];
  condition?: FilterDocument;
  cursor?: string;
};

function leafCount(filter: FilterDocument): number {
  if ('and' in filter) return filter.and.reduce((sum, child) => sum + leafCount(child), 0);
  if ('or' in filter) return filter.or.reduce((sum, child) => sum + leafCount(child), 0);
  if ('not' in filter) return leafCount(filter.not);
  if ('statement' in filter) return 1;
  return 1;
}

/** Keep the concept leaf fixed while admitting the complete composed tree through Search's released grammar. */
export function conceptWorksRequest(
  selection: ConceptWorksSelection,
  admission: ConceptWorksAdmission | undefined,
  schemes: readonly ConceptSchemeRef[],
  locale: string,
): DiscoveryRequest | undefined {
  if (
    admission?.state !== 'available' ||
    !isExploreId(selection.conceptId) ||
    !selection.property ||
    selection.property.length > 128 ||
    !selection.scheme ||
    !isExploreId(selection.scheme) ||
    (selection.cursor !== undefined && new TextEncoder().encode(selection.cursor).byteLength > 4096)
  )
    return;

  const property = admission.properties.find((candidate) => candidate.id === selection.property);
  const scheme = schemes.find((candidate) => candidate.id === selection.scheme);
  if (!property || !scheme?.readable || !scheme.conceptPage) return;
  const types = selection.type ? [selection.type] : property.types;
  if (!types.length || types.length > FILTER_LIMITS.in || types.some((type) => !property.types.includes(type))) return;

  const fixed: FilterDocument[] = [
    { type: { in: types } },
    {
      statement: {
        property: property.id,
        in: [selection.conceptId],
        concept: {
          scheme: scheme.id,
          ...(selection.includeChildren ? { includeChildren: true } : {}),
        },
        ...(selection.qualifiers?.length ? { qualifiers: selection.qualifiers } : {}),
      },
    },
  ];
  if (selection.condition) fixed.push(selection.condition);
  const condition: FilterDocument = fixed.length === 1 ? fixed[0]! : { and: fixed };
  if (
    leafCount(condition) + 1 > FILTER_LIMITS.leaves ||
    !conditionTreeAdmission(admission.metadata)(condition)
  )
    return;

  const state: SearchLoaderDeps = {
    query: '',
    type: undefined,
    facets: {},
    condition,
    cursor: selection.cursor,
    sort: undefined,
    kinds: ['subject'],
    languages: [locale],
  };
  try {
    const request = {
      ...discoveryRequest(state, [locale]),
      limit: conceptWorksLimit,
      spoilerThreshold: selection.spoilerThreshold ?? 0,
    };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > conceptWorksRequestByteLimit) return;
    return request;
  } catch {
    return;
  }
}

/** Search's decoder already rejects malformed rows; this caps the composed page before it is retained. */
export function boundedConceptWorksState(state: DiscoveryState): DiscoveryState {
  if (state.status !== 'ready') return state;
  if (state.page.hits.length > conceptWorksLimit) return { status: 'unavailable' };
  try {
    return new TextEncoder().encode(JSON.stringify(state)).byteLength <= conceptWorksPageByteLimit
      ? state
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

export function conceptWorksExactEmpty(state: DiscoveryState): boolean {
  return (
    state.status === 'ready' &&
    state.page.hits.length === 0 &&
    state.page.next === null &&
    state.page.freshness.state === 'current'
  );
}

function boundedFixedConceptRequest(request: DiscoveryRequest): boolean {
  const filter = request.filter as unknown;
  if (!isRecord(filter) || !Array.isArray(filter.and) || filter.and.length !== 2) return false;
  const [condition, kind] = filter.and;
  if (
    !isRecord(kind) ||
    Object.keys(kind).length !== 1 ||
    !isRecord(kind.kind) ||
    !Array.isArray(kind.kind.in) ||
    kind.kind.in.length !== 1 ||
    kind.kind.in[0] !== 'subject' ||
    !isRecord(condition) ||
    !Array.isArray(condition.and) ||
    condition.and.length < 2
  )
    return false;
  const [type, fixedConcept] = condition.and;
  if (
    !isRecord(type) ||
    Object.keys(type).length !== 1 ||
    !isRecord(type.type) ||
    !Array.isArray(type.type.in) ||
    type.type.in.length === 0 ||
    !isRecord(fixedConcept) ||
    Object.keys(fixedConcept).length !== 1 ||
    !isRecord(fixedConcept.statement) ||
    typeof fixedConcept.statement.property !== 'string' ||
    !Array.isArray(fixedConcept.statement.in) ||
    fixedConcept.statement.in.length !== 1 ||
    !isRecord(fixedConcept.statement.concept) ||
    typeof fixedConcept.statement.concept.scheme !== 'string'
  )
    return false;
  try {
    const parsed = parseFilter(condition);
    return leafCount(parsed) + 1 <= FILTER_LIMITS.leaves;
  } catch {
    return false;
  }
}

export function publicConceptWorksState(state: DiscoveryState): DiscoveryState {
  if (state.status !== 'ready') return state;
  const { spaceEntries: _spaceEntries, ...page } = state.page;
  return {
    ...state,
    page: {
      ...page,
      viewerFacts: null,
      collectionFollows: { state: 'unavailable', reason: 'identity' },
    },
  };
}

/** Use the installed Search decoder and its one bounded cursor restart; never reinterpret refusal as empty. */
export async function readConceptWorksPage(
  request: DiscoveryRequest,
  send: DiscoverySender,
): Promise<DiscoveryState> {
  if (
    request.representation !== 'discovery-v1' ||
    request.limit !== conceptWorksLimit ||
    request.text !== undefined ||
    request.properties !== undefined ||
    request.sort !== undefined ||
    !boundedFixedConceptRequest(request) ||
    new TextEncoder().encode(JSON.stringify(request)).byteLength > conceptWorksRequestByteLimit
  )
    return { status: 'invalid' };
  try {
    const result = await readDiscovery(request, send);
    return boundedConceptWorksState(result.restarted ? { status: 'restart' } : result.discovery);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { status: 'unavailable' };
  }
}
