import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import { cookies, headers } from 'next/headers';
import { cache, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { installedDigest, loadPackage } from '../../zones/official/index.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { signInPath } from '../auth/paths.ts';
import { sessionAgentState } from '../auth/session.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { parseTheme, THEME_COOKIE } from '../shell/preferences.ts';
import { ZONE_NONCE_HEADER } from '../zones/csp.ts';
import { decideExecution, type Execution, isSafeMode, ZONE_LOOK_COOKIE, zoneLookEnabled } from '../zones/execution.ts';
import { LookMenu } from '../zones/look-menu.tsx';
import type { ZoneMessages } from '../zones/messages.ts';
import { defaultPresentation, type ZonePresentation } from '../zones/presentation.ts';
import { zoneTheme } from '../zones/theme.ts';
import { ExecutionNotice, ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import { type AdaptContext, mainExecution, zoneImage, zoneText } from './adapt.ts';
import { RealmMembership } from './membership.tsx';
import { type Membership, readMembership } from './membership-state.ts';
import type { RealmMessages } from './messages.ts';
import { readPresentation, type RealmResolution, resolveRealm } from './read.ts';
import type { ZonePresentationRead } from './types.ts';
import { RealmTabs } from './realm-tabs.tsx';
import { type RealmTab, realmHref } from './route.ts';
import type { RealmHeader } from './types.ts';

type Search = Record<string, string | string[] | undefined>;
type Resolved = Extract<RealmResolution, { kind: 'realm' }>;

/** The members line in words; an unknown count says nothing. */
export function membersText(count: RealmHeader['membership']['count'], locale: UiLocale,
  messages: RealmMessages): string | null {
  const t = materializeData(messages, { locale });
  if (count.kind === 'exact') return t.members(count.value);
  return count.kind === 'estimated' ? t.membersAbout(count.value) : null;
}

export interface RealmView {
  kind: 'view';
  realm: Resolved;
  presentation: ZonePresentation;
  bannerMedia: ZonePresentationRead['bannerMedia'];
  execution: Execution;
  pkg: ZonePackage | null;
  zone: ZoneContext;
  context: AdaptContext;
  lookEnabled: boolean;
  /** Who reads: signed in or not, and the Agent their shelf controls act as. */
  reader: { signedIn: boolean; actingSubject: string | null; avatarQuery: string };
  /** The signed-in reader's membership and follow; null signed out. */
  membership: Membership | null;
  messages: RealmMessages;
  zoneMessages: ZoneMessages;
}

async function runnablePackage(execution: Execution): Promise<{ execution: Execution; pkg: ZonePackage | null }> {
  if (execution.mode !== 'package') return { execution, pkg: null };
  try {
    const pkg = await loadPackage(execution.slug);
    if (pkg) return { execution, pkg };
  } catch (error) {
    console.error(`Official Zone package ${execution.slug} failed to load; showing its fallback`, error);
  }
  return { execution: { mode: 'fallback', reason: 'load-failed' }, pkg: null };
}

/**
 * Who reads, once per request: signed in or not, and the session Agent Main
 * keeps for this web session when it may act. Realm reads stay public; the
 * reader's token goes only to their own membership, follow and media reads.
 */
const realmReader = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject ?? undefined : undefined;
  return { signedIn: Boolean(token), actingSubject, personal: mainApiWithToken(actingSubject ? token : undefined),
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '' };
});

/**
 * Everything a Realm tab renders around its content: the Realm, its Zone's
 * presentation (or the default layout), whether the official package runs
 * for this view, and the theme. Missing and unavailable Realms return their
 * resolution for the route to answer.
 */
