import type { CommunityRegion } from './subject-community';

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
