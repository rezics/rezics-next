import type { ZoneMember, ZoneWork } from '@rezics/zone-sdk';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isUiLocale } from '../../i18n/define.ts';
import { getMessages, getTranslation } from '../../i18n/server.ts';
import { zoneContentText } from '../language/untagged.ts';
import { zoneText } from '../realm/adapt.ts';
import type { RealmMessages } from '../realm/messages.ts';
import { loadRealmView, privateJoinPage, RealmFrame } from '../realm/realm-page.tsx';
import {
  readPresentation,
  readZoneRoute,
  resolveRealm,
  resolveSite,
  type SiteResolution,
} from '../realm/read.ts';
import { parseCursor, siteHref } from '../realm/route.ts';
import { RealmBrowseRoute, SiteHomeRoute } from '../realm/routes.tsx';
import { RealmUnavailable } from '../realm/states.tsx';
import type { ReadFailure, ZoneRouteRead } from '../realm/types.ts';
import { ListFailure, Pager } from '../realm/views.tsx';
import { PageContainer } from '../shell/page.tsx';
import { pageUrl, representationPath } from '../seo/address.ts';
import { workPageMetadata } from '../seo/work.ts';
import { readEntityProjection } from '../entity-page/read.ts';
import { readMembers } from '../wiki/members.ts';
import {
  type PositionChoice,
  parsePosition,
  positionParam,
  withPosition,
} from '../wiki/position.ts';
import { readPositionedRoute } from '../wiki/read.ts';
import { occurrenceName, positionNote, positionOf } from '../wiki/state.ts';
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
import { addressKey, siteMemberTarget, spaceHref, zoneMemberHref } from '../address/path.ts';
import { realmDiscovery } from '../address/space-read.ts';
import { EntityPage } from '../entity-page/entity-page.tsx';
import { ZoneFrame, ZoneMasthead } from './zone-frame.tsx';
import { zoneTheme } from './theme.ts';
import { MemberList } from './site-pages.tsx';
import type { ZoneContext } from '@rezics/zone-sdk';
import { cookies, headers } from 'next/headers';
import { parseTheme, THEME_COOKIE } from '../shell/preferences.ts';
import { ZONE_NONCE_HEADER } from './csp.ts';

// /{locale}/z/{space}/… has one optional catch-all, including home. Main's
// route table decides which mount or member a path names; community tabs cannot shadow it.

type Search = Record<string, string | string[] | undefined>;
export interface ZoneSiteProps {
  params: Promise<{ locale: string; space: string; path?: string[] }>;
  searchParams: Promise<Search>;
}

const routePath = (path: readonly string[]) => `/${path.join('/')}`;
/** `cursor` pages a mount's own index; below the mount it belongs to a Work's tabs. */
const routeCursor = (path: readonly string[], search: Search) =>
  path.length === 1 ? parseCursor(search) : undefined;

/** Search and link-preview metadata: a Work's own (pointing at `/w/{id}`), or a mounted page's (its own address). */
export async function zoneSiteMetadata({ params, searchParams }: ZoneSiteProps): Promise<Metadata> {
  const props = { params, searchParams };
  const metadata = await siteContentMetadata(props);
  const { locale, space } = await params;
  if (!isUiLocale(locale)) return metadata;
  const resolved = await resolveSite(space, locale);
  if (resolved.kind === 'join')
    return { title: resolved.page.name.value, robots: { index: false }, referrer: 'no-referrer' };
  if (resolved.kind !== 'site' || !resolved.realm) return metadata;
  const realm = await resolveRealm(space, locale);
  if (realm.kind === 'join')
    return { title: realm.page.name.value, robots: { index: false }, referrer: 'no-referrer' };
  if (realm.kind !== 'realm') return metadata;
  const discovery = realmDiscovery(realm.header);
  return {
    ...metadata,
    ...(discovery?.robots === 'noindex' ? { robots: { index: false } } : {}),
    ...(discovery?.referrerPolicy ? { referrer: discovery.referrerPolicy } : {}),
  };
}

