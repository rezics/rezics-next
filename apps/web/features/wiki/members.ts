import type { ZoneMember } from '@rezics/zone-sdk';
import { entryLabel, typeEntry } from '../catalogue/types.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { zoneText } from '../realm/adapt.ts';
import type { ZoneRouteRead } from '../realm/types.ts';
import { memberHref, type ZoneSite } from './links.ts';
import { occurrenceName, type PositionState } from './state.ts';

// Main admits and names the whole index at the same reading position. Reuse
// that projection; a member's display name needs no additional page request.

type Item = Extract<ZoneRouteRead, { kind: 'index' }>['items'][number];

/** The members of an index page that are not Works, in Main's order, each with a name and an address in the Zone. */
export function readMembers(site: ZoneSite, segment: string, items: readonly Item[], locale: UiLocale,
  state: PositionState | null = null): Promise<ZoneMember[]> {
  const members = items.flatMap(item => 'title' in item ? [] : [item]).map(item => {
    // A chapter's summary is named after its Work; the name the story gives it is the label its composition wrote.
    const chapter = state ? occurrenceName(state, item.id, locale) : null;
    const registry = typeEntry(item.types,'resource');
    return { id: item.id, href: memberHref(site, segment, item.id), name: chapter ?? zoneText(item.name),
      kind: !registry || registry.default ? null : entryLabel(registry, locale) } satisfies ZoneMember;
  });
  return Promise.resolve(members);
}
