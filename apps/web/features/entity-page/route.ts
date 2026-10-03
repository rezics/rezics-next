// `/e/{ref}` addresses and their list cursors. Pure functions shared by the
// route, the components and their tests.

import { idOf } from '../work-page/route.ts';
import { resourceHref, parseAddressSegment, type AddressTarget } from '../address/path.ts';
import type { EntityLink, HrefFor, SectionId } from './types.ts';

/** The UUID of an `/e/{ref}` segment or native IRI; a resource has no slug, so anything else is no address. */
export function parseEntityRef(ref: string): string | null {
  const parsed = parseAddressSegment(ref);
  return parsed && parsed.kind !== 'alias' ? parsed.id : idOf(ref);
}

export const entityHref = (resource: AddressTarget) => resourceHref('/e/', resource);

/** The cursor each list continues from. Statements and discussion answer `nextCursor`, relations `next`. */
export const cursorKeys = { statements: 'statements', relations: 'relations', discussion: 'discussion' } as const;
export type CursorSection = keyof typeof cursorKeys;
export type EntityCursors = Partial<Record<CursorSection, string>>;

type SearchParams = Record<string, string | string[] | undefined>;

/** The lists' cursors from the URL; null when one is repeated or oversized, which the page refuses. */
export function parseEntityCursors(params: SearchParams): EntityCursors | null {
  const cursors: EntityCursors = {};
  for (const section of Object.keys(cursorKeys) as CursorSection[]) {
    const value = params[cursorKeys[section]];
    if (Array.isArray(value)) return null;
    if (value === undefined || value === '') continue;
    if (value.length > 2048) return null;
    cursors[section] = value;
  }
  return cursors;
}

export function isCursorSection(section: SectionId): section is CursorSection {
  return section in cursorKeys;
}

/** The address of the page that holds `current`'s other cursors and moves `section` to `cursor`. */
export function continueHref(base: string, current: EntityCursors, section: CursorSection, cursor: string | null) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...current, [section]: cursor ?? undefined })) {
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return `${base}${text ? `?${text}` : ''}#${section}`;
}

/** A Work's own `/w` host keeps the address it has always had; everything else is read at `/e`. */
export function standaloneHrefFor(current: EntityCursors, self: string): HrefFor {
  return (link: EntityLink) => {
    if (link.kind === 'continue') {
      return isCursorSection(link.section) ? continueHref(self, current, link.section, link.cursor) : self;
    }
    const id = idOf(link.iri);
    if (!id) return self;
    const address = 'address' in link ? link.address as AddressTarget : link.iri;
    return link.base === 'work' ? resourceHref('/w/', address) : entityHref(address);
  };
}
