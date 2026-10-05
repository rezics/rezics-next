import { resourceHref, spaceHref } from '../address/path.ts';
import type { ZoneText } from '@rezics/zone-sdk';
import { notFound } from 'next/navigation';
import type { UiLocale } from '../../i18n/define.ts';
import { EntityPage } from '../entity-page/entity-page.tsx';
import type { EntityProjection, HrefFor } from '../entity-page/types.ts';
import { entityHref, parseEntityCursors, standaloneHrefFor } from '../entity-page/route.ts';
import { zoneText } from '../realm/adapt.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { buildEntity } from '../wiki/entity.ts';
import { keepReading, type ZoneSite } from '../wiki/links.ts';
import { withPosition } from '../wiki/position.ts';
import { type PositionState, positionNote } from '../wiki/state.ts';
import { SlotBoundary } from './slot-boundary.tsx';

type Search = Record<string, string | string[] | undefined>;

/**
 * The page of a mounted resource that is not a Work, inside the Zone's frame: the generic resource page with every
 * link mapped to the Zone's own addresses, or the package's `entity` slot set out from the same reads. Both read at
 * the reader's position, so what the page shows is only what Main returned for it.
 */
export async function ZoneEntityPage({
  view,
  id,
  projection,
  locale,
  search,
  site,
  state,
  mount,
  path,
}: {
  view: RealmView;
  id: string;
  projection: EntityProjection;
  locale: UiLocale;
  search: Search;
  site: ZoneSite;
  state: PositionState | null;
  /** The mounted list the page was opened under. */
  mount: string | null;
  /** The page's address in the Zone, without the locale or the position. */
  path: string;
}) {
  const cursors = parseEntityCursors(search);
  if (!cursors) notFound();
  const base = standaloneHrefFor(cursors, path);
  const hrefFor: HrefFor = (link) =>
    link.kind === 'continue'
      ? keepReading(site, base(link))
      : link.base === 'work'
        ? withPosition(resourceHref('/w/', link.iri), { kind: 'default' })
        : keepReading(site, entityHref(link.iri));
  const generic = (
    <EntityPage
      resource={id}
      locale={locale}
      frame={false}
      hrefFor={hrefFor}
      cursors={cursors}
      position={site.main}
      ratingScope={{ scope: 'realm', realm: view.realm.header.id }}
      continuity={site.continuity?.choice}
    />
  );
  const Slot = view.pkg?.slots.entity;
  if (!Slot) return generic;
  const lists = view.mounts.map((item) => ({ segment: item.segment, name: zoneText(item.name) }));
  const entity = await buildEntity({
    id,
    locale,
    projection,
    site,
    state,
    mount,
    lists,
    fullPage: keepReading(site, entityHref(id)),
  });
  if (!entity) return generic;
  const where = mount ? lists.find((list) => list.segment === mount) : undefined;
  const here: { segment: string; name: ZoneText; href: string } | null = where
    ? { ...where, href: keepReading(site, spaceHref(site.ref, 'site', [where.segment])) }
    : null;
  const rest = (
    <EntityPage
      resource={id}
      locale={locale}
      frame={false}
      hrefFor={hrefFor}
      cursors={cursors}
      position={site.main}
      header={false}
      identitySections
      ratingScope={{ scope: 'realm', realm: view.realm.header.id }}
      continuity={site.continuity?.choice}
      sections={['ratings', 'reviews', 'discussion']}
    />
  );
  return (
    <SlotBoundary slot="entity" fallback={generic}>
      <Slot
        zone={view.zone}
        entity={entity}
        position={positionNote(state, path, locale)}
        mount={here}
        rest={rest}
        fallback={generic}
        Link={LocalizedLink}
      />
    </SlotBoundary>
  );
}
