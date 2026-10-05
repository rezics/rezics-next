import type { Answer } from '../work-page/read.ts';

/** The two calls of an Eden client that a projection's link needs: the `get` at the end of a path. */
interface Reach { get: (options?: { query?: Record<string, unknown> }) => Promise<Answer<unknown>> }

/** A link's own query: a repeated key (a projection's frames) is one array value, the way the Eden client sends it. */
export function queryOfHref(href: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(href.split('?')[1] ?? '')) {
    const earlier = query[key];
    query[key] = earlier === undefined ? value : [...Array.isArray(earlier) ? earlier : [earlier], value];
  }
  return query;
}

/**
 * Reads the link an `entity-page-v1` section names, on either Eden client.
 * Every section reads from its projection's `href`, never from a path the
 * web assembled, so Main decides which owner answers a section. The link is a
 * path, and its own query (the frames a projection's facts are read within)
 * is kept; the section adds its own, which win.
 */
export function followHref<T>(main: unknown, href: string, query: Record<string, unknown> = {}):
  () => Promise<Answer<T>> {
  const path = href.split('?')[0]!.split('/').filter(Boolean);
  if (path[0] !== 'v1') throw new Error(`Not a Main path: ${href}`);
  let node = main as Record<string, unknown>;
  for (const segment of path) node = node[segment] as Record<string, unknown>;
  const reach = node as unknown as Reach;
  const own = queryOfHref(href);
  const merged = { ...own, ...Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) };
  return () => reach.get({ query: merged }) as Promise<Answer<T>>;
}
