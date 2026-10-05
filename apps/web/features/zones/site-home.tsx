import { spaceHref } from '../address/path.ts';
import type { ZoneHomeSection } from '@rezics/zone-sdk';
import { zoneText, zoneWork } from '../realm/adapt.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ZoneSite } from '../wiki/links.ts';
import { readMembers } from '../wiki/members.ts';
import { keepReading } from '../wiki/links.ts';
import { parsePosition } from '../wiki/position.ts';
import { zoneContinuity } from '../wiki/zone-continuity.ts';
import { readPositionedRoute } from '../wiki/read.ts';
import { positionNote, positionOf } from '../wiki/state.ts';
import { cardRenderer, workRenderers } from './zone-home.tsx';
import { SlotBoundary } from './slot-boundary.tsx';

type Search = Record<string, string | string[] | undefined>;

/** How many of each mounted list the home sets out; the list's own page continues it. */
export const HOME_ITEMS = 8;

/**
 * A Zone's home when its package supplies one (`home`): each mounted list's first members at the reader's position.
 * The platform reads the lists and names the members; the package only arranges what came back.
 */
export async function ZoneSiteHome({ view, search }: { view: RealmView; search: Search }) {
  const Home = view.pkg?.slots.home;
  const zone = view.realm.zone;
  if (!Home || !zone) return null;
  const { locale, ref } = view.context;
  const choice = parsePosition(search);
  const state = await positionOf(view.pkg, zone.id, choice);
  const reading = await zoneContinuity(view.pkg, state, search);
  const site: ZoneSite = {
    zone: zone.id,
    ref,
    segments: view.mounts.map((mount) => mount.segment),
    choice,
    main: state?.main,
    ...(reading ? { continuity: { choice: reading.choice, fallback: reading.fallback } } : {}),
  };
  const card = cardRenderer(
    view.zone,
    view.pkg,
    locale,
    view.zoneMessages,
    view.reader.avatarQuery,
  );
  const sections = (
    await Promise.all(
      view.mounts.map(async (mount): Promise<ZoneHomeSection | null> => {
        const read = await readPositionedRoute(
          zone.id,
          `/${mount.segment}`,
          undefined,
          state?.main,
        );
        if (!read.ok || read.data.kind !== 'index') return null;
        const items = read.data.items;
        const works = items.flatMap((item) =>
          'title' in item ? [zoneWork(item, view.context, null, mount.segment)] : [],
        );
        const others = items.filter((item) => !('title' in item));
        return {
          segment: mount.segment,
          name: zoneText(mount.name),
          href: keepReading(site, spaceHref(ref, 'site', [mount.segment])),
          works: works.slice(0, HOME_ITEMS),
          members: await readMembers(
            site,
            mount.segment,
            others.slice(0, HOME_ITEMS),
            locale,
            state,
          ),
          more: items.length > HOME_ITEMS || read.data.nextCursor !== null,
        };
      }),
    )
  ).flatMap((section) => section ?? []);
  return (
    <SlotBoundary slot="home" fallback={null}>
      <Home
        zone={view.zone}
        sections={sections}
        position={positionNote(state, spaceHref(ref, 'site'), locale)}
        fallback={null}
        Link={LocalizedLink}
        {...workRenderers(card, locale, view.zoneMessages)}
      />
    </SlotBoundary>
  );
}
