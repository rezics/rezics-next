import { parseDiscoveryFilter, parseFilter } from '@rezics/filter';
import { parseText } from './text.ts';

export const QUERY_SHARE_LIMITS = Object.freeze({ documentBytes: 16384, urlBytes: 8192, labels: 128, labelBytes: 256 });
export type QueryShare = {
  viewer: 'anonymous' | 'signed-in';
  action: 'allowed' | 'disabled' | 'unavailable';
  reason: 'ready' | 'private_context' | 'unsupported' | 'oversized' | 'unavailable';
  document: {
    text: string;
    filter: string | null;
    languages: string[];
    sort: string | null;
    textField?: 'credited_creator';
    creditQualifiers?: { property: string; value: string }[];
    spoilerThreshold?: number;
  } | null;
  parameters: string | null;
  selections: { value: string; language: string }[];
};
const bytes = (value: string) => new TextEncoder().encode(value).length;
export function unavailableQueryShare(
  reason: QueryShare['reason'],
  action: QueryShare['action'] = 'disabled',
): QueryShare {
  return { viewer: 'anonymous', action, reason, document: null, parameters: null, selections: [] };
}

/** Called only after ordinary native execution admits this exact request. No principal or continuation is copied. */
export function prepareQueryShare(
  request: {
    text?: string;
    filter?: unknown;
    languages?: string[];
    sort?: string;
    population?: unknown;
    spaceId?: string;
    work?: string;
    spoilerThreshold?: number;
    representation?: string;
    textField?: 'credited_creator';
    creditQualifiers?: { property: string; value: string }[];
  },
  labels: Record<string, Record<string, string>> = {},
): QueryShare {
  if (
    request.population !== undefined ||
    request.spaceId !== undefined ||
    request.work !== undefined ||
    (request.spoilerThreshold !== undefined && request.textField !== 'credited_creator') ||
    request.representation === 'release-groups-v1'
  )
    return unavailableQueryShare('private_context');
  const raw = JSON.stringify(request.filter ?? null);
  if (bytes(raw) > QUERY_SHARE_LIMITS.documentBytes) return unavailableQueryShare('oversized');
  let filter;
  try {
    if (request.text !== undefined && request.text !== '') parseText(request.text);
    filter = request.filter === undefined ? undefined : parseDiscoveryFilter(request.filter);
  } catch {
    return unavailableQueryShare('unsupported');
  }
  const selections: QueryShare['selections'] = [];
  let privateContext = false;
  const visit = (node: unknown) => {
    if (typeof node === 'string' && labels[node]) {
      const available = labels[node]!;
      const language = request.languages?.find((tag) => available[tag]) ?? Object.keys(available)[0];
      if (language && bytes(available[language]!) <= QUERY_SHARE_LIMITS.labelBytes)
        selections.push({ value: available[language]!, language });
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      // Resource scope portability needs a public owner projection. Never infer it from the current reader's grant.
      if (['owner', 'library', 'collection', 'zone', 'realm', 'saved'].includes(key)) privateContext = true;
      visit(value);
    }
  };
  visit(filter);
  if (privateContext) return unavailableQueryShare('private_context');
  // The receiver adds an outer conjunction. Remove only redundant single-child roots for stable replay.
  while (filter && 'and' in filter && filter.and.length === 1) filter = filter.and[0];
  const document: NonNullable<QueryShare['document']> = {
    text: request.text ?? '',
    filter: filter === undefined ? null : JSON.stringify(filter),
    languages: request.languages ?? ['en'],
    sort: request.sort ?? null,
    ...(request.textField === undefined ? {} : { textField: request.textField }),
    ...(request.textField === undefined ? {} : { creditQualifiers: request.creditQualifiers ?? [] }),
    ...(request.textField === undefined || request.spoilerThreshold === undefined
      ? {}
      : { spoilerThreshold: request.spoilerThreshold }),
  };
  const params = new URLSearchParams();
  if (request.textField === 'credited_creator') {
    const qualifiers = request.creditQualifiers ?? [];
    if (
      qualifiers.length > 1 ||
      qualifiers.some(
        (qualifier) =>
          qualifier.property !== 'wdt:P3831' ||
          typeof qualifier.value !== 'string' ||
          !qualifier.value ||
          bytes(qualifier.value) > 256,
      ) ||
      (request.spoilerThreshold !== undefined &&
        (!Number.isInteger(request.spoilerThreshold) || request.spoilerThreshold < 0 || request.spoilerThreshold > 2))
    )
      return unavailableQueryShare('unsupported');
    const children = filter ? ('and' in filter ? filter.and : [filter]) : [];
    if (children.some((node) => !('kind' in node))) return unavailableQueryShare('unsupported');
    params.set('mode', 'works');
    params.set('name', document.text);
    if (qualifiers[0]) params.set('role', qualifiers[0].value);
    for (const node of children) if ('kind' in node) for (const kind of node.kind.in) params.append('kinds', kind);
    for (const language of document.languages) params.append('language', language);
    params.set('threshold', String(request.spoilerThreshold ?? 0));
    if (document.sort !== null && document.sort !== 'name' && document.sort !== 'relevance')
      return unavailableQueryShare('unsupported');
    params.set('sort', document.sort ?? 'name');
    const parameters = params.toString();
    if (
      bytes(JSON.stringify(document)) > QUERY_SHARE_LIMITS.documentBytes ||
      bytes(parameters) + 128 > QUERY_SHARE_LIMITS.urlBytes
    )
      return unavailableQueryShare('oversized');
    return {
      viewer: 'anonymous',
      action: 'allowed',
      reason: 'ready',
      document,
      parameters,
      selections: selections.slice(0, QUERY_SHARE_LIMITS.labels),
    };
  }
  if (document.text) params.set('q', document.text);
  if (filter) {
    const children = 'and' in filter ? filter.and : [filter];
    const kindLeaves = children.filter((node) => 'kind' in node);
    const conditions = children.filter((node) => !('kind' in node));
    // Split only the editor's single top-level kind selection. Nested Boolean kind predicates remain intact.
    if (kindLeaves.length <= 1) {
      const condition = conditions.length === 1 ? conditions[0] : conditions.length ? { and: conditions } : undefined;
      try {
        if (condition) params.set('condition', JSON.stringify(parseFilter(condition)));
        for (const kind of kindLeaves.flatMap((node) => ('kind' in node ? node.kind.in : [])))
          params.append('kinds', kind);
      } catch {
        params.delete('condition');
        params.set('filter', document.filter!);
      }
    } else params.set('filter', document.filter!);
  }
  for (const language of document.languages) params.append('language', language);
  if (document.sort === 'rating') params.set('sort', document.sort);
  else if (
    (document.sort === 'name' && document.text) ||
    (document.sort && document.sort !== 'relevance' && document.sort !== 'name')
  )
    return unavailableQueryShare('unsupported');
  const parameters = params.toString();
  if (
    bytes(JSON.stringify(document)) > QUERY_SHARE_LIMITS.documentBytes ||
    bytes(parameters) + 128 > QUERY_SHARE_LIMITS.urlBytes
  )
    return unavailableQueryShare('oversized');
  return {
    viewer: 'anonymous',
    action: 'allowed',
    reason: 'ready',
    document,
    parameters,
    selections: selections.slice(0, QUERY_SHARE_LIMITS.labels),
  };
}
