import {
  admitDiscoveryFilter,
  FilterError,
  parseDiscoveryFilter,
  positiveDiscoveryFilter,
  type DiscoveryFilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import { LIST_CURSOR_BOUNDS } from '../tokens/list-cursor.ts';
import type { DiscoveryRegistry, DiscoveryRequest } from './discovery.ts';
import { admitProperties, validateHitOptions, validateSearchLimit } from './hits.ts';
import { parseText, positiveText, TextSyntaxError } from './text.ts';

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
] as const satisfies readonly (keyof MixedDiscoveryRequest)[];

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
  return owned as MixedDiscoveryRequest;
}

/** Admission precedes any native enumeration. Saved/private domains remain closed here. */
export function admitDiscoveryRequest(
  request: MixedDiscoveryRequest,
  registry: DiscoveryRegistry,
  release: FilterRelease,
) {
  if (request.representation !== 'discovery-v1') invalid('/representation');
  if (request.kindCursor !== undefined) invalid('/kindCursor');
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
        new Set(registry.entries.map((entry) => entry.kind)),
      );
  } catch (error) {
    if (error instanceof TextSyntaxError) unsupported('/text');
    if (error instanceof FilterError)
      throw new ProblemError(error.problem, {
        errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
      });
    throw error;
  }
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
  };
  return {
    text,
    filter,
    countFilter,
    sort,
    limit,
    kindLimit,
    options,
    languages: options.languages ?? [],
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
    if (error instanceof TextSyntaxError) unsupported('/text');
    if (error instanceof FilterError)
      throw new ProblemError(error.problem, {
        errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
      });
    throw error;
  }
}
