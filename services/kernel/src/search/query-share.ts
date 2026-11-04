import { parseDiscoveryFilter } from '@rezics/filter';
import { parseText } from './text.ts';

export const QUERY_SHARE_LIMITS = Object.freeze({ documentBytes: 16384, urlBytes: 8192, labels: 128, labelBytes: 256 });
export type QueryShare = {
  action: 'allowed' | 'disabled' | 'unavailable';
  reason: 'ready' | 'private_context' | 'unsupported' | 'oversized' | 'unavailable';
  document: { text: string; filter: string | null; languages: string[]; sort: string | null } | null;
  parameters: string | null;
  selections: { value: string; language: string }[];
};
const bytes = (value: string) => new TextEncoder().encode(value).length;
export function unavailableQueryShare(reason: QueryShare['reason'], action: QueryShare['action'] = 'disabled'): QueryShare {
  return { action, reason, document: null, parameters: null, selections: [] };
}

/** Called only after ordinary native execution admits this exact request. No principal or continuation is copied. */
export function prepareQueryShare(
  request: { text?: string; filter?: unknown; languages?: string[]; sort?: string; population?: unknown; spaceId?: string },
  labels: Record<string, Record<string, string>> = {},
): QueryShare {
  if (request.population !== undefined || request.spaceId !== undefined) return unavailableQueryShare('private_context');
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
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    for (const [key, value] of Object.entries(node)) {
      // Resource scope portability needs a public owner projection. Never infer it from the current reader's grant.
      if (['owner', 'library', 'collection', 'zone', 'realm', 'saved'].includes(key)) privateContext = true;
      visit(value);
    }
  };
  visit(filter);
  if (privateContext) return unavailableQueryShare('private_context');
  const document = {
    text: request.text ?? '',
    filter: filter === undefined ? null : JSON.stringify(filter),
    languages: request.languages ?? ['en'],
    sort: request.sort ?? null,
  };
  const params = new URLSearchParams();
  if (document.text) params.set('q', document.text);
  if (document.filter) params.set('filter', document.filter);
  for (const language of document.languages) params.append('language', language);
  if (document.sort === 'rating') params.set('sort', document.sort);
  else if (document.sort && document.sort !== 'relevance' && document.sort !== 'name') return unavailableQueryShare('unsupported');
  const parameters = params.toString();
  if (bytes(JSON.stringify(document)) > QUERY_SHARE_LIMITS.documentBytes || bytes(parameters) + 128 > QUERY_SHARE_LIMITS.urlBytes)
    return unavailableQueryShare('oversized');
  return { action: 'allowed', reason: 'ready', document, parameters, selections: selections.slice(0, QUERY_SHARE_LIMITS.labels) };
}
