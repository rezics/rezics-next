import { direction } from '@rezics/main/language';
import type { ZoneBrowseEntry, ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import { LibraryBigIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { NO_PLATFORM_ACCESS, type PlatformAccess } from '../api/platform-access.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import type { Execution } from '../zones/execution.ts';
import { LookMenu } from '../zones/look-menu.tsx';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { type ReaderTheme, zoneTheme } from '../zones/theme.ts';
import { ExecutionNotice, ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import { type PlacedModule, ZoneHome } from '../zones/zone-home.tsx';
import { type MembershipActions, RealmMembership } from './membership.tsx';
import type { Membership } from './membership-state.ts';
import { realmMessagesFor } from './catalog.ts';
export { realmMessagesFor } from './catalog.ts';
import { RealmTabs } from './realm-tabs.tsx';
import { siteHref } from './route.ts';

/**
 * A Realm page as `RealmFrame` composes it on the server, from story data:
 * the Zone frame, its masthead (or the package header), the tabs and either
 * the Zone home or a tab's content.
 */
export function RealmPageStory({ zone, modules = [], pkg = null, execution = { mode: 'fallback', reason: 'none-approved' },
  look = true, reader = 'light', members = null, navigation = [], membership = null,
  membershipActions = { kind: 'signed-out', signInHref: '/auth/start' }, browse, position, locale, children, site = false,
  platformAccess = NO_PLATFORM_ACCESS, realmRef }: {
  zone: ZoneContext; modules?: readonly PlacedModule[]; pkg?: ZonePackage | null; execution?: Execution;
  look?: boolean; reader?: ReaderTheme; members?: string | null;
  navigation?: readonly { label: string; href: string }[];
  /** The reader's membership; signed out by default, as a first visit. */
  membership?: Membership | null; membershipActions?: MembershipActions;
  /** The search and filters the home leads with. */
  browse?: ZoneBrowseEntry;
  /** The position control of a Zone that reads at the reader's place in a story. */
  position?: ReactNode;
  locale: UiLocale; children?: ReactNode; site?: boolean;
  /** The address resolved by a page story's reader, when it differs from the package slug. */
  realmRef?: string;
  /** The host's resolved access read; browser stories cannot execute request-backed server cards. */
  platformAccess?: PlatformAccess | null;
}) {
  const zoneMessages = zoneMessagesFor(locale);
  const messages = realmMessagesFor(locale);
  const theme = zoneTheme(zone.tokens, { reader, enabled: look });
  const ref = realmRef ?? zone.slug ?? 'classics';
  const actions = <>
    {zone.realm ? <RealmMembership realm={zone.realm} realmName={zone.name.value} initial={membership}
      signedIn={membershipActions.kind !== 'signed-out'} signInHref="/auth/start" rulesHref={zone.links.about}
      actions={membershipActions} locale={locale} messages={messages} /> : null}
    <LookMenu enabled={look} labels={{ menu: zoneMessages.lookLabel, zone: zoneMessages.lookZone,
      standard: zoneMessages.lookStandard, help: zoneMessages.lookHelp,
      saveFailed: zoneMessages.lookSaveFailed }} />
  </>;
  return <ZoneFrame zone={zone} dataZone={zone.slug ?? 'classics'} theme={theme} pkg={pkg} actions={actions}
    members={members} masthead={<ZoneMasthead zone={zone} members={members} actions={actions} />}
    tabs={site ? null : <RealmTabs locale={locale} realmRef={ref} label={messages.sections} navigation={navigation}
      labels={{ home: messages.home, browse: zoneMessages.browseTab, works: messages.works,
        discussions: messages.discussions,
        decisions: messages.decisions, about: messages.about }} />}
    site={site ? { label: zoneMessages.browseTab, links: [
      { href: siteHref(locale, ref, []), label: { value: messages.home, lang: locale, dir: direction(locale, messages.home) } },
      { href: siteHref(locale, ref, ['browse']), label: { value: zoneMessages.browseTab, lang: locale, dir: direction(locale, zoneMessages.browseTab) } },
    ] } : undefined}
    position={position}
    notice={<ExecutionNotice execution={execution} showDesignHref={zone.links.home} messages={zoneMessages} />}>
    {/* Signed out, as a first visit: shelf controls lead to sign-in. */}
    <ReaderActionsProvider signedIn={false} signInHref="/auth/start">
      {children ?? <ZoneHome modules={modules} zone={zone} pkg={pkg} locale={locale} messages={zoneMessages}
        browse={browse} slotAccess={platformAccess}
        empty={<EmptyState icon={LibraryBigIcon} title={messages.emptyHomeTitle} description={messages.emptyHomeBody} />} />}
    </ReaderActionsProvider>
  </ZoneFrame>;
}
