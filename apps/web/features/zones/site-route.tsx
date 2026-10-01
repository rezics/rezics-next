import type { ZoneMember, ZoneWork } from '@rezics/zone-sdk';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { isUiLocale } from '../../i18n/define.ts';
import { getMessages, getTranslation } from '../../i18n/server.ts';
import { zoneText } from '../realm/adapt.ts';
import type { RealmMessages } from '../realm/messages.ts';
import { loadRealmView, RealmFrame } from '../realm/realm-page.tsx';
import { readPresentation, readZoneRoute, resolveRealm } from '../realm/read.ts';
import { parseCursor, parseRealmRef, realmHref, siteHref } from '../realm/route.ts';
import { RealmUnavailable } from '../realm/states.tsx';
import type { ReadFailure, ZoneRouteRead } from '../realm/types.ts';
import { ListFailure } from '../realm/views.tsx';
import { PageContainer } from '../shell/page.tsx';
import { localeAlternates, pageUrl } from '../seo/address.ts';
import { workPageMetadata } from '../seo/work.ts';
import { readEntityProjection } from '../entity-page/read.ts';
import { readMembers } from '../wiki/members.ts';
import { type PositionChoice, parsePosition, positionParam, withPosition } from '../wiki/position.ts';
import { readPositionedRoute } from '../wiki/read.ts';
import { positionNote, positionOf } from '../wiki/state.ts';
import type { ZoneSite } from '../wiki/links.ts';
import { loadWork, readText, resolveWork } from '../work-page/read.ts';
import { idOf, shortId, type WorkTab } from '../work-page/route.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { SlotBoundary } from './slot-boundary.tsx';
import { cardRenderer, workRenderers } from './zone-home.tsx';
import { DocumentPage, DocumentUnavailable, IndexPage, PageNotAvailable } from './site-pages.tsx';
import { ZoneEntityPage } from './site-entity.tsx';
import type { SiteCrumb } from './site-navigation.tsx';
import { workBase, workTabOf, ZoneWorkPage } from './site-work.tsx';

// `/{locale}/r/{ref}/…`: whatever Main resolves a path under the Zone to, rendered inside the Zone's frame.
// Static Realm routes (`browse`, `about`, …) take precedence over this catch-all; Main decides what the rest
// of the path is (mount, member, Work), so nothing here matches routes or checks membership.

type Search = Record<string, string | string[] | undefined>;
export interface ZoneSiteProps {
  params: Promise<{ locale: string; realm: string; path: string[] }>;
  searchParams: Promise<Search>;
}