export async function loadRealmView(ref: string, locale: UiLocale, search: Search):
  Promise<RealmView | Exclude<RealmResolution, { kind: 'realm' }>> {
  const [realm, messages, zoneMessages, jar, reader] = await Promise.all([resolveRealm(ref, locale),
    getMessages('realm', locale), getMessages('zones', locale), cookies(), realmReader()]);
  if (realm.kind !== 'realm') return realm;
  const [read, membership] = await Promise.all([realm.zone ? readPresentation(realm.zone.id) : null,
    reader.actingSubject ? readMembership(reader.personal, realm.header.id, reader.actingSubject) : null]);
  // A Zone whose presentation cannot be read still renders its Realm with the default layout.
  const presentation: ZonePresentation = read?.ok ? { ...read.data.presentation,
    modules: read.data.presentation.modules.map(({ titles, tabs, ...module }) => ({ ...module,
      title: titles?.[locale] ?? module.title,
      ...tabs ? { tabs: tabs.map(({ labels, ...tab }) => ({ ...tab, label: labels?.[locale] ?? tab.label })) } : {} })) }
    : defaultPresentation(zoneMessages);
  const bannerMedia = read?.ok ? read.data.bannerMedia : [];
  const lookEnabled = zoneLookEnabled(jar.get(ZONE_LOOK_COOKIE)?.value);
  const main = read?.ok ? mainExecution(read.data) : null;
  const slug = realm.zone?.segment ?? null;
  const decided = decideExecution({ main, slug, safeMode: isSafeMode(search), lookEnabled,
    installedDigest: main?.approved && slug ? await installedDigest(slug) : null });
  const { execution, pkg } = await runnablePackage(decided);
  const header = realm.header;
  const zone: ZoneContext = {
    slug, realm: header.id, name: zoneText(header.name), description: zoneText(header.description),
    icon: zoneImage(header.icon, reader.avatarQuery), hero: zoneImage(header.banner, reader.avatarQuery),
    tokens: presentation.tokens, locale,
    links: { home: realmHref(locale, ref), works: realmHref(locale, ref, 'works'),
      discussions: realmHref(locale, ref, 'discussions'), decisions: realmHref(locale, ref, 'decisions'),
      about: realmHref(locale, ref, 'about') },
  };
  return { kind: 'view', realm, presentation, bannerMedia, execution, pkg, zone, lookEnabled, messages, zoneMessages,
    reader: { signedIn: reader.signedIn, actingSubject: reader.actingSubject ?? null, avatarQuery: reader.avatarQuery },
    membership,
    context: { locale, ref, realm: realm.realm, avatarQuery: reader.avatarQuery } };
}

/** The Zone frame around one Realm tab. */
export async function RealmFrame({ view, tab, locale, search, children }: {
  view: RealmView; tab: RealmTab; locale: UiLocale; search: Search; children: ReactNode;
}) {
  const [jar, request] = await Promise.all([cookies(), headers()]);
  const { realm, presentation, execution, pkg, zone, messages, zoneMessages, lookEnabled } = view;
  const theme = zoneTheme(presentation.tokens, { reader: parseTheme(jar.get(THEME_COOKIE)?.value),
    enabled: lookEnabled });
  const members = membersText(realm.header.membership.count, locale, messages);
  const here = localizedPath(realmHref(locale, realm.ref, tab), locale);
  // Join or Follow first, as every community page offers; the page style stays beside it.
  const actions = <>
    <RealmMembership realm={realm.header.id} realmName={zone.name.value} initial={view.membership}
      signedIn={view.reader.signedIn} actingSubject={view.reader.actingSubject} signInHref={signInPath(here)}
      rulesHref={realmHref(locale, realm.ref, 'about')} locale={locale} messages={messages} />
    <LookMenu enabled={lookEnabled} labels={{ menu: zoneMessages.lookLabel,
      zone: zoneMessages.lookZone, standard: zoneMessages.lookStandard, help: zoneMessages.lookHelp,
      saveFailed: zoneMessages.lookSaveFailed }} />
  </>;
  const { safe: _, ...rest } = search;
  const showDesign = realmHref(locale, realm.ref, 'home', Object.fromEntries(Object.entries(rest)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
  return <ZoneFrame zone={zone} dataZone={zone.slug ?? realm.realm} theme={theme} pkg={pkg}
    nonce={request.get(ZONE_NONCE_HEADER) ?? undefined} actions={actions} members={members}
    masthead={<ZoneMasthead zone={zone} members={members} actions={actions} />}
    tabs={<RealmTabs locale={locale} realmRef={realm.ref} label={messages.sections} navigation={presentation.navigation}
      labels={{ home: messages.home, works: messages.works, discussions: messages.discussions,
        decisions: messages.decisions, about: messages.about }} />}
    notice={<ExecutionNotice execution={execution} showDesignHref={showDesign} messages={zoneMessages} />}>
    {/* Shelf controls on every tile; signing in from one returns to this tab. */}
    <ReaderActionsProvider signedIn={view.reader.signedIn} actingSubject={view.reader.actingSubject}
      signInHref={signInPath(here)}>{children}</ReaderActionsProvider>
  </ZoneFrame>;
}
