import type { Answer } from '../work-page/read.ts';

/** The two calls of an Eden client that a projection's link needs: the `get` at the end of a path. */
interface Reach { get: (options?: { query?: Record<string, unknown> }) => Promise<Answer<unknown>> }

/**
 * Reads the link an `entity-page-v1` section names, on either Eden client.
 * Every section reads from its projection's `href`, never from a path the
 * web assembled, so Main decides which owner answers a section. The link is
 * a path with no query; the section adds its own.
 */
export function followHref<T>(main: unknown, href: string, query: Record<string, unknown> = {}):
  () => Promise<Answer<T>> {
  const path = href.split('?')[0]!.split('/').filter(Boolean);
  if (path[0] !== 'v1') throw new Error(`Not a Main path: ${href}`);
  let node = main as Record<string, unknown>;
  for (const segment of path) node = node[segment] as Record<string, unknown>;
  const reach = node as unknown as Reach;
  return () => reach.get({ query }) as Promise<Answer<T>>;
}