async function siteContentMetadata({ params, searchParams }: ZoneSiteProps): Promise<Metadata> {
  const [{ locale, space, path = [] }, search] = await Promise.all([params, searchParams]);
  if (!isUiLocale(locale)) return {};
  const [resolved, { t }] = await Promise.all([
    resolveSite(space, locale),
    getTranslation('realm', [locale]),
  ]);
  const hidden = { robots: { index: false } };
  if (resolved.kind !== 'site') {
    return {
      title: resolved.kind === 'unavailable' ? t.unavailableTitle : t.notFoundTitle,
      ...hidden,
    };
  }
  const cursor = routeCursor(path, search);
  const read = await readZoneRoute(resolved.zone, routePath(path), cursor);
  if (!read.ok) {
    if (read.failure !== 'missing') return { title: t.unavailableTitle, ...hidden };
    const { t: page } = await getTranslation('zones', [locale]);
    if (resolved.realm && path.length === 1 && path[0] === 'browse') {
      return { title: `${page.browseTab} · ${resolved.address.canonical.suffixSource}`, ...hidden };
    }
    return {
      title: `${page.pageMissingTitle} · ${resolved.address.canonical.suffixSource}`,
      ...hidden,
    };
  }
  const route = read.data;
  const zone = resolved.address.canonical.suffixSource;
  const address = async (title: string): Promise<Metadata> => {
    const page = await pageUrl();
    return {
      title: `${title} · ${zone}`,
      ...(cursor ? hidden : {}),
      ...(page ? { alternates: { canonical: page.origin + representationPath(page) } } : {}),
    };
  };
  if (route.kind === 'index') {
    const presentation = await readPresentation(resolved.zone);
    const mount = presentation.ok
      ? presentation.data.navigation.find((item) => item.segment === route.mount.segment)
      : null;
    return address(mount?.name.value ?? route.mount.segment);
  }
  if (route.kind === 'home') {
    const presentation = await readPresentation(resolved.zone);
    return presentation.ok
      ? { ...(await address(zone)), title: zone }
      : { title: t.unavailableTitle, ...hidden };
  }
  const id = idOf(route.resource.id);
  const work = id ? await resolveWork(id, locale) : null;
  if (route.kind === 'document')
    return address(work?.kind === 'work' ? work.header.title.value : zone);
  // A page that is not a Work's depends on the reader's position, so it is not indexed.
  if (!work || work.kind !== 'work') return { title: zone, ...hidden };
  const tab = route.tab === null ? 'overview' : (route.tab as WorkTab);
  const { scope: _scope, realm: _realm, ...rest } = search;
  return {
    ...(await workPageMetadata(work, { tab }, rest, locale)),
    ...(await address(work.header.title.value)),
  };
}

/** A read made as the signed-in reader can also fail on their identity; to the page that is the Zone being unavailable. */
function failure(
  reason: ReadFailure | 'identity' | 'sign-in',
  firstPage: string,
  messages: RealmMessages,
) {
  return (
    <PageContainer>
      <ListFailure
        failure={reason === 'identity' || reason === 'sign-in' ? 'unavailable' : reason}
        messages={messages}
        firstPage={firstPage}
      />
    </PageContainer>
  );
}

