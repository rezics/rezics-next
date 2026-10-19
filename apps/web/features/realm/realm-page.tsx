import { buttonVariants } from '@rezics/ui/button';
import { copyOf as detailCopy } from '../entity-page/messages.ts';
import type { ZoneContext, ZonePackage, ZoneTokens } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import { cookies, headers } from 'next/headers';
import { cache, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { declaredData } from '../../zones/official/declared.ts';
import { installedDigest, loadPackage } from '../../zones/official/index.ts';
import { resolvePackage } from '../zones/package-source.ts';
import { readingSelection, type ZoneData } from '../wiki/selection.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { mainApiWithToken } from '../api/main.ts';
import { gateFor, parsePlatformAccess } from '../api/platform-access.ts';
import { readAddress } from '../address/client.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { signInPath } from '../auth/paths.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { sessionAgentState, sessionReadSubject, type MainSessionAgentState } from '../auth/session.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { CommunityContext } from './thread-rail.tsx';
import { parseTheme, THEME_COOKIE } from '../shell/preferences.ts';
import { ZONE_NONCE_HEADER } from '../zones/csp.ts';
import {
  decideExecution,
  type Execution,
  isSafeMode,
  ZONE_LOOK_COOKIE,
  zoneLookEnabled,
} from '../zones/execution.ts';
import { LookMenu } from '../zones/look-menu.tsx';
import type { ZoneMessages } from '../zones/messages.ts';
import { defaultPresentation, moduleTitle, type ZonePresentation } from '../zones/presentation.ts';
import { zoneTheme } from '../zones/theme.ts';
import type { SiteCrumb, SiteLink } from '../zones/site-navigation.tsx';
import { PositionBar } from '../wiki/position-bar.tsx';
import { withContinuity } from '../wiki/continuity.ts';
import { ExecutionNotice, ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import { savedSiteCuts, type SiteMountCut, type SitePresentationCut } from '../zones/site-cuts.ts';
import { mainExecution, zoneImage, zoneText } from './adapt.ts';
import { RealmBanPanel } from '../realm-appeal/panel.tsx';
import { readOwnRealmBan } from '../realm-appeal/read.ts';
import type { BanReading } from '../realm-appeal/reading.ts';
import { readMemberBan } from '../realm-appeal/ban-read.ts';
import { RealmMembership } from './membership.tsx';
import { type Membership, readMembership } from './membership-state.ts';
import type { RealmMessages } from './messages.ts';
import { readCompletePresentation, readRealmZone, realmFrameReads, type RealmReadClient, type RealmResolution, resolveRealm } from './read.ts';
import type { ZoneMount, ZonePresentationRead } from './types.ts';
import { RealmTabs } from './realm-tabs.tsx';
import { idOf, type RealmTab, realmHref, siteHref } from './route.ts';
import { surfaceText } from '../address/messages.ts';
import type { RealmHeader } from './types.ts';
import { addressKey, spaceHref } from '../address/path.ts';
import { RealmJoinPage } from './entry-page.tsx';
import { UnlistedSpaceNotice } from '../space-access/unlisted-notice.tsx';
import { readSpacePage, realmDiscovery } from '../address/space-read.ts';
import type { PublishedHomeContext } from '../zone-editor/home-modules.ts';
import type { JoinPage, SpaceAccessApi } from '../manage/settings-api.ts';
import type { MainClient } from '../discover/types.ts';

type Search = Record<string, string | string[] | undefined>;
type Resolved = Extract<RealmResolution, { kind: 'realm' }>;

/** The members line in words; an unknown count says nothing. */
export function membersText(
  count: RealmHeader['membership']['count'],
  locale: UiLocale,
  messages: RealmMessages,
): string | null {
  const t = materializeData(messages, { locale });
  if (count.kind === 'exact') return t.members(count.value);
  return count.kind === 'estimated' ? t.membersAbout(count.value) : null;
}

export interface RealmView {
  kind: 'view';
  realm: Resolved;
  presentation: ZonePresentation;
  /** The home, layout and resolved sources selected by one public publication read. */
  publication: ZonePresentationRead | null;
  slideMedia: ZonePresentationRead['slideMedia'];
  execution: Execution;
  pkg: ZonePackage | null;
  /**
   * The package whose position and continuity declarations the reads follow: the running one, or, when the reader
   * switched presentation off (safe mode, the standard look), the same approved package read for data only.
   */
  data: ZoneData | null;
  zone: ZoneContext;
  context: PublishedHomeContext;
  lookEnabled: boolean;
  /** Who reads: signed in or not, and the Agent their shelf controls act as. */
  reader: { signedIn: boolean; actingSubject: string | null; avatarQuery: string };
  /** The Zone's public mounts in its Structure's order; none for a Realm without a Zone site. */
  mounts: readonly ZoneMount[];
  /** The signed-in reader's membership and follow; null signed out. */
  membership: Membership | null;
  /** The signed-in member's own ban, when Main can tell them about it. */
  ban: BanReading | null;
  messages: RealmMessages;
  zoneMessages: ZoneMessages;
}

/**
 * Who reads, once per request: signed in or not, and the session Agent Main
 * keeps for this web session when it may act. Realm reads stay public; the
 * reader's token goes only to their own membership, follow and media reads.
 */
const realmReader = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible
    ? (state.sessionAgent.actingSubject ?? undefined)
    : undefined;
  return {
    signedIn: Boolean(token),
    actingSubject,
    personal: mainApiWithToken(actingSubject ? token : undefined),
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '',
  };
});

