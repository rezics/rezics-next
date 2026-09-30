export const ZONE_RESERVED_SEGMENTS = ['browse', 'discussions', 'decisions', 'about',
  'works', 'submit', 'w'] as const;
const segment = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ZonePath = { kind: 'home' }
  | { kind: 'mount'; segment: string; resource: string | null; tab: string | null }
  | { kind: 'work'; resource: string; tab: string | null };

/** Already-decoded paths are exact: no URL, dot, empty or encoded path aliases. */
export function parseZonePath(path: string): ZonePath | null {
  if (path === '/') return { kind: 'home' };
  if (path.length > 256 || !path.startsWith('/')) return null;
  const parts = path.slice(1).split('/');
  const first = parts[0]!;
  if (first.length > 64 || !segment.test(first) || parts.length > 3) return null;
  const resource = parts[1];
  const tab = parts[2];
  if (resource !== undefined && !uuid.test(resource)
    || tab !== undefined && (tab.length > 64 || !segment.test(tab))) return null;
  if (first === 'w') return resource ? { kind: 'work', resource, tab: tab ?? null } : null;
  if ((ZONE_RESERVED_SEGMENTS as readonly string[]).includes(first)) return null;
  return { kind: 'mount', segment: first, resource: resource ?? null, tab: tab ?? null };
}
