import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { installedDigest, loadPackage } from '../../zones/official/index.ts';
import { parseTheme, THEME_COOKIE } from '../shell/preferences.ts';
import { ZONE_NONCE_HEADER } from '../zones/csp.ts';
import { decideExecution, type Execution, isSafeMode, ZONE_LOOK_COOKIE, zoneLookEnabled } from '../zones/execution.ts';
import { LookMenu } from '../zones/look-menu.tsx';
import type { ZoneMessages } from '../zones/messages.ts';
import { defaultPresentation, type ZonePresentation } from '../zones/presentation.ts';
import { zoneTheme } from '../zones/theme.ts';
import { ExecutionNotice, ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import { type AdaptContext, mainExecution, zoneImage, zoneText } from './adapt.ts';
import type { RealmMessages } from './messages.ts';
import { readPresentation, type RealmResolution, resolveRealm } from './read.ts';
import { RealmTabs } from './realm-tabs.tsx';
import { realmHref } from './route.ts';
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
  execution: Execution;
  pkg: ZonePackage | null;
  zone: ZoneContext;
  context: AdaptContext;
  lookEnabled: boolean;
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
 * Everything a Realm tab renders around its content: the Realm, its Zone's
 * presentation (or the default layout), whether the official package runs
 * for this view, and the theme. Missing and unavailable Realms return their
 * resolution for the route to answer.
 */
export async function loadRealmView(ref: string, locale: UiLocale, search: Search):
  Promise<RealmView | Exclude<RealmResolution, { kind: 'realm' }>> {
  const [realm, messages, zoneMessages, jar] = await Promise.all([resolveRealm(ref, locale),
    getMessages('realm', locale), getMessages('zones', locale), cookies()]);
  if (realm.kind !== 'realm') return realm;
  const read = realm.zone ? await readPresentation(realm.zone.id) : null;
  // A Zone whose presentation cannot be read still renders its Realm with the default layout.
  const presentation: ZonePresentation = read?.ok ? read.data.presentation : defaultPresentation(zoneMessages);
  const lookEnabled = zoneLookEnabled(jar.get(ZONE_LOOK_COOKIE)?.value);
  const main = read?.ok ? mainExecution(read.data) : null;
  const slug = realm.zone?.segment ?? null;
  const decided = decideExecution({ main, slug, safeMode: isSafeMode(search), lookEnabled,
    installedDigest: main?.approved && slug ? await installedDigest(slug) : null });
  const { execution, pkg } = await runnablePackage(decided);
  const header = realm.header;
  const zone: ZoneContext = {
    slug, realm: header.id, name: zoneText(header.name), description: zoneText(header.description),
    icon: zoneImage(header.icon), hero: zoneImage(header.banner), tokens: presentation.tokens, locale,
    links: { home: realmHref(locale, ref), works: realmHref(locale, ref, 'works'),
      discussions: realmHref(locale, ref, 'discussions'), decisions: realmHref(locale, ref, 'decisions'),
      about: realmHref(locale, ref, 'about') },
  };
  return { kind: 'view', realm, presentation, execution, pkg, zone, lookEnabled, messages, zoneMessages,
    context: { locale, ref, realm: realm.realm } };
}

/** The Zone frame around one Realm tab. */
export async function RealmFrame({ view, locale, search, children }: {
  view: RealmView; locale: UiLocale; search: Search; children: ReactNode;
}) {
  const [jar, request] = await Promise.all([cookies(), headers()]);
  const { realm, presentation, execution, pkg, zone, messages, zoneMessages, lookEnabled } = view;
  const theme = zoneTheme(presentation.tokens, { reader: parseTheme(jar.get(THEME_COOKIE)?.value),
    enabled: lookEnabled });
  const members = membersText(realm.header.membership.count, locale, messages);
  const actions = <LookMenu enabled={lookEnabled} labels={{ menu: zoneMessages.lookLabel,
    zone: zoneMessages.lookZone, standard: zoneMessages.lookStandard, help: zoneMessages.lookHelp }} />;
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
    {children}
  </ZoneFrame>;
}