export async function privateJoinPage(page: JoinPage, locale: UiLocale, here: string, transport?: {
  /** Story replay. Production omits this and reads the request-cached session. */
  actingSubject?: string | null;
  api?: SpaceAccessApi;
}) {
  const actingSubject = transport ? transport.actingSubject ?? null : (await realmReader()).actingSubject ?? null;
  return <RealmJoinPage page={page} locale={locale} here={here} actingSubject={actingSubject}
    api={transport?.api} persist={!transport} />;
}

/**
 * Story replay for `loadRealmView`. Production omits it and keeps `resolveRealm`
 * plus the request-cached reader. `resolveRealm` does not accept a reader, so
 * this host follows that reader's order: the address, the anonymous header,
 * the session Person, then `readSpacePage`.
 */
export interface RealmReplay {
  fetch: typeof fetch;
  read: (path: string, personal?: boolean) => Promise<Response>;
  personal: MainClient;
  origin: string;
  /** False for the signed-out landing, which has no session read. */
  signedIn: boolean;
  token?: string;
  languages?: string;
}

type RealmReader = Awaited<ReturnType<typeof realmReader>>;

async function replaySubject(replay: RealmReplay): Promise<string | null> {
  const response = await replay.read('/v1/me/session-agent', true);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Recorded session agent failed: ${response.status}`);
  }
  return sessionReadSubject(await response.json() as MainSessionAgentState);
}

async function replayBan(realm: string, actingSubject: string, replay: RealmReplay): Promise<BanReading | null> {
  const access = await replay.read('/v1/me/platform-access', true);
  const held = access.ok ? parsePlatformAccess(await access.json()) : null;
  if (!access.ok) await access.body?.cancel();
  const read = await readMemberBan(replay.personal, realm, actingSubject, gateFor(held));
  return read.ok ? read.reading : null;
}

/**
 * The host learns the signed-in reader from the request cookie, then reads that
 * person's language preferences. A supplied client has no cookie, so it carries
 * the same two reads; the caller's acting person stays the one it already resolved.
 */
async function suppliedClientSession(client: RealmReadClient): Promise<void> {
  const actingSubject = client.actingSubject;
  if (!client.signedIn || !actingSubject) return;
  const personal = client.personal ?? client.main;
  // The route requires the session header. Replay matches the path, not that header.
  await personal.v1.me['session-agent'].get({ headers: { 'x-session-key': 'recorded-visit' } });
  await personal.v1.me['person-preferences'].get({ query: { actingSubject } });
}

/** Platform access and, only when that answer opens it, the reader's own ban. */
async function suppliedClientBan(client: RealmReadClient, realm: string, actingSubject: string): Promise<BanReading | null> {
  const personal = client.personal ?? client.main;
  const access = await personal.v1.me['platform-access'].get();
  const held = access.data ? parsePlatformAccess(access.data) : null;
  const read = await readMemberBan(personal, realm, actingSubject, gateFor(held));
  return read.ok ? read.reading : null;
}

/** The page's resolution, using the same readers production calls. */
async function replayRealm(ref: string, locale: UiLocale, replay: RealmReplay): Promise<RealmResolution> {
  const languages = replay.languages ?? locale;
  if (!replay.signedIn) {
    const page = await readSpacePage(ref, languages, { read: replay.read, origin: replay.origin });
    if (page.kind !== 'realm') return page;
    return { kind: 'realm', ref, realm: idOf(page.header.id) ?? ref, header: page.header, zone: null };
  }
  const address = await readAddress({ scope: 'space', key: ref }, languages, replay.origin, undefined, undefined, true, replay.fetch);
  if (address.kind !== 'resolved' && address.kind !== 'missing') {
    return address.kind === 'unavailable'
      ? { kind: 'unavailable', ...(address.failure ? { failure: address.failure } : {}) }
      : { kind: 'missing' };
  }
  const realm = address.kind === 'resolved' ? idOf(address.data.capabilities?.realm ?? '') : idOf(`https://rezics.com/id/${ref}`);
  if (!realm) return { kind: 'missing' };
  if (address.kind === 'resolved') {
    const anonymous = browserMainApi(replay.origin, { anonymous: true, fetcher: replay.fetch });
    const header = await anonymous.v1.realms({ realm }).get({ query: {} });
    if (header.data?.profile === 'realm-read-v1' && header.data.id === `https://rezics.com/id/${realm}`) {
      const zoneId = idOf(address.data.capabilities?.zone ?? '');
      return { kind: 'realm', ref: addressKey(address.data.canonical), realm, header: header.data,
        zone: zoneId ? { id: zoneId, segment: null } : null };
    }
    const status = header.error?.status ?? header.status ?? 0;
    if (![401, 403, 404].includes(status)) return { kind: 'unavailable' };
  }
  const actingSubject = await replaySubject(replay) ?? undefined;
  const page = await readSpacePage(ref, languages, {
    read: replay.read, origin: replay.origin, token: replay.token, actingSubject,
    ...(address.kind === 'resolved' ? { address: address.data } : {}),
  });
  if (page.kind !== 'realm') return page;
  const zoneId = address.kind === 'resolved' ? idOf(address.data.capabilities?.zone ?? '') : null;
  return {
    kind: 'realm', ref: address.kind === 'resolved' ? addressKey(address.data.canonical) : ref,
    realm: idOf(page.header.id) ?? realm, header: page.header,
    zone: zoneId ? { id: zoneId, segment: null } : null,
  };
}

