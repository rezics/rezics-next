import { direction } from '@rezics/main/language';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
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
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { signInPath } from '../auth/paths.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { sessionAgentState } from '../auth/session.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
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
import { type AdaptContext, mainExecution, zoneImage, zoneText } from './adapt.ts';
import { RealmBanPanel } from '../realm-appeal/panel.tsx';
import { readOwnRealmBan } from '../realm-appeal/read.ts';
import type { BanReading } from '../realm-appeal/reading.ts';
import { RealmMembership } from './membership.tsx';
import { type Membership, readMembership } from './membership-state.ts';
import type { RealmMessages } from './messages.ts';
import { readPresentation, type RealmResolution, resolveRealm } from './read.ts';
import type { ZoneMount, ZonePresentationRead } from './types.ts';
import { RealmTabs } from './realm-tabs.tsx';
import { type RealmTab, realmHref } from './route.ts';
import { siteHref, zoneNavigationHref } from './route.ts';
import { surfaceText } from '../address/messages.ts';
import type { RealmHeader } from './types.ts';
import { spaceHref } from '../address/path.ts';
import { PrivateSpaceJoinPage } from '../space-access/join-page.tsx';
import { UnlistedSpaceNotice } from '../space-access/unlisted-notice.tsx';
import { privateDiscovery, realmDiscovery } from '../address/space-read.ts';
import type { JoinPage } from '../manage/settings-api.ts';

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
  slideMedia: ZonePresentationRead['slideMedia'];
  execution: Execution;
  pkg: ZonePackage | null;
  /**
   * The package whose position and continuity declarations the reads follow: the running one, or, when the reader
   * switched presentation off (safe mode, the standard look), the same approved package read for data only.
   */
  data: ZoneData | null;
  zone: ZoneContext;
  context: AdaptContext;
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

export async function privateJoinPage(page: JoinPage, locale: UiLocale, here: string) {
  const reader = await realmReader();
  return (
    <PrivateSpaceJoinPage
      page={{ ...page, discovery: privateDiscovery(page.discovery) }}
      discoveryMetadata={false}
      locale={locale}
      actingSubject={reader.actingSubject ?? null}
      signInHref={signInPath(localizedPath(here, locale))}
    />
  );
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
): Promise<RealmView | Exclude<RealmResolution, { kind: 'realm' }>> {
  const [realm, messages, zoneMessages, jar, reader] = await Promise.all([
    resolveRealm(ref, locale),
    getMessages('realm', locale),
    getMessages('zones', locale),
    cookies(),
    realmReader(),
  ]);
  if (realm.kind !== 'realm') return realm;
  const [read, membership, ban] = await Promise.all([
    surface === 'site' && realm.zone ? readPresentation(realm.zone.id) : null,
    reader.actingSubject
      ? readMembership(reader.personal, realm.header.id, reader.actingSubject)
      : null,
    reader.actingSubject ? readOwnRealmBan(realm.header.id, reader.actingSubject) : null,
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
  const lookEnabled = zoneLookEnabled(jar.get(ZONE_LOOK_COOKIE)?.value);
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
      home: siteHref(locale, realm.ref, []),
      browse: siteHref(locale, realm.ref, ['browse']),
      works: siteHref(locale, realm.ref, ['browse']),
      discussions: realmHref(locale, realm.ref, 'discussions'),
      decisions: realmHref(locale, realm.ref, 'decisions'),
      about: realmHref(locale, realm.ref, 'about'),
    },
  };
  return {
    kind: 'view',
    realm,
    presentation,
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
      ref: realm.ref,
      realm: realm.realm,
      avatarQuery: reader.avatarQuery,
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
  children,
}: {
  view: RealmView;
  tab: RealmTab | null;
  locale: UiLocale;
  search: Search;
  children: ReactNode;
  address?: string;
  crumbs?: readonly SiteCrumb[];
}) {
  const [jar, request] = await Promise.all([cookies(), headers()]);
  const { realm, presentation, execution, pkg, data, zone, messages, zoneMessages, lookEnabled } = view;
  const site = tab === null;
  const theme = zoneTheme(presentation.tokens, {
    reader: parseTheme(jar.get(THEME_COOKIE)?.value),
    enabled: lookEnabled,
  });
  const members = membersText(realm.header.membership.count, locale, messages);
  const here = localizedPath(address ?? realmHref(locale, realm.ref, tab ?? 'home'), locale);
  // A Zone whose package reads at the reader's position in a story offers the choice on every page.
  const { state: positions, reading: continuity } = realm.zone
    ? await readingSelection(data, realm.zone.id, search)
    : { state: null, reading: null };
  // Join or Follow first, as every community page offers; the page style stays beside it.
  const actions = (
    <>
      <RealmMembership
        realm={realm.header.id}
        realmName={zone.name.value}
        initial={view.membership}
        signedIn={view.reader.signedIn}
        actingSubject={view.reader.actingSubject}
        signInHref={signInPath(here)}
        rulesHref={realmHref(locale, realm.ref, 'about')}
        locale={locale}
        messages={messages}
      />
      {realm.zone ? (
        <LocalizedLink
          href={site ? realmHref(locale, realm.ref) : siteHref(locale, realm.ref, [])}
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
        zone={zone}
        dataZone={zone.slug ?? realm.realm}
        theme={theme}
        pkg={pkg}
        nonce={request.get(ZONE_NONCE_HEADER) ?? undefined}
        actions={actions}
        members={members}
        masthead={<ZoneMasthead zone={zone} members={members} actions={actions} />}
        tabs={
          site ? null : (
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
          site
            ? {
                label: surfaceText.site[locale],
                links: [
                  {
                    href: siteHref(locale, realm.ref, []),
                    label: { value: messages.home, lang: locale, dir: direction(locale, messages.home) },
                  },
                  ...presentation.navigation.map((item) => ({
                    href: zoneNavigationHref(item.href, realm.ref),
                    label: { value: item.label, lang: locale, dir: direction(locale, item.label) },
                  })),
                  ...mountLinks(view),
                ].filter(
                  (link, index, links) =>
                    links.findIndex((other) => other.href === link.href) === index,
                ),
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
          {children}
        </ReaderActionsProvider>
      </ZoneFrame>
    </>
  );
}