const routePath = (path: readonly string[]) => `/${path.join('/')}`;
/** `cursor` pages a mount's own index; below the mount it belongs to a Work's tabs. */
const routeCursor = (path: readonly string[], search: Search) => path.length === 1 ? parseCursor(search) : undefined;
const stringQuery = (search: Search) => Object.fromEntries(Object.entries(search)
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/** Search and link-preview metadata: a Work's own (pointing at `/w/{id}`), or a mounted page's (its own address). */
export async function zoneSiteMetadata({ params, searchParams }: ZoneSiteProps): Promise<Metadata> {
  const [{ locale, realm, path }, search] = await Promise.all([params, searchParams]);
  if (!isUiLocale(locale)) return {};
  const [resolved, { t }] = await Promise.all([resolveRealm(realm, locale), getTranslation('realm', [locale])]);
  const hidden = { robots: { index: false } };
  if (resolved.kind !== 'realm' || !resolved.zone) {
    return { title: resolved.kind === 'unavailable' ? t.unavailableTitle : t.notFoundTitle, ...hidden };
  }
  const cursor = routeCursor(path, search);
  const read = await readZoneRoute(resolved.zone.id, routePath(path), cursor);
  if (!read.ok) return { title: read.failure === 'missing' ? t.notFoundTitle : t.unavailableTitle, ...hidden };
  const route = read.data;
  const zone = resolved.header.name.value;
  const address = async (title: string): Promise<Metadata> => {
    const origin = (await pageUrl())?.origin;
    return { title: `${title} · ${zone}`, ...cursor ? hidden : {},
      ...origin ? { alternates: localeAlternates(origin, `/r/${encodeURIComponent(realm)}${routePath(path)}`, locale) } : {} };
  };
  if (route.kind === 'index') {
    const presentation = await readPresentation(resolved.zone.id);
    const mount = presentation.ok ? presentation.data.navigation.find(item => item.segment === route.mount.segment) : null;
    return address(mount?.name.value ?? route.mount.segment);
  }
  if (route.kind === 'home') return { title: zone };
  const id = idOf(route.resource.id);
  const work = id ? await resolveWork(id, locale) : null;
  if (route.kind === 'document') return address(work?.kind === 'work' ? work.header.title.value : zone);
  // A page that is not a Work's depends on the reader's position, so it is not indexed.
  if (!work || work.kind !== 'work') return { title: zone, ...hidden };
  const tab = route.tab === null ? 'overview' : route.tab as WorkTab;
  const { scope: _scope, realm: _realm, ...rest } = search;
  return { title: `${work.header.title.value} · ${zone}`, ...await workPageMetadata(work, { tab }, rest, locale) };
}

/** A read made as the signed-in reader can also fail on their identity; to the page that is the Zone being unavailable. */
function failure(reason: ReadFailure | 'identity' | 'sign-in', firstPage: string, messages: RealmMessages) {
  return <PageContainer><ListFailure failure={reason === 'identity' || reason === 'sign-in' ? 'unavailable' : reason}
    messages={messages} firstPage={firstPage} /></PageContainer>;
}

export async function ZoneSiteRoute({ params, searchParams }: ZoneSiteProps): Promise<ReactNode> {
  const [{ locale, realm, path }, search] = await Promise.all([params, searchParams]);
  if (!isUiLocale(locale)) notFound();
  if (parseRealmRef(realm)?.kind === 'id') {
    const resolved = await resolveRealm(realm, locale);
    if (resolved.kind === 'realm' && resolved.zone?.segment) {
      redirect(siteHref(locale, resolved.zone.segment, path, stringQuery(search)));
    }
  }
  const view = await loadRealmView(realm, locale, search);
  if (view.kind === 'missing') notFound();
  if (view.kind === 'unavailable') return <RealmUnavailable messages={await getMessages('realm', locale)} />;
  const zone = view.realm.zone;
  if (!zone) notFound();
  const { ref } = view.context;
  const cursor = routeCursor(path, search);
  // A Zone whose package reads at the reader's position sends it with every read, as the signed-in reader.
  const choice: PositionChoice = parsePosition(search);
  const state = await positionOf(view.pkg, zone.id, choice);
  const site: ZoneSite = { zone: zone.id, ref, segments: view.mounts.map(mount => mount.segment), choice,
    main: state?.main };
  const address = siteHref(locale, ref, path, { cursor, position: positionParam(choice) });
  const read = state ? await readPositionedRoute(zone.id, routePath(path), cursor, state.main)
    : await readZoneRoute(zone.id, routePath(path), cursor);
  if (!read.ok && read.failure === 'missing') notFound();
  const kept = (href: string) => withPosition(href, choice);
  const home: SiteCrumb = { label: view.zone.name, href: kept(`/r/${encodeURIComponent(ref)}`) };
  const frame = (children: ReactNode, crumbs?: SiteCrumb[]) => <RealmFrame view={view} tab={null} locale={locale}
    search={search} address={address} crumbs={crumbs}>{children}</RealmFrame>;
  if (!read.ok) return frame(failure(read.failure, siteHref(locale, ref, path), view.messages));
  const route: ZoneRouteRead = read.data;
  const mountName = (segment: string) => {
    const mount = view.mounts.find(item => item.segment === segment);
    return mount ? zoneText(mount.name) : null;
  };
  switch (route.kind) {
    case 'home': return redirect(realmHref(locale, ref));
    case 'document': {
      const id = idOf(route.resource.id);
      if (!id) notFound();
      const [work, workMessages] = await Promise.all([loadWork(id, locale), getMessages('workPage', locale)]);
      if (!work.ok) return frame(<DocumentUnavailable messages={view.messages} workMessages={workMessages} />);
      const text = await readText(work.header.mainVersion, work.header.selectedLanguage ?? undefined);
      const crumbs = [home, { label: zoneText(work.header.title), href: null }];
      if (!text.ok) return frame(text.failure === 'missing' ? <PageNotAvailable messages={view.messages} />
        : <DocumentUnavailable messages={view.messages} workMessages={workMessages} />, crumbs);
      return frame(<DocumentPage work={work.header} text={text.data} messages={workMessages} />, crumbs);
    }
    case 'index': {
      const name = mountName(route.mount.segment) ?? { value: route.mount.segment, lang: '', dir: 'ltr' as const };
      const card = cardRenderer(view.zone, view.pkg, locale, view.zoneMessages, view.reader.avatarQuery);
      const members = await readMembers(site, route.mount.segment, route.items, locale);
      const Slot = view.pkg?.slots.index;
      const arrange = Slot ? (works: ZoneWork[], grid: ReactNode) => <SlotBoundary slot="index" fallback={grid}>
        <Slot zone={view.zone} works={works} fallback={grid} Link={LocalizedLink}
          {...workRenderers(card, locale, view.zoneMessages)} /></SlotBoundary> : undefined;
      const MembersSlot = view.pkg?.slots.memberIndex;
      const arrangeMembers = MembersSlot ? (named: ZoneMember[], list: ReactNode) => <SlotBoundary slot="memberIndex"
        fallback={list}>
        <MembersSlot zone={view.zone} members={named} mount={{ segment: route.mount.segment, name }}
          position={positionNote(state, siteHref(locale, ref, path))} more={route.nextCursor !== null}
          fallback={list} Link={LocalizedLink} /></SlotBoundary> : undefined;
      return frame(<IndexPage route={route} cursor={cursor} context={view.context} card={card} locale={locale}
        messages={view.messages} arrange={arrange} arrangeMembers={arrangeMembers} members={members} query={{ position: positionParam(choice) }}
        title={<span lang={name.lang || undefined} dir={name.dir}>{name.value}</span>} />,
      [home, { label: name, href: null }]);
    }
    case 'detail': {
      const id = idOf(route.resource.id);
      if (!id) notFound();
      const mount = route.mount ? { label: mountName(route.mount.segment) ?? { value: route.mount.segment, lang: '',
        dir: 'ltr' as const }, href: kept(`/r/${encodeURIComponent(ref)}/${encodeURIComponent(route.mount.segment)}`) } : null;
      // What the page is comes from Main's page projection, which also answers 404 for a record not yet revealed.
      const projection = await readEntityProjection(id, state?.main);
      if (!projection.ok) {
        if (projection.failure === 'missing') notFound();
        return frame(failure(projection.failure, siteHref(locale, ref, path), view.messages),
          [home, ...mount ? [mount] : [], { label: { value: shortId(id), lang: '', dir: 'ltr' }, href: null }]);
      }
      if (projection.data.target.base === 'work') {
        const tab = workTabOf(route.tab);
        const work = await loadWork(id, locale);
        const title = work.ok ? zoneText(work.header.title) : { value: shortId(id), lang: '', dir: 'ltr' as const };
        return frame(<ZoneWorkPage base={workBase(ref, id, route.mount?.segment ?? null, view.context.realm)}
          tab={tab} search={search} locale={locale} pkg={view.pkg} />,
        [home, ...mount ? [mount] : [], { label: title, href: null }]);
      }
      const summary = projection.data.summary;
      const title = summary.status === 'available' ? zoneText(summary.name)
        : { value: shortId(id), lang: '', dir: 'ltr' as const };
      return frame(<ZoneEntityPage view={view} id={id} projection={projection.data} locale={locale} search={search}
        site={site} state={state} mount={route.mount?.segment ?? null}
        path={`/r/${encodeURIComponent(ref)}/${path.map(encodeURIComponent).join('/')}`} />,
      [home, ...mount ? [mount] : [], { label: title, href: null }]);
    }
  }
}