/**
 * Everything a Realm tab renders around its content: the Realm, its Zone's
 * presentation (or the default layout), whether the official package runs
 * for this view, and the theme. Missing and unavailable Realms return their
 * resolution for the route to answer.
 */
export async function loadRealmView(
  ref: string,
  locale: UiLocale,
  search: Search,
  surface: 'community' | 'site' = 'community',
  host?: RealmReplay | RealmReadClient,
): Promise<RealmView | Exclude<RealmResolution, { kind: 'realm' }>> {
  // Membership stories pass their recorded transport. Browse stories pass the production clients.
  const replay = host && 'read' in host ? host : undefined;
  const client = host && 'main' in host ? host : undefined;
  const played = replay ? await replayRealm(ref, locale, replay) : null;
  if (played && played.kind !== 'realm') return played;
  const replayActor = replay?.signedIn ? await replaySubject(replay) : null;
  if (replay?.signedIn && replayActor) {
    const preferences = await replay.read(`/v1/me/person-preferences?actingSubject=${encodeURIComponent(replayActor)}`, true);
    await preferences.body?.cancel();
  }
  const hosted = client ? realmFrameReads({
    keepProblem: false,
    main: client.main,
    personal: client.personal ?? client.main,
    actingSubject: client.actingSubject,
    resolution: client.resolution,
  }) : null;
  const [resolved, messages, zoneMessages, jar, reader] = await Promise.all([
    played ?? (hosted ? hosted.resolveRealm(ref, locale, surface) : resolveRealm(ref, locale, surface)),
    getMessages('realm', locale),
    getMessages('zones', locale),
    replay ? null : client
      ? Promise.resolve({ get: () => undefined } as Awaited<ReturnType<typeof cookies>>)
      : cookies(),
    replay ? {
      signedIn: replay.signedIn,
      actingSubject: replayActor ?? undefined,
      personal: replay.personal,
      avatarQuery: replayActor ? `?actingSubject=${encodeURIComponent(replayActor)}` : '',
    } satisfies RealmReader : client ? {
      signedIn: client.signedIn,
      actingSubject: client.actingSubject,
      personal: client.personal ?? client.main,
      avatarQuery: client.actingSubject ? `?actingSubject=${encodeURIComponent(client.actingSubject)}` : '',
    } satisfies RealmReader : realmReader(),
    client?.signedIn && client.actingSubject ? suppliedClientSession(client) : null,
  ]);
  const frameReads = replay ? realmFrameReads({
    main: browserMainApi(replay.origin, { anonymous: true, fetcher: replay.fetch }),
    personal: replay.personal, actingSubject: reader.actingSubject,
  }) : hosted;
  const readAttachment = (realmId: string) => frameReads ? frameReads.readRealmZone(realmId) : readRealmZone(realmId);
  const readPublication = (zoneId: string) => frameReads
    ? frameReads.readCompletePresentation(zoneId) : readCompletePresentation(zoneId);
  if (resolved.kind !== 'realm') return resolved;
  let realm = resolved;
  // A Realm entry can lack Zone capability; its attachment supplies the site address.
  if (surface === 'community' || !realm.zone) {
    const attached = await readAttachment(realm.realm);
    if (attached.ok) {
      const zoneId = attached.data.zone.slice(-36);
      const publication = await readPublication(zoneId);
      const address = publication.ok && publication.data.address
        ? { ...publication.data.address, prefix: '/z/' as const } : null;
      if (publication.ok && publication.data.zone === attached.data.zone
        && publication.data.realm === realm.header.id && address
        && publication.data.address?.prefix === address.prefix) {
        realm = { ...realm, zone: { id: zoneId, segment: attached.data.routeSegment },
          siteRef: addressKey(address) };
      }
    }
  }
  const [read, membership, ban] = await Promise.all([
    surface === 'site' && realm.zone ? readPublication(realm.zone.id) : null,
    replay
      ? reader.actingSubject ? readMembership(replay.personal, realm.header.id, reader.actingSubject) : null
      : reader.actingSubject
        ? readMembership(reader.personal, realm.header.id, reader.actingSubject)
        : null,
    replay
      ? reader.actingSubject ? replayBan(idOf(realm.header.id) ?? realm.realm, reader.actingSubject, replay) : null
      : client && reader.actingSubject
        ? suppliedClientBan(client, realm.header.id, reader.actingSubject)
        : reader.actingSubject ? readOwnRealmBan(realm.header.id, reader.actingSubject) : null,
  ]);
  if (surface === 'site' && (!read || !read.ok)) {
    if (read && !read.ok && read.failure === 'missing') return { kind: 'missing' };
    return { kind: 'unavailable', ...(read && !read.ok
      ? { failure: read.failure, ...(read.reference ? { reference: read.reference } : {}) } : {}) };
  }
  // A Zone whose presentation cannot be read still renders its Realm with the default layout.
  const presentation: ZonePresentation = read?.ok
    ? {
        ...read.data.presentation,
        modules: read.data.presentation.modules.map(({ titles, tabs, ...module }) => ({
          ...module,
          title: moduleTitle({ title: module.title, titles }, locale),
          ...(tabs
            ? {
                tabs: tabs.map(({ labels, ...tab }) => ({
                  ...tab,
                  label: labels?.[locale] ?? tab.label,
                })),
              }
            : {}),
        })),
      }
    : defaultPresentation(zoneMessages);
  const slideMedia = read?.ok ? read.data.slideMedia : [];
  const lookEnabled = jar ? zoneLookEnabled(jar.get(ZONE_LOOK_COOKIE)?.value) : false;
  const main = read?.ok ? mainExecution(read.data) : null;
  const slug = read?.ok ? read.data.official : null;
  const approval = {
    main,
    slug,
    installedDigest: main?.approved && slug ? await installedDigest(slug) : null,
  };
  const decided = decideExecution({ ...approval, safeMode: isSafeMode(search), lookEnabled });
  const { execution, pkg, data } = await resolvePackage({
    decided,
    approval,
    surface,
    source: { load: loadPackage, declarations: declaredData },
  });
  const header = realm.header;
  const mounts = read?.ok ? read.data.navigation : [];
  const siteRef = realm.siteRef ?? (realm.zone ? realm.ref : null);
  const zone: ZoneContext = {
    slug,
    realm: header.id,
    name: zoneText(header.name),
    description: zoneText(header.description),
    icon: zoneImage(header.icon, reader.avatarQuery),
    hero: zoneImage(header.banner, reader.avatarQuery),
    tokens: presentation.tokens,
    locale,
    links: {
      home: siteRef ? siteHref(locale, siteRef, []) : '',
      browse: siteRef ? siteHref(locale, siteRef, ['browse']) : '',
      works: siteRef ? siteHref(locale, siteRef, ['browse']) : '',
      discussions: realmHref(locale, realm.ref, 'discussions'),
      decisions: realmHref(locale, realm.ref, 'decisions'),
      about: realmHref(locale, realm.ref, 'about'),
    },
  };
  return {
    kind: 'view',
    realm,
    presentation,
    publication: read?.ok ? read.data : null,
    slideMedia,
    execution,
    pkg,
    data,
    zone,
    lookEnabled,
    messages,
    zoneMessages,
    reader: {
      signedIn: reader.signedIn,
      actingSubject: reader.actingSubject ?? null,
      avatarQuery: reader.avatarQuery,
    },
    membership,
    ban,
    mounts,
    context: {
      locale,
      ref: surface === 'site' && siteRef ? siteRef : realm.ref,
      realm: realm.realm,
      avatarQuery: reader.avatarQuery,
      ...(read?.ok ? { publishedHome: { moduleData: read.data.moduleData, slideMedia: read.data.slideMedia } } : {}),
      ...(realm.zone && surface === 'site'
        ? {
            zone: realm.zone.id,
            mounts: new Map(mounts.map((mount) => [mount.target, mount.segment])),
          }
        : { unrouted: true }),
    },
  };
}

