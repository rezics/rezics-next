import type { ZoneMember } from '@rezics/zone-sdk';
import { entryLabel } from '../catalogue/types.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { readEntityProjection } from '../entity-page/read.ts';
import { zoneText } from '../realm/adapt.ts';
import type { ZoneRouteRead } from '../realm/types.ts';
import { idOf } from '../work-page/route.ts';
import { memberHref, type ZoneSite } from './links.ts';
import { occurrenceName, type PositionState } from './state.ts';

// The pages of a mounted list that are not Works, named for the reader's position. Main's route read returns only
// each member's address and types, so each name comes from that member's own page read at the same position (the
// read that already withholds what is revealed later) rather than from a summary that knows no position.

type Item = Extract<ZoneRouteRead, { kind: 'index' }>['items'][number];

/** The members of an index page that are not Works, in Main's order, each with a name and an address in the Zone. */
export async function readMembers(site: ZoneSite, segment: string, items: readonly Item[], locale: UiLocale,
  state: PositionState | null = null): Promise<ZoneMember[]> {
  const members = await Promise.all(items.flatMap(item => 'title' in item ? [] : [item]).map(async item => {
    const id = idOf(item.id);
    const page = id ? await readEntityProjection(id, site.main) : null;
    if (!page?.ok || page.data.summary.status !== 'available') return null;
    // A chapter's summary is named after its Work; the name the story gives it is the label its composition wrote.
    const chapter = state && page.data.target.base === 'occurrence' ? occurrenceName(state, item.id, locale) : null;
    return { id: item.id, href: memberHref(site, segment, item.id), name: chapter ?? zoneText(page.data.summary.name),
      kind: page.data.registry.default ? null : entryLabel(page.data.registry, locale) } satisfies ZoneMember;
  }));
  return members.flatMap(member => member ?? []);
}