export async function ZoneSiteRoute({ params, searchParams }: ZoneSiteProps): Promise<ReactNode> {
  const [{ locale, space, path = [] }, search] = await Promise.all([params, searchParams]);
  if (!isUiLocale(locale)) notFound();
  const resolved = await resolveSite(space, locale);
  if (resolved.kind === 'missing') notFound();
  if (resolved.kind === 'unavailable')
    return <RealmUnavailable messages={await getMessages('realm', locale)} />;
  if (resolved.kind === 'join')
    return privateJoinPage(resolved.page, locale, siteHref(locale, space, path));
  if (!resolved.realm) return standaloneSite(resolved, locale, path, search);
  // Read the Zone table before the starter Browse renderer, so a mount named
  // browse is never shadowed. Main currently has no starter-browse route kind.
  const routed = await readZoneRoute(resolved.zone, routePath(path), routeCursor(path, search));
  const communityProps = {
    params: Promise.resolve({ locale, realm: space }),
    searchParams: Promise.resolve(search),
  };
  if (routed.ok && routed.data.kind === 'home') return SiteHomeRoute(communityProps);
  if (!routed.ok && routed.failure === 'missing' && path.length === 1 && path[0] === 'browse') {
    return RealmBrowseRoute(communityProps);
  }
  const view = await loadRealmView(space, locale, search, 'site');
  if (view.kind === 'missing') notFound();
  if (view.kind === 'unavailable')
    return <RealmUnavailable messages={await getMessages('realm', locale)} />;
  if (view.kind === 'join')
    return privateJoinPage(view.page, locale, siteHref(locale, space, path));
  const zone = view.realm.zone;
  if (!zone) notFound();
  const { ref } = view.context;
  const cursor = routeCursor(path, search);
  // A Zone whose package reads at the reader's position sends it with every read, as the signed-in reader.
  const choice: PositionChoice = parsePosition(search);
  const state = await positionOf(view.pkg, zone.id, choice);
  const site: ZoneSite = {
    zone: zone.id,
    ref,
    segments: view.mounts.map((mount) => mount.segment),
    choice,
    main: state?.main,
  };
  const address = siteHref(locale, ref, path, { cursor, position: positionParam(choice) });
  const read = state
    ? await readPositionedRoute(zone.id, routePath(path), cursor, state.main)
    : await readZoneRoute(zone.id, routePath(path), cursor);
  if (!read.ok && read.failure === 'missing') notFound();
  const kept = (href: string) => withPosition(href, choice);
  const home: SiteCrumb = { label: view.zone.name, href: kept(spaceHref(ref, 'site')) };
  const frame = (children: ReactNode, crumbs?: SiteCrumb[]) => (
    <RealmFrame
      view={view}
      tab={null}
      locale={locale}
      search={search}
      address={address}
      crumbs={crumbs}
    >
      {children}
    </RealmFrame>
  );
  if (!read.ok) return frame(failure(read.failure, siteHref(locale, ref, path), view.messages));
  const route: ZoneRouteRead = read.data;
  const mountName = (segment: string) => {
    const mount = view.mounts.find((item) => item.segment === segment);
    return mount ? zoneText(mount.name) : null;
  };
  switch (route.kind) {
    case 'home':
      return SiteHomeRoute(communityProps);
    case 'document': {
      const id = idOf(route.resource.id);
      if (!id) notFound();
      const [work, workMessages] = await Promise.all([
        loadWork(id, locale),
        getMessages('workPage', locale),
      ]);
      if (!work.ok)
        return frame(<DocumentUnavailable messages={view.messages} workMessages={workMessages} />);
      const text = await readText(
        work.header.mainVersion,
        work.header.selectedLanguage ?? undefined,
      );
      const crumbs = [home, { label: zoneText(work.header.title), href: null }];
      if (!text.ok)
        return frame(
          text.failure === 'missing' ? (
            <PageNotAvailable messages={view.messages} />
          ) : (
            <DocumentUnavailable messages={view.messages} workMessages={workMessages} />
          ),
          crumbs,
        );
      return frame(
        <DocumentPage work={work.header} text={text.data} messages={workMessages} />,
        crumbs,
      );
    }
    case 'index': {
      const name = mountName(route.mount.segment) ?? zoneContentText(route.mount.segment);
      const card = cardRenderer(
        view.zone,
        view.pkg,
        locale,
        view.zoneMessages,
        view.reader.avatarQuery,
      );
      const members = await readMembers(site, route.mount.segment, route.items, locale, state);
      const Slot = view.pkg?.slots.index;
      const arrange = Slot
        ? (works: ZoneWork[], grid: ReactNode) => (
            <SlotBoundary slot="index" fallback={grid}>
              <Slot
                zone={view.zone}
                works={works}
                fallback={grid}
                Link={LocalizedLink}
                {...workRenderers(card, locale, view.zoneMessages)}
              />
            </SlotBoundary>
          )
        : undefined;
      const MembersSlot = view.pkg?.slots.memberIndex;
      const arrangeMembers = MembersSlot
        ? (named: ZoneMember[], list: ReactNode) => (
            <SlotBoundary slot="memberIndex" fallback={list}>
              <MembersSlot
                zone={view.zone}
                members={named}
                mount={{ segment: route.mount.segment, name }}
                position={positionNote(state, siteHref(locale, ref, path), locale)}
                more={route.nextCursor !== null}
                fallback={list}
                Link={LocalizedLink}
              />
            </SlotBoundary>
          )
        : undefined;
      return frame(
        <IndexPage
          route={route}
          cursor={cursor}
          context={view.context}
          card={card}
          locale={locale}
          messages={view.messages}
          arrange={arrange}
          arrangeMembers={arrangeMembers}
          members={members}
          query={{ position: positionParam(choice) }}
          title={
            <span lang={name.lang || undefined} dir={name.dir}>
              {name.value}
            </span>
          }
        />,
        [home, { label: name, href: null }],
      );
    }
    case 'detail': {
      const id = idOf(route.resource.id);
      if (!id) notFound();
      const mount = route.mount
        ? {
            label: mountName(route.mount.segment) ?? zoneContentText(route.mount.segment),
            href: kept(spaceHref(ref, 'site', [route.mount.segment])),
          }
        : null;
      // What the page is comes from Main's page projection, which also answers 404 for a record not yet revealed.
      const projection = await readEntityProjection(id, state?.main);
      if (!projection.ok) {
        if (projection.failure === 'missing') notFound();
        return frame(failure(projection.failure, siteHref(locale, ref, path), view.messages), [
          home,
          ...(mount ? [mount] : []),
          { label: zoneContentText(shortId(id)), href: null },
        ]);
      }
      if (projection.data.target.base === 'work') {
        const tab = workTabOf(route.tab);
        const work = await loadWork(id, locale);
        const title = work.ok ? zoneText(work.header.title) : zoneContentText(shortId(id));
        const base = workBase(ref, id, route.mount?.segment ?? null, view.context.realm);
        base.path = spaceHref(ref, 'site', route.tab ? path.slice(0, -1) : path);
        return frame(
          <ZoneWorkPage base={base} tab={tab} search={search} locale={locale} pkg={view.pkg} />,
          [home, ...(mount ? [mount] : []), { label: title, href: null }],
        );
      }
      const summary = projection.data.summary;
      const chapter =
        state && projection.data.target.base === 'occurrence'
          ? occurrenceName(state, route.resource.id, locale)
          : null;
      const title =
        chapter ??
        (summary.status === 'available' ? zoneText(summary.name) : zoneContentText(shortId(id)));
      return frame(
        <ZoneEntityPage
          view={view}
          id={id}
          projection={projection.data}
          locale={locale}
          search={search}
          site={site}
          state={state}
          mount={route.mount?.segment ?? null}
          path={spaceHref(ref, 'site', path)}
        />,
        [home, ...(mount ? [mount] : []), { label: title, href: null }],
      );
    }
  }
}