/** A mounted page's address and its name, as the Zone's navigation and breadcrumbs link to it. */
export function mountLinks(view: RealmView): SiteLink[] {
  return view.mounts.map((mount) => ({
    href: spaceHref(view.context.ref, 'site', [mount.segment]),
    label: zoneText(mount.name),
  }));
}

/** The fetch a replayed client already uses. Production omits the client and keeps the browser session. */
function replayFetch(client: RealmReadClient): typeof fetch | undefined {
  const carried = (client as RealmReadClient & { fetch?: typeof fetch }).fetch;
  return typeof carried === 'function' ? carried : undefined;
}

/**
 * The Zone frame around one Realm tab, or around a page of the Zone's own site, which names its `address`
 * and the `crumbs` from the Zone's home to it.
 */
export async function RealmFrame({
  view,
  tab,
  locale,
  search,
  address,
  crumbs,
  structuralPreview = false,
  siteMounts,
  siteTokens,
  siteNavigation,
  client,
  children,
  compactCommunity = false,
}: {
  view: RealmView;
  tab: RealmTab | null;
  locale: UiLocale;
  search: Search;
  children: ReactNode;
  address?: string;
  crumbs?: readonly SiteCrumb[];
  /** The editor preview always shows its saved structural theme, independent of a reader's standard-look choice. */
  structuralPreview?: boolean;
  /** The authorized editor read supplies saved mounts before a site publication exists. */
  siteMounts?: readonly SiteMountCut[];
  /** The authorized editor read supplies the saved structural tokens before publication. */
  siteTokens?: ZoneTokens;
  /** The authorized editor read supplies presentation links before publication. */
  siteNavigation?: SitePresentationCut['navigation'];
  /** Set when a story replays the frame. Production omits it and reads the request. */
  client?: RealmReadClient;
  /** A thread keeps community context compact, leaving its post as the page's subject. */
  compactCommunity?: boolean;
}) {
  const [jar, request] = client
    ? [{ get: () => undefined } as Awaited<ReturnType<typeof cookies>>, new Headers()] as const
    : await Promise.all([cookies(), headers()]);
  const { realm, presentation, execution, pkg, data, zone, messages, zoneMessages, lookEnabled } = view;
  const site = tab === null;
  const tokens = site && structuralPreview && siteTokens ? siteTokens : presentation.tokens;
  const frameZone = site && structuralPreview && siteTokens ? { ...zone, tokens: siteTokens } : zone;
  const siteCuts = site ? savedSiteCuts({ tokens, navigation: siteNavigation ?? presentation.navigation },
    siteMounts ?? view.mounts.map(mount => ({ segment: mount.segment, name: zoneText(mount.name) })),
    view.context.ref, locale, messages.home) : null;
  const theme = zoneTheme(siteCuts?.tokens ?? tokens, {
    reader: parseTheme(jar.get(THEME_COOKIE)?.value),
    enabled: structuralPreview || lookEnabled,
  });
  const members = membersText(realm.header.membership.count, locale, messages);
  const here = localizedPath(address ?? realmHref(locale, realm.ref, tab ?? 'home'), locale);
  // A Zone whose package reads at the reader's position in a story offers the choice on every page.
  const { state: positions, reading: continuity } = realm.zone
    ? await readingSelection(data, realm.zone.id, search)
    : { state: null, reading: null };
  // Join or Follow first, as every community page offers; the page style stays beside it.
  const detail = detailCopy(locale);
  const relationshipFetch = client ? replayFetch(client) : undefined;
  const actions = (
    <>
      <RealmMembership
        realm={realm.header.id}
        realmName={frameZone.name.value}
        reactionsLabel={detail.reactions} moreAccessibleLabel={detail.moreActions({ name: frameZone.name.value })}
        reports={[{ target: realm.header.id, kind: 'page', realm: realm.header.id }]}
        initial={view.membership}
        signedIn={view.reader.signedIn}
        actingSubject={view.reader.actingSubject}
        signInHref={signInPath(here)}
        rulesHref={realmHref(locale, realm.ref, 'about')}
        locale={locale}
        messages={messages}
        transport={relationshipFetch ? { fetch: relationshipFetch, origin: '' } : undefined}
      />
      {realm.zone ? (
        <LocalizedLink
          href={site ? realmHref(locale, realm.ref) : zone.links.home}
          className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
        >
          {site ? surfaceText.community[locale] : surfaceText.site[locale]}
        </LocalizedLink>
      ) : null}
      {site ? (
        <LookMenu
          enabled={lookEnabled}
          labels={{
            menu: zoneMessages.lookLabel,
            zone: zoneMessages.lookZone,
            standard: zoneMessages.lookStandard,
            help: zoneMessages.lookHelp,
            saveFailed: zoneMessages.lookSaveFailed,
          }}
        />
      ) : null}
    </>
  );
  const design = new URL(here, 'https://rezics.invalid');
  for (const [key, value] of Object.entries(search)) {
    design.searchParams.delete(key);
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
      design.searchParams.append(key, item);
  }
  design.searchParams.delete('safe');
  const showDesign = design.pathname + design.search + design.hash;
  const discovery = realmDiscovery(realm.header);
  return (
    <>
      <ZoneFrame
        zone={frameZone}
        dataZone={zone.slug ?? realm.realm}
        theme={theme}
        pkg={compactCommunity ? null : pkg}
        nonce={request.get(ZONE_NONCE_HEADER) ?? undefined}
        actions={actions}
        members={members}
        masthead={compactCommunity ? <CommunityContext name={frameZone.name}
          href={realmHref(locale, realm.ref, 'discussions')} actions={actions} />
          : <ZoneMasthead zone={frameZone} members={members} actions={actions}
            subject={{ locale, primary: <LocalizedLink href={realmHref(locale, realm.ref, 'discussions')}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}>{messages.discussions}</LocalizedLink> }} />}
        tabs={
          site || compactCommunity ? null : (
            <RealmTabs
              locale={locale}
              realmRef={realm.ref}
              label={messages.sections}
              navigation={[]}
              labels={{
                home: messages.home,
                browse: zoneMessages.browseTab,
                works: messages.works,
                discussions: messages.discussions,
                decisions: messages.decisions,
                about: messages.about,
              }}
            />
          )
        }
        site={
          siteCuts
            ? {
                label: surfaceText.site[locale],
                links: siteCuts.navigation,
              }
            : undefined
        }
        position={
          site && positions ? (
            <PositionBar
              state={positions}
              here={continuity ? withContinuity(here, continuity.choice, continuity.fallback) : here}
              locale={locale}
              continuity={continuity}
            />
          ) : undefined
        }
        crumbs={crumbs ? { label: messages.breadcrumbs, items: crumbs } : undefined}
        notice={
          <>
            <ExecutionNotice
              execution={execution}
              showDesignHref={showDesign}
              messages={zoneMessages}
            />
            {view.ban ? <RealmBanPanel reading={view.ban} realm={realm.header.id} locale={locale}
              messages={await getMessages('realmAppeal', locale)} /> : null}
            {realm.header.listing === 'unlisted' && discovery ? (
              <UnlistedSpaceNotice locale={locale} discovery={discovery} discoveryMetadata={false} />
            ) : null}
          </>
        }
      >
        {/* Shelf controls on every tile; signing in from one returns to this tab. */}
        <ReaderActionsProvider
          signedIn={view.reader.signedIn}
          actingSubject={view.reader.actingSubject}
          signInHref={signInPath(here)}
        >
          {compactCommunity ? children : <div data-primary-content>{children}</div>}
        </ReaderActionsProvider>
      </ZoneFrame>
    </>
  );
}
