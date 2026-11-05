import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { collectionPageAddress } from './collection-presentation';

const localOrigin = 'https://rezics.invalid';

/** Dynamic results retain their own address; ordinary Collection display owns its separate helper. */
export function savedQueryResultsAddress(
  locale: string,
  id: string,
  cursor: string | undefined,
  search: Record<string, string | string[]> = {},
  context: { layout?: 'grid' | 'list' | undefined; returnTo?: string | undefined } = {},
): string {
  const address = new URL(collectionPageAddress(locale, id, cursor ?? '', search), localOrigin);
  if (cursor === undefined) address.searchParams.delete('cursor');
  if (context.layout) address.searchParams.set('layout', context.layout);
  if (context.returnTo) address.searchParams.set('returnTo', context.returnTo);
  return address.pathname + address.search;
}

/** Navigation operands convey no rule, credential or authority. Only this saved identity may be returned to. */
export function savedQueryRuleReturn(value: string | undefined, id: string, locale: string, afterSave = false): string {
  const fallback = savedQueryResultsAddress(locale, id, undefined);
  if (!value?.startsWith('/') || value.startsWith('//') || value.length > 16_384) return fallback;
  try {
    const destination = new URL(value, localOrigin);
    if (destination.origin !== localOrigin || destination.pathname !== fallback || destination.hash) return fallback;
    const params = destination.searchParams;
    for (const singleton of ['cursor', 'layout', 'returnTo']) if (params.getAll(singleton).length > 1) return fallback;
    const cursor = params.get('cursor') ?? undefined;
    if (cursor !== undefined && (!cursor || cursor.length > 4096)) return fallback;
    const layout = params.get('layout');
    if (layout !== null && layout !== 'grid' && layout !== 'list') return fallback;
    const search: Record<string, string[]> = {};
    for (const [key, entry] of params) {
      if (key !== 'type' && !/^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key)) continue;
      (search[key] ??= []).push(entry);
    }
    return savedQueryResultsAddress(locale, id, afterSave ? undefined : cursor, search, {
      ...(layout ? { layout } : {}),
      ...(params.get('returnTo') ? { returnTo: params.get('returnTo')! } : {}),
    });
  } catch {
    return fallback;
  }
}

/** Ordinary saved identities omit builtinKind; built-ins keep their kind and never offer a rule editor. */
export function isOrdinarySavedQuery(collection: { builtinKind?: string | null | undefined }): boolean {
  return !collection.builtinKind;
}

/** Navigation hint for the current owner. The private GET still authorizes the definition. */
export function RuleEditLink({
  collection,
  viewerId,
  allowed,
  resultsHref,
  className = 'inline-flex min-h-11 min-w-0 max-w-full items-center justify-center break-words rounded-lg border border-border px-4 py-2 text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2',
}: {
  collection: { id: string; curatorAccountId?: string | null; membershipKind?: string; builtinKind?: string };
  viewerId: string | null;
  allowed: boolean;
  resultsHref?: string | undefined;
  className?: string;
}) {
  if (
    !allowed ||
    !viewerId ||
    collection.curatorAccountId !== viewerId ||
    collection.membershipKind !== 'dynamic' ||
    !isOrdinarySavedQuery(collection)
  )
    return null;
  const path = `/${getLocale()}/collections/${encodeURIComponent(collection.id)}/rule`;
  const href = resultsHref
    ? `${path}?${new URLSearchParams({ returnTo: savedQueryRuleReturn(resultsHref, collection.id, getLocale()) })}`
    : path;
  return (
    <a href={href} className={className}>
      {m.library_rule_edit()}
    </a>
  );
}
