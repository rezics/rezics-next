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
  readCompletePresentation,
  readZoneRoute,
  realmFrameReads,
  resolveRealm,
  resolveSite,
  type RealmReadClient,
  type SiteResolution,
} from '../realm/read.ts';
import { parseCursor, siteHref } from '../realm/route.ts';
import { RealmBrowseRoute, SiteHomeRoute } from '../realm/routes.tsx';
import { RealmUnavailable as RealmUnavailableContent } from '../realm/states.tsx';
import type { ReadFailure, ZonePresentationRead, ZoneRouteRead } from '../realm/types.ts';
import { ListFailure, Pager } from '../realm/views.tsx';
import { shownZoneFailure, zoneFailureView } from './failure.ts';
import { PageContainer } from '../shell/page.tsx';
import { pageUrl, representationPath } from '../seo/address.ts';
import { anonymousWorkTitle, workPageMetadata } from '../seo/work.ts';
import { readEntityProjection } from '../entity-page/read.ts';
import { readMembers } from '../wiki/members.ts';
import { continuityParam } from '../wiki/continuity.ts';
import { positionParam } from '../wiki/position.ts';
import { readingSelection } from '../wiki/selection.ts';
import { readPositionedRoute } from '../wiki/read.ts';
import { occurrenceName, positionNote } from '../wiki/state.ts';
import { keepReading, type ZoneSite } from '../wiki/links.ts';
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
import type { SiteMountCut, SitePresentationCut } from './site-cuts.ts';
import { MemberList } from './site-pages.tsx';
import { ZoneEditSiteLink } from '../zone-editor/edit-site-link.tsx';
import { showcaseEditorOpen, ZoneEditLink } from '../zone-editor/edit-link.tsx';
import { ZoneSiteRecordedCredit } from './zone-site-recorded-page.tsx';
import { mapZoneSiteHome, zoneSiteRouteMissing } from './zone-site-recorded-page.ts';
import { ZoneHomeContent } from '../zone-editor/home-content.tsx';
import { independentZoneContext, independentZoneHomeBoundary, readIndependentZoneHome } from './independent-zone-recorded-page.ts';
import {
  independentZoneFrameModel,
  independentZoneHomeBody,
  independentZoneSiteFrame,
} from './independent-zone-recorded-page-view.tsx';
import type { ZoneContext, ZoneTokens } from '@rezics/zone-sdk';
import { cookies, headers } from 'next/headers';
import { parseTheme, THEME_COOKIE } from '../shell/preferences.ts';
import { ZONE_NONCE_HEADER } from './csp.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { readSession } from '../auth/session.ts';
import { ZoneAboutDiscussion } from './about-discussion-entry.tsx';
import { setServerDocumentStatus } from '../api/server-read.ts';

// /{locale}/z/{space}/… has one optional catch-all, including home. Main's
// route table decides which mount or member a path names; community tabs cannot shadow it.

type Search = Record<string, string | string[] | undefined>;
export interface ZoneSiteProps {
  params: Promise<{ locale: string; space: string; path?: string[] }>;
  searchParams: Promise<Search>;
}

const routePath = (path: readonly string[]) => path.length === 1 && path[0] === 'browse' ? 'browse' : `/${path.join('/')}`;
/** `cursor` pages a mount's own index; below the mount it belongs to a Work's tabs. */
const routeCursor = (path: readonly string[], search: Search) =>
  path.length === 1 ? parseCursor(search) : undefined;

