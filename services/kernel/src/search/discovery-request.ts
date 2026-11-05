import {
  admitDiscoveryFilter,
  FilterError,
  parseDiscoveryFilter,
  positiveDiscoveryFilter,
  type DiscoveryFilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import type { CollectionDiscoveryQuery } from '../library/collection-discovery-source.ts';
import { ProblemError } from '../http/problem.ts';
import { routeOf } from '../route/route.ts';
import { LIST_CURSOR_BOUNDS } from '../tokens/list-cursor.ts';
import type { CollectionDirectorySelection, DiscoveryOwnerRegistry, DiscoveryRegistry } from './discovery.ts';
import type { DiscoveryRequest } from './discovery-api.ts';
import { discoveryKindDirectory } from './discovery-registry.ts';
import { admitProperties, validateHitOptions, validateSearchLimit } from './hits.ts';
import { parseText, positiveText, textSyntaxProblem, TextSyntaxError } from './text.ts';

export type MixedDiscoveryRequest = DiscoveryRequest & {
  kindPage?: { limit: number; cursor?: string };
  kindCountLeaf?: number;
};

const OWNED_FIELDS = [
  'text',
  'filter',
  'sort',
  'limit',
  'cursor',
  'kindCursor',
  'descriptions',
  'languages',
  'properties',
  'kindPage',
  'kindCountLeaf',
  'spaceId',
  'collectionDirectory',
] as const satisfies readonly (keyof MixedDiscoveryRequest)[];

/** Translate the admitted directory selection into the existing native owner's operands. */
export function collectionDiscoveryQuery(selection: CollectionDirectorySelection): CollectionDiscoveryQuery {
  return {
    ...(selection.presentationKind === undefined
      ? {}
      : {
          presentationKind:
            selection.presentationKind === 'mixed'
              ? { kind: 'mixed' as const }
              : { kind: 'owner' as const, id: selection.presentationKind },
        }),
    ...(selection.curator === undefined ? {} : { curatorAccountId: selection.curator }),
    ...(selection.subject === undefined ? {} : { subjectId: selection.subject }),
    popularity: selection.order === 'popular',
    order: selection.order === 'popular' ? 'popularity' : 'recency',
  };
}

function collectionDirectorySelection(value: unknown): CollectionDirectorySelection {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['presentationKind', 'curator', 'subject', 'order'].includes(key))
  )
    return invalid('/collectionDirectory');
  const selection = value as Record<string, unknown>;
  if (
    selection.presentationKind !== undefined &&
    (typeof selection.presentationKind !== 'string' ||
      !selection.presentationKind.length ||
      selection.presentationKind.length > 256 ||
      !selection.presentationKind.isWellFormed())
  )
    return invalid('/collectionDirectory/presentationKind');
  for (const field of ['curator', 'subject'] as const) {
    const identity = selection[field];
    if (
      identity !== undefined &&
      (typeof identity !== 'string' || identity !== identity.toLowerCase() || routeOf(identity) === null)
    )
      return invalid(`/collectionDirectory/${field}`);
  }
  if (selection.order !== 'recent' && selection.order !== 'popular') return invalid('/collectionDirectory/order');
  return {
    ...(selection.presentationKind === undefined ? {} : { presentationKind: selection.presentationKind as string }),
    ...(selection.curator === undefined ? {} : { curator: selection.curator as string }),
    ...(selection.subject === undefined ? {} : { subject: selection.subject as string }),
    order: selection.order,
  };
}

function onlyCollectionKind(filter: DiscoveryFilterDocument | undefined): boolean {
  if (!filter || !('and' in filter) || filter.and.length !== 1) return false;
  const leaf = filter.and[0];
  return !!leaf && 'kind' in leaf && leaf.kind.in.length === 1 && leaf.kind.in[0] === 'collection';
}

/** Maximum engine rows admitted across one mixed Search page and its useful-page refills. */
export function discoveryCandidateScanBound(limit: number): number {
  return Math.min(600, 6 * limit + 3);
}

function invalid(pointer: string): never {
  throw new ProblemError('invalid_request', { errors: [{ pointer, code: 'invalid_format' }] });
}
function unsupported(pointer: string): never {
  throw new ProblemError('unsupported_query', { errors: [{ pointer, code: 'unsupported' }] });
}

/** Copy bounded caller fields before the first await. Omitted keys stay omitted. */
export function ownDiscoveryRequest(request: MixedDiscoveryRequest): MixedDiscoveryRequest {
  const owned: Record<string, unknown> = { representation: request.representation };
  for (const key of OWNED_FIELDS) {
    if (!Object.hasOwn(request, key)) continue;
    const value = request[key];
    owned[key] = Array.isArray(value)
      ? [...value]
      : value !== null && typeof value === 'object'
        ? structuredClone(value)
        : value;
  }
  if (owned.languages === undefined) owned.languages = ['en'];
  return owned as MixedDiscoveryRequest;
}

