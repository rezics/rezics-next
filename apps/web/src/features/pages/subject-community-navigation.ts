import type { CommunityRegion } from './subject-community';
import { GLOBAL } from './subject-ratings';
import { subjectCommunityVisitReturn, subjectVisitReturn } from './subject-visit-navigation';

const communityNode = /^[A-Za-z0-9_-]{1,64}$/u;

export function communityRegionAnchor(id: string): string | undefined {
  return communityNode.test(id) ? `subject-community-${id}` : undefined;
}

/** Build the return from this mounted region, never from its separate full-list destination. */
export function communityRegionReturnTo(input: {
  currentHref: string;
  locale: string;
  id: string;
  subjectId: string;
  kind: 'review' | 'discussion';
  paged: boolean;
  node?: string;
  region: CommunityRegion;
}): string | undefined {
  const request = input.region.request;
  const anchor = communityRegionAnchor(input.id);
  if (!request || request.id !== input.subjectId || request.threadKind !== input.kind || !anchor) return;
  const current = subjectVisitReturn(input.currentHref.split('#', 1)[0]!, input.locale);
  if (!current) return;

  const url = new URL(current, 'https://rezics.invalid');
  const parts = url.pathname.split('/');
  const subjectIndex = parts.indexOf('subjects');
  if (subjectIndex < 0) return;
  let routeSubject: string;
  try {
    routeSubject = decodeURIComponent(parts[subjectIndex + 1] ?? '');
  } catch {
    return;
  }
  if (routeSubject !== input.subjectId) return;

  url.searchParams.delete('cursor');
  if (request.cursor !== undefined) url.searchParams.set('cursor', request.cursor);
  url.searchParams.delete('node');
  if (input.paged) {
    const node = input.node ?? input.id;
    if (!communityNode.test(node)) return;
    url.searchParams.set('node', node);
  }
  if (request.place === GLOBAL) url.searchParams.delete('realm');
  else {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(request.place)) return;
    url.searchParams.set('realm', request.place);
  }
  url.hash = anchor;
  return subjectCommunityVisitReturn(`${url.pathname}${url.search}${url.hash}`, input.locale);
}

export function communityBoardHref(locale: string, boardId: string, returnTo?: string): string {
  const href = `/${encodeURIComponent(locale)}/boards/${encodeURIComponent(boardId)}`;
  return returnTo ? `${href}?${new URLSearchParams({ returnTo })}` : href;
}

/** Every link preserves the regional request's original opaque frontier and surrounding route context. */
export function communityRegionLinks(input: { href: string; paged: boolean; node?: string; region: CommunityRegion }) {
  const [address, hash] = input.href.split('#');
  const [path, search = ''] = address!.split('?');
  const query = new URLSearchParams(search);
  const request = input.region.request;
  if (input.paged && request) {
    query.delete('cursor');
    query.delete('node');
    if (request.cursor !== undefined) {
      query.set('cursor', request.cursor);
      if (input.node) query.set('node', input.node);
    }
  }
  const destination = (values: URLSearchParams, fragment?: string) =>
    `${path}${values.size ? `?${values}` : ''}${fragment ? `#${fragment}` : ''}`;
  const retry = input.paged ? destination(query, hash) : `?${query}`;
  const next = new URLSearchParams(query);
  if (input.region.state === 'ready' && input.region.next) {
    next.set('cursor', input.region.next);
    if (input.node) next.set('node', input.node);
  }
  const restart = new URLSearchParams(query);
  restart.delete('cursor');
  restart.delete('node');
  return {
    retry,
    next: input.paged ? destination(next, hash) : input.href,
    restart: destination(restart, input.node ? encodeURIComponent(input.node) : hash),
  };
}
