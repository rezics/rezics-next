import { savedQueryDirectoryReturn } from '../library/saved-query-results';

const localOrigin = 'https://rezics.invalid';
const locales = '(?:en|zh-Hant|zh-Hans|ja|ko|fr|de|es)';
const collectionPath = new RegExp(`^/${locales}/collections/[0-9a-f-]{36}$`, 'i');

/** Build the safe Collection visit return with the source address and exact occurrence fragment intact. */
export function collectionMemberReturnAddress(currentHref: string, memberId?: string): string | undefined {
  if (
    !currentHref.startsWith('/') ||
    currentHref.startsWith('//') ||
    (memberId !== undefined && !/^[0-9a-f-]{36}$/i.test(memberId)) ||
    currentHref.length > 16_384
  )
    return undefined;
  try {
    const current = new URL(currentHref, localOrigin);
    if (current.origin !== localOrigin || !collectionPath.test(current.pathname)) return undefined;
    const locale = current.pathname.split('/')[1]!;
    const params = new URLSearchParams();
    const seen = new Set<string>();
    let filters = 0;
    for (const [key, value] of current.searchParams) {
      if (key === 'returnTo') {
        if (seen.has(key)) return undefined;
        seen.add(key);
        params.append(key, savedQueryDirectoryReturn(value, locale));
      } else if (key === 'cursor' || key === 'layout' || key === 'type') {
        if (seen.has(key)) return undefined;
        seen.add(key);
        if (key === 'cursor' && value.length > 4096) return undefined;
        if (key === 'layout' && value !== 'list' && value !== 'grid') return undefined;
        if (key === 'type' && value.length > 128) return undefined;
        params.append(key, value);
      } else if (/^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) && value.length <= 256 && filters < 100) {
        params.append(key, value);
        filters += 1;
      }
    }
    current.search = params.toString();
    current.hash = memberId ? `collection-member-${memberId}` : '';
    return `${current.pathname}${current.search}${current.hash}`;
  } catch {
    return undefined;
  }
}

export function collectionViewerActionHref(subjectHref: string, returnTo: string | undefined): string | undefined {
  if (!returnTo) return undefined;
  try {
    const target = new URL(subjectHref, localOrigin);
    if (target.origin !== localOrigin || !target.pathname.startsWith('/')) return undefined;
    target.searchParams.set('via', returnTo);
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}