/** Admission precedes any native enumeration. Saved/private domains remain closed here. */
export function admitDiscoveryRequest(
  request: MixedDiscoveryRequest,
  registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>,
  release: FilterRelease,
) {
  if (request.representation !== 'discovery-v1') invalid('/representation');
  if (request.kindCursor !== undefined) invalid('/kindCursor');
  if (request.spaceId !== undefined && (typeof request.spaceId !== 'string' || routeOf(request.spaceId) === null))
    invalid('/spaceId');
  for (const [pointer, token] of [
    ['/cursor', request.cursor],
    ['/kindPage/cursor', request.kindPage?.cursor],
  ] as const)
    if (token !== undefined && (typeof token !== 'string' || token.length > LIST_CURSOR_BOUNDS.search.maxTokenLength))
      invalid(pointer);
  const options = validateHitOptions(request);
  if (options.properties) admitProperties(options.properties, release);
  if (
    request.kindPage !== undefined &&
    (typeof request.kindPage !== 'object' ||
      request.kindPage === null ||
      Array.isArray(request.kindPage) ||
      Object.keys(request.kindPage).some((key) => key !== 'limit' && key !== 'cursor'))
  )
    invalid('/kindPage');
  const kindLimit = request.kindPage === undefined ? 8 : request.kindPage.limit;
  if (!Number.isInteger(kindLimit) || kindLimit < 1 || kindLimit > 8) invalid('/kindPage/limit');

  let text;
  let filter: DiscoveryFilterDocument | undefined;
  try {
    if (request.text !== undefined) {
      if (typeof request.text !== 'string') invalid('/text');
      text = parseText(request.text);
    }
    if (request.filter !== undefined)
      filter = admitDiscoveryFilter(
        parseDiscoveryFilter(request.filter),
        release,
        new Set(discoveryKindDirectory(registry).map((entry) => entry.kind)),
        { inverse: true },
      );
  } catch (error) {
    if (error instanceof TextSyntaxError) throw new ProblemError('unsupported_query', textSyntaxProblem(error));
    if (error instanceof FilterError)
      throw new ProblemError(error.problem, {
        errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
      });
    throw error;
  }
  const collectionDirectory =
    request.collectionDirectory === undefined ? undefined : collectionDirectorySelection(request.collectionDirectory);
  if (
    collectionDirectory &&
    (text !== undefined ||
      request.sort !== undefined ||
      request.spaceId !== undefined ||
      request.kindPage !== undefined ||
      request.kindCountLeaf !== undefined ||
      !onlyCollectionKind(filter))
  )
    unsupported('/collectionDirectory');
  const sort = request.sort ?? (text ? 'relevance' : 'name');
  if (sort !== 'id' && sort !== 'name' && sort !== 'relevance') unsupported('/sort');
  if (sort === 'relevance' && !text) unsupported('/sort');
  if ((text || filter) && !(text && positiveText(text)) && !(filter && positiveDiscoveryFilter(filter)))
    unsupported(text ? '/text' : '/filter');
  const limit = validateSearchLimit(request.limit);
  let countFilter = filter;
  if (request.kindCountLeaf !== undefined) {
    const index = request.kindCountLeaf;
    if (!Number.isInteger(index) || index < 0 || !filter || !('and' in filter)) invalid('/kindCountLeaf');
    const selected = filter.and[index];
    if (!selected || !('kind' in selected)) invalid('/kindCountLeaf');
    const children = filter.and.filter((_, position) => position !== index);
    countFilter = children.length === 0 ? undefined : children.length === 1 ? children[0] : { and: children };
  }
  // Bind the original admitted tree, text, language order and metadata options. Dynamic release/physical
  // identity belongs in the authenticated payload so changes restart instead of becoming a static MAC error.
  const bindingRequest = {
    representation: 'discovery-v1',
    text: request.text ?? null,
    filter: filter ?? null,
    sort,
    limit,
    languages: options.languages ? [...options.languages] : [],
    descriptions: options.descriptions,
    properties: options.properties ? [...options.properties] : [],
    kindLimit,
    kindCountLeaf: request.kindCountLeaf ?? null,
    spaceId: request.spaceId ?? null,
    ...(collectionDirectory ? { collectionDirectory } : {}),
  };
  return {
    text,
    filter,
    countFilter,
    sort,
    limit,
    kindLimit,
    kindCountLeaf: request.kindCountLeaf,
    options,
    languages: options.languages ?? [],
    ...(collectionDirectory ? { collectionDirectory } : {}),
    bindingRequest,
  };
}

/** Classify the opt-in grammar at the existing gate; the legacy parser must never see kind.in. */
export function requiresAdvancedDiscoverySearch(request: MixedDiscoveryRequest): boolean {
  try {
    const text = request.text === undefined ? undefined : parseText(request.text);
    const filter = request.filter === undefined ? undefined : parseDiscoveryFilter(request.filter);
    const basicText = (node: NonNullable<typeof text>): boolean =>
      node.kind === 'term' ||
      node.kind === 'phrase' ||
      ((node.kind === 'and' || node.kind === 'or') && node.children.every(basicText));
    const basicFilter = (node: DiscoveryFilterDocument): boolean =>
      'kind' in node ||
      'type' in node ||
      ('and' in node && node.and.every(basicFilter)) ||
      ('or' in node && node.or.every(basicFilter));
    return (
      (text !== undefined && !basicText(text)) ||
      (filter !== undefined && !basicFilter(filter)) ||
      request.sort === 'rating' ||
      request.sort === 'collections'
    );
  } catch (error) {
    if (error instanceof TextSyntaxError) throw new ProblemError('unsupported_query', textSyntaxProblem(error));
    if (error instanceof FilterError)
      throw new ProblemError(error.problem, {
        errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
      });
    throw error;
  }
}