/** Search and link-preview metadata: a Work's own (pointing at `/w/{id}`), or a mounted page's (its own address). */
export async function zoneSiteMetadata({ params, searchParams }: ZoneSiteProps): Promise<Metadata> {
  const props = { params, searchParams };
  const { locale, space, path = [] } = await params;
  const metadata = !path.length && isUiLocale(locale)
    ? await siteHomeMetadata(space, locale) : await siteContentMetadata(props);
  if (!isUiLocale(locale)) return metadata;
  const resolved = await resolveSite(space, locale);
  if (resolved.kind === 'join')
    return { title: resolved.page.name.value, robots: { index: false }, referrer: 'no-referrer' };
  if (resolved.kind !== 'site') return metadata;
  if (!resolved.realm) return metadata;
  const realm = await resolveRealm(space, locale, 'site');
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

/** Home metadata and body select the same complete publication. An unused
 * generic root route cannot decide this page's title or availability. */
async function siteHomeMetadata(space: string, locale: import('../../i18n/define.ts').UiLocale): Promise<Metadata> {
  const [resolved, { t }] = await Promise.all([resolveSite(space, locale), getTranslation('realm', [locale])]);
  const hidden = { robots: { index: false } };
  if (resolved.kind !== 'site')
    return { title: resolved.kind === 'unavailable' ? t.unavailableTitle : t.notFoundTitle, ...hidden };
  const publication = await readCompletePresentation(resolved.zone);
  if (!publication.ok)
    return { title: publication.failure === 'missing' ? t.notFoundTitle : t.unavailableTitle, ...hidden };
  const page = await pageUrl();
  return { title: resolved.address.canonical.suffixSource,
    ...(page ? { alternates: { canonical: page.origin + representationPath(page) } } : {}) };
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
  // A mounted Work's title is published only as Main shows it to anyone; a private Work is named by its Zone.
  if (route.kind === 'document')
    return address((work && (await anonymousWorkTitle(work))) || zone);
  // A page that is not a Work's depends on the reader's position, so it is not indexed.
  if (!work || work.kind !== 'work') return { title: zone, ...hidden };
  const tab = route.tab === null ? 'overview' : (route.tab as WorkTab);
  const { scope: _scope, realm: _realm, ...rest } = search;
  const title = await anonymousWorkTitle(work);
  // A Work that is not public to everyone gives no title and no preview, whatever the reader may see.
  if (!title) return { ...(await workPageMetadata(work, { tab }, rest, locale)), title: zone };
  return { ...(await workPageMetadata(work, { tab }, rest, locale)), ...(await address(title)) };
}

/** A read made as the signed-in reader can also fail on their identity; to the page that is the Zone being unavailable. */
function failure(
  reason: ReadFailure | 'identity' | 'sign-in',
  firstPage: string,
  messages: RealmMessages,
  reference?: string,
) {
  const shown = zoneFailureView(reason, reference);
  if (!shown) return null;
  return (
    <PageContainer>
      <ListFailure failure={shown.failure} reference={shown.reference} messages={messages} firstPage={firstPage} />
    </PageContainer>
  );
}

function unavailableDocument(reason: ReadFailure | 'sign-in' = 'unavailable'): void {
  // Only the route decision replacing the whole page owns its HTTP status.
  // Optional metadata, mounted regions and client reads cannot set it.
  if (reason === 'unavailable' || reason === 'offline') setServerDocumentStatus(503);
}

/** This server view is selected only when the Site's authoritative read
 * replaces its whole page. The existing client view keeps contextual refresh. */
function RealmUnavailable(props: Parameters<typeof RealmUnavailableContent>[0]) {
  unavailableDocument(props.failure);
  return <>
    <RealmUnavailableContent {...props} />
    <PageContainer><LocalizedLink href="/discover">{props.messages.browse}</LocalizedLink></PageContainer>
  </>;
}

export async function ZoneSiteRoute({ params, searchParams }: ZoneSiteProps, client?: RealmReadClient): Promise<ReactNode> {
  const [{ locale, space, path = [] }, search] = await Promise.all([params, searchParams]);
  if (!isUiLocale(locale)) notFound();
  // A story passes the replaying client. Production omits it and keeps the request-cached host client.
  const replay = client ? realmFrameReads({
    keepProblem: false,
    main: client.main,
    personal: client.personal ?? client.main,
    actingSubject: client.actingSubject,
  }) : null;
  const resolved = replay ? await replay.resolveSite(space, locale) : await resolveSite(space, locale);
  if (resolved.kind === 'missing') notFound();
  if (resolved.kind === 'unavailable')
    return <RealmUnavailable messages={await getMessages('realm', locale)} failure={resolved.failure}
      reference={resolved.reference} />;
  if (resolved.kind === 'join')
    return privateJoinPage(resolved.page, locale, siteHref(locale, space, path));
  if (!resolved.realm) return standaloneSite(resolved, locale, path, search, space, client);
  const communityProps = {
    params: Promise.resolve({ locale, realm: space }),
    searchParams: Promise.resolve(search),
  };
  if (!path.length) {
    const homeView = await loadRealmView(space, locale, search, 'site');
    if (homeView.kind === 'unavailable')
      return <RealmUnavailable messages={await getMessages('realm', locale)} failure={homeView.failure}
        reference={homeView.reference} />;
    if (homeView.kind === 'join') return privateJoinPage(homeView.page, locale, siteHref(locale, space, path));
    if (homeView.kind !== 'view' || !homeView.publication) notFound();
    const mapped = mapZoneSiteHome(homeView.publication);
    if (mapped.kind === 'published') {
      return <RealmFrame view={homeView} tab={null} locale={locale} search={search}
        address={siteHref(locale, homeView.context.ref, path)}>
        <ZoneHomeContent page={mapped.page} presentation={homeView.presentation}
          moduleData={homeView.publication.moduleData}
          slideMedia={homeView.slideMedia} context={homeView.context} zone={homeView.zone}
          pkg={homeView.pkg} messages={homeView.zoneMessages} />
        {mapped.credit ? <ZoneSiteRecordedCredit credit={mapped.credit} locale={locale} /> : null}
      </RealmFrame>;
    }
    return SiteHomeRoute(communityProps, async () => homeView);
  }
  if (path.length === 1 && path[0] === 'browse') {
    // Resolve mounts before the starter Browse renderer, so a mount named browse is never shadowed.
    const routed = replay
      ? await replay.readZoneRoute(resolved.zone, routePath(path), routeCursor(path, search))
      : await readZoneRoute(resolved.zone, routePath(path), routeCursor(path, search));
    if (!routed.ok && routed.status === 404 && routed.failure === 'missing') {
      return RealmBrowseRoute(communityProps, undefined, client);
    }
  }
  const view = await loadRealmView(space, locale, search, 'site');
  if (view.kind === 'missing') notFound();
  if (view.kind === 'unavailable')
    return <RealmUnavailable messages={await getMessages('realm', locale)} failure={view.failure}
      reference={view.reference} />;
  if (view.kind === 'join')
    return privateJoinPage(view.page, locale, siteHref(locale, space, path));
  const zone = view.realm.zone;
  if (!zone) notFound();
  const { ref } = view.context;
  const cursor = routeCursor(path, search);
  // A Zone whose package reads at the reader's position sends it with every read, as the signed-in reader, whether or
  // not the package's presentation runs (safe mode and the standard look keep the reader's position).
  const { choice, state, reading } = await readingSelection(view.data, zone.id, search);
  const site: ZoneSite = {
    zone: zone.id,
    ref,
    segments: view.mounts.map((mount) => mount.segment),
    choice,
    main: state?.main,
    ...(reading ? { continuity: { choice: reading.choice, fallback: reading.fallback } } : {}),
  };
  const address = siteHref(locale, ref, path, { cursor, position: positionParam(choice) });
  const read = state
    ? await readPositionedRoute(zone.id, routePath(path), cursor, state.main)
    : await readZoneRoute(zone.id, routePath(path), cursor);
  if (!read.ok && read.failure === 'missing') notFound();
  const kept = (href: string) => keepReading(site, href);
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
  if (!read.ok) return frame(failure(read.failure === 'pending' ? 'unavailable' : read.failure, siteHref(locale, ref, path), view.messages,
    'reference' in read ? read.reference : undefined));
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
        <DocumentPage work={work.header} text={text.data} messages={workMessages}
          discussion={<ZoneAboutDiscussion zone={zone.id} path={routePath(path)}
            href={spaceHref(ref, 'site', path)} locale={locale} />} />,
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
          query={{
            position: positionParam(choice),
            continuity: reading ? continuityParam(reading.choice, reading.fallback) : undefined,
          }}
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
        return frame(failure(projection.failure === 'pending' ? 'unavailable' : projection.failure, siteHref(locale, ref, path), view.messages), [
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
          <ZoneWorkPage base={base} tab={tab} search={search} locale={locale} pkg={view.pkg} zone={view.zone} />,
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
  space: string,
  client?: RealmReadClient,
): Promise<ReactNode> {
  if (!path.length) return publishedIndependentZoneHome(resolved, locale, space, client);
  const [route, presentation, messages, workMessages] = await Promise.all([
    readZoneRoute(resolved.zone, routePath(path), routeCursor(path, search)),
    readCompletePresentation(resolved.zone),
    getMessages('realm', locale),
    getMessages('workPage', locale),
  ]);
  if (route && zoneSiteRouteMissing(route)) notFound();
  if (route && !route.ok || !presentation.ok) {
    const shown = shownZoneFailure(route ?? { ok: true }, presentation);
    return shown
      ? failure(shown.failure, siteHref(locale, addressKey(resolved.address.canonical), path), messages, shown.reference)
      : null;
  }
  const { zone, ref } = independentZoneContext(presentation.data, resolved.address.canonical, locale);
  const frame = (children: ReactNode) => <StandaloneZoneSiteFrame zone={zone} zoneId={resolved.zone} address={ref}
    locale={locale} messages={messages} presentation={presentation.data}>{children}</StandaloneZoneSiteFrame>;
  if (!route.ok) notFound();
  const read = route.data;
  if (read.kind === 'home') notFound();
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
  const discussion = <ZoneAboutDiscussion zone={resolved.zone} path={routePath(path)}
    href={spaceHref(ref, 'site', path)} locale={locale} />;
  const id = idOf(read.resource.id);
  if (!id) notFound();
  if (read.kind === 'document') {
    const work = await loadWork(id, locale);
    if (!work.ok)
      return frame(<DocumentUnavailable messages={messages} workMessages={workMessages} />);
    const text = await readText(work.header.mainVersion, work.header.selectedLanguage ?? undefined);
    return frame(
      text.ok ? (
        <DocumentPage work={work.header} text={text.data} messages={workMessages} discussion={discussion} />
      ) : (
        <DocumentUnavailable messages={messages} workMessages={workMessages} />
      ),
    );
  }
  return frame(<PageContainer className="max-w-4xl [text-autospace:normal]">
    <EntityPage resource={id} locale={locale} cursors={{}} frame={false} />
    {discussion}
  </PageContainer>);
}

/** The common standalone Zone frame used by its public site and the editor's saved preview. */
export async function StandaloneZoneSiteFrame({ zone, zoneId, address, locale, messages, presentation, siteMounts, siteTokens,
  siteNavigation, children }: {
  zone: ZoneContext;
  zoneId: string;
  address: string;
  locale: import('../../i18n/define.ts').UiLocale;
  messages: RealmMessages;
  presentation: ZonePresentationRead;
  siteMounts?: readonly SiteMountCut[];
  siteTokens?: ZoneTokens;
  siteNavigation?: SitePresentationCut['navigation'];
  children: ReactNode;
}) {
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const model = independentZoneFrameModel(presentation, zone, zoneId, address, locale, messages.home,
    parseTheme(jar.get(THEME_COOKIE)?.value), { mounts: siteMounts, tokens: siteTokens, navigation: siteNavigation });
  const actions = <ZoneEditLink zoneId={zoneId} space={address} locale={locale} />;
  return independentZoneSiteFrame(model, incoming.get(ZONE_NONCE_HEADER) ?? undefined, actions, children);
}

/** Published home. The same supplied-client visit a recorded story runs, with the host's cached readers. */
async function publishedIndependentZoneHome(
  resolved: Extract<SiteResolution, { kind: 'site' }>,
  locale: import('../../i18n/define.ts').UiLocale,
  space: string,
  client?: RealmReadClient,
): Promise<ReactNode> {
  const [session, messages, zoneMessages] = await Promise.all([
    client ? null : readSession(),
    getMessages('realm', locale),
    getMessages('zones', locale),
  ]);
  const actingSubject = client?.actingSubject ?? (session?.agent.status === 'selected' ? session.agent.agent.iri : undefined);
  const token = actingSubject && !client ? (await cookies()).get(ACCESS_COOKIE)?.value : undefined;
  const visit = await readIndependentZoneHome(independentZoneHomeBoundary(client ? {
    main: client.main, personal: client.personal, actingSubject, editorClient: client.personal,
  } : {
    production: { resolveSite, readCompletePresentation },
    actingSubject,
    editorOpen: actingSubject ? async (zoneId, subject) => {
      const loaded = await showcaseEditorOpen(zoneId, subject, token);
      return loaded.ok ? { ok: true } : { ok: false, failure: loaded.failure, problem: null };
    } : null,
  }), { space, locale, actingSubject });
  if (visit.kind === 'unavailable') {
    unavailableDocument(visit.failure);
    const shown = shownZoneFailure({ ok: true }, { ok: false, failure: visit.failure, ...(visit.reference ? { reference: visit.reference } : {}) });
    return shown
      ? failure(shown.failure, siteHref(locale, addressKey(resolved.address.canonical), []), messages, shown.reference)
      : null;
  }
  if (visit.kind !== 'published' && visit.kind !== 'empty') notFound();
  if (client) return independentZoneSiteFrame(independentZoneFrameModel(visit.presentation, visit.zone,
    visit.zoneId, visit.ref, locale, messages.home, parseTheme(undefined)), undefined,
    visit.editor?.ok ? <ZoneEditSiteLink space={visit.ref}>{(await getMessages('manage', locale)).editSite}</ZoneEditSiteLink> : null,
    independentZoneHomeBody({ mapped: visit.mapped, presentation: visit.presentation, zone: visit.zone,
      zoneId: visit.zoneId, ref: visit.ref, locale, messages: zoneMessages }));
  return <StandaloneZoneSiteFrame zone={visit.zone} zoneId={visit.zoneId} address={visit.ref} locale={locale}
    messages={messages} presentation={visit.presentation}>
    {independentZoneHomeBody({
      mapped: visit.mapped, presentation: visit.presentation, zone: visit.zone, zoneId: visit.zoneId,
      ref: visit.ref, locale, messages: zoneMessages,
    })}
  </StandaloneZoneSiteFrame>;
}
