import { parseSearchResourceScope, searchResourceScopeClause } from './advanced-scope';
import type { RecentEntry as HistoryEntry } from './recent-history';
import type { RecentEntry } from './recent-request';

export function recentScopePath(scope: NonNullable<RecentEntry['scope']>): string {
  return scope.kind === 'route' ? '/library' : `/${scope.kind === 'realm' ? 'realms' : 'collections'}/${scope.id}`;
}

/** The minimal history meaning uses the installed Search filter operand, never a second scope field. */
export function recentReplayDestination(entry: RecentEntry): string | undefined {
  if (entry.kind === 'scope') return recentScopePath(entry.scope);
  if (entry.scope?.kind === 'route') return;
  const fields = [
    `q=${encodeURIComponent(entry.text)}`,
    ...(entry.languages ?? []).map((tag) => `language=${encodeURIComponent(tag)}`),
    ...(entry.scope ? [`filter=${encodeURIComponent(JSON.stringify(searchResourceScopeClause(entry.scope)))}`] : []),
  ];
  return `/search?${fields.join('&')}`;
}

function localURL(href: string): URL | undefined {
  if (href.length > 8192 || !href.startsWith('/') || href.startsWith('//') || /[\\\r\n]/.test(href)) return;
  try {
    const url = new URL(href, 'https://recent.invalid');
    // URLSearchParams replaces malformed UTF-8; that is not equivalent escaping.
    decodeURIComponent(url.search.replaceAll('+', ' '));
    if (url.origin === 'https://recent.invalid' && !url.username && !url.password && !url.hash) return url;
  } catch {
    /* Unparseable evidence has no destination. */
  }
}

function sameScopeFilter(filter: string | null, scope: NonNullable<RecentEntry['scope']>): boolean {
  if (filter === null || scope.kind === 'route') return false;
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(filter);
  } catch {
    return false;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document) || Object.keys(document).length !== 1)
    return false;
  const operand = document[scope.kind];
  if (!operand || typeof operand !== 'object' || Array.isArray(operand) || Object.keys(operand).length !== 1)
    return false;
  const parsed = parseSearchResourceScope(filter);
  return !parsed.invalidInput && parsed.scope?.kind === scope.kind && parsed.scope.id === scope.id.toLowerCase();
}

/** Compare decoded meaning, permitting equivalent URL escaping and field order only. */
export function admitsRecentDestination(entry: RecentEntry, href: string): boolean {
  if (!recentReplayDestination(entry)) return false;
  const url = localURL(href);
  if (!url) return false;
  if (entry.kind === 'scope') return url.pathname === recentScopePath(entry.scope) && url.search === '';
  if (url.pathname !== '/search') return false;
  const keys = [...url.searchParams.keys()];
  const languages = url.searchParams.getAll('language');
  return (
    keys.length === 1 + (entry.languages?.length ?? 0) + (entry.scope ? 1 : 0) &&
    keys.every((key) => key === 'q' || key === 'language' || (key === 'filter' && entry.scope)) &&
    url.searchParams.getAll('q').length === 1 &&
    url.searchParams.get('q') === entry.text &&
    languages.length === (entry.languages?.length ?? 0) &&
    languages.every((tag, index) => tag === entry.languages?.[index]) &&
    (entry.scope
      ? url.searchParams.getAll('filter').length === 1 && sameScopeFilter(url.searchParams.get('filter'), entry.scope)
      : true)
  );
}

export function recentHistoryReference(entry: HistoryEntry): RecentEntry | undefined {
  const ref = entry.scope;
  if (ref !== undefined && !ref) return;
  if (ref && ref.kind !== 'Library' && ref.kind !== 'Realm' && ref.kind !== 'Collection') return;
  if (ref && ref.kind !== 'Library' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.id))
    return;
  const scope =
    ref?.kind === 'Library'
      ? { kind: 'route' as const, route: 'library' as const }
      : ref
        ? { kind: ref.kind === 'Realm' ? ('realm' as const) : ('collection' as const), id: ref.id }
        : undefined;
  return entry.query
    ? {
        kind: 'query',
        text: entry.query,
        ...(entry.languages !== undefined ? { languages: entry.languages } : {}),
        ...(scope ? { scope } : {}),
      }
    : scope
      ? { kind: 'scope', scope }
      : undefined;
}

/** A stored reference alone has no disclosure authority. Rebuild only from current admitted action evidence. */
export function recentHistoryDestination(entry: HistoryEntry, locales: readonly string[] = []): string | undefined {
  const native = recentHistoryReference(entry);
  if (!native) return;
  const destination = recentReplayDestination(native);
  if (!destination || !entry.scope) return destination;
  const action = entry.scope.searchAction;
  const url = action ? localURL(action) : undefined;
  if (!url) return;
  const parts = url.pathname.split('/');
  if (locales.includes(parts[1]!)) url.pathname = `/${parts.slice(2).join('/')}`;
  const href = `${url.pathname}${url.search}`;
  if (admitsRecentDestination(native, href)) return destination;
  // Existing local scope actions may carry the resource alone or the installed Search operand alone.
  if (url.pathname === recentScopePath(native.scope!) && url.search === '') return destination;
  if (
    url.pathname === '/search' &&
    [...url.searchParams.keys()].length === 1 &&
    sameScopeFilter(url.searchParams.get('filter'), native.scope!)
  )
    return destination;
}
