import type { AboutPerson } from './views.tsx';

interface RosterRow { agent: string; displayName: string | null; featured: boolean }

/**
 * A page of the public roster as rows. A member whose name is private is still a member, so they show under the
 * fallback name; dropping them made a page of private names look like an empty community.
 */
export function rosterPeople(
  items: readonly RosterRow[],
  fallbackName: string,
  href: (agent: string) => string | null,
): AboutPerson[] {
  return items.map((item) => ({
    id: item.agent,
    name: item.displayName ?? fallbackName,
    href: href(item.agent),
    kind: 'person' as const,
    avatarUrl: null,
    featured: item.featured,
  }));
}