/** A site without a community uses only its Zone reads and the common renderer.
 * It has no membership, Realm modules or invented Realm authority. */
async function standaloneSite(
  resolved: Extract<SiteResolution, { kind: 'site' }>,
  locale: import('../../i18n/define.ts').UiLocale,
  path: readonly string[],
  search: Search,
): Promise<ReactNode> {
  const [route, presentation, messages, workMessages, jar, incoming] = await Promise.all([
    readZoneRoute(resolved.zone, routePath(path), routeCursor(path, search)),
    readPresentation(resolved.zone),
    getMessages('realm', locale),
    getMessages('workPage', locale),
    cookies(),
    headers(),
  ]);
  if (!route.ok && route.failure === 'missing') notFound();
  if (!route.ok || !presentation.ok)
    return failure(
      'unavailable',
      siteHref(locale, addressKey(resolved.address.canonical), path),
      messages,
    );
  const ref = addressKey(resolved.address.canonical);
  const zone: ZoneContext = {
    slug: presentation.data.official,
    realm: null,
    name: zoneContentText(
      route.data.name ?? resolved.address.canonical.suffixSource,
      route.data.language,
    ),
    description: null,
    icon: null,
    hero: null,
    tokens: presentation.data.presentation.tokens,
    locale,
    links: {
      home: siteHref(locale, ref, []),
      browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']),
      discussions: '',
      decisions: '',
      about: '',
    },
  };
  const theme = zoneTheme(zone.tokens, {
    reader: parseTheme(jar.get(THEME_COOKIE)?.value),
    enabled: true,
  });
  const mounts = presentation.data.navigation;
  const frame = (children: ReactNode) => (
    <ZoneFrame
      zone={zone}
      dataZone={resolved.zone}
      theme={theme}
      pkg={null}
      nonce={incoming.get(ZONE_NONCE_HEADER) ?? undefined}
      members={null}
      actions={null}
      masthead={<ZoneMasthead zone={zone} members={null} actions={null} />}
      tabs={null}
      site={{
        label: zone.name.value,
        links: [
          { href: siteHref(locale, ref, []), label: zoneContentText(messages.home, locale) },
          ...mounts.map((mount) => ({
            href: siteHref(locale, ref, [mount.segment]),
            label: zoneText(mount.name),
          })),
        ],
      }}
    >
      {children}
    </ZoneFrame>
  );
  const read = route.data;
  if (read.kind === 'home')
    return frame(
      <PageContainer>
        <MemberList
          members={mounts.map((mount) => ({
            id: mount.target,
            href: siteHref(locale, ref, [mount.segment]),
            name: zoneText(mount.name),
            kind: null,
          }))}
        />
      </PageContainer>,
    );
  if (read.kind === 'index')
    return frame(
      <PageContainer className="grid gap-6">
        <MemberList
          members={read.items.map((item) => ({
            id: item.id,
            kind: null,
            name: zoneText('title' in item ? item.title : item.name),
            href: zoneMemberHref(
              ref,
              read.mount.segment,
              siteMemberTarget(
                item.id,
                'address' in item
                  ? (item.address as import('@rezics/model/address').CanonicalAddress)
                  : undefined,
              ),
            ),
          }))}
        />
        <Pager
          next={read.nextCursor ? siteHref(locale, ref, path, { cursor: read.nextCursor }) : null}
          first={parseCursor(search) ? siteHref(locale, ref, path) : null}
          messages={messages}
        />
      </PageContainer>,
    );
  const id = idOf(read.resource.id);
  if (!id) notFound();
  if (read.kind === 'document') {
    const work = await loadWork(id, locale);
    if (!work.ok)
      return frame(<DocumentUnavailable messages={messages} workMessages={workMessages} />);
    const text = await readText(work.header.mainVersion, work.header.selectedLanguage ?? undefined);
    return frame(
      text.ok ? (
        <DocumentPage work={work.header} text={text.data} messages={workMessages} />
      ) : (
        <DocumentUnavailable messages={messages} workMessages={workMessages} />
      ),
    );
  }
  return frame(<EntityPage resource={id} locale={locale} cursors={{}} />);
}
