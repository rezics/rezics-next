import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ClockIcon, ShieldCheckIcon, SirenIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { relativeTime } from './format.ts';
import type { ManageMessages } from './messages.ts';
import { ManageFailure, Named, Thumb } from './parts.tsx';
import { positionOf } from './permissions.ts';
import { ActingAs } from './realm-frame.tsx';
import { realmHref } from './routes.ts';
import { SITE_SAFETY_PATH } from './safety-state.ts';
import { type Loaded, type ManagedRealm, type RealmHeader } from './types.ts';

/** A managed Realm as the list shows it: Main's permissions and counts, its public name, and its Manage address. */
export interface ManagedSummary { realm: ManagedRealm; header: RealmHeader | null; address: string }
export interface ManagedList { items: ManagedSummary[]; nextCursor: string | null }

const positions = { owner: 'positionOwner', moderator: 'positionModerator', reviewer: 'positionReviewer',
  manager: 'positionManager' } as const;

/** One Realm at a glance: your place in it, what waits for you, what was escalated, and when it last moved. */
function RealmCard({ summary, now, locale, messages }: { summary: ManagedSummary; now: number; locale: UiLocale;
  messages: ManageMessages }) {
  const t = materializeData(messages, { locale });
  const { realm, header, address } = summary;
  const name = header?.name.value ?? t.realmFallback({ id: address.slice(0, 8) });
  const open = realm.openCount.value;
  const escalated = realm.escalatedCount.value;
  const waiting = realm.openCount.kind === 'exact' ? open ? t.waiting(open) : t.nothingWaiting
    : t.waitingAtLeast({ count: String(open) });
  return <li className="grid content-start gap-4 rounded-2xl border border-border/60 bg-card p-5">
    <div className="flex min-w-0 items-center gap-3">
      <Thumb image={header?.icon ?? null} label={name} fallbackKey={realm.realm} />
      <div className="min-w-0">
        <h3 className="truncate font-semibold">{header ? <Named name={header.name} /> : name}</h3>
        <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
          <ShieldCheckIcon aria-hidden="true" className="size-3.5" />{t[positions[positionOf(realm.permissions)]]}</p>
      </div>
    </div>
    <div className="grid gap-1.5 text-sm">
      <p className={cn('font-medium', open ? 'text-foreground' : 'text-muted-foreground')}>{waiting}</p>
      {escalated ? <p className="flex items-center gap-2 text-warning-foreground">
        <SirenIcon aria-hidden="true" className="size-4" />{t.escalated(escalated)}</p> : null}
      {realm.latestActivity ? <p className="flex items-center gap-2 text-muted-foreground">
        <ClockIcon aria-hidden="true" className="size-4" />
        {t.lastActivity({ time: relativeTime(realm.latestActivity, now, locale) })}</p> : null}
    </div>
    {/* The list names a role, not a Zone the agent may edit. Edit site is on the Realm frame. */}
    <div className="flex flex-wrap gap-2">
      <LocalizedLink href={realmHref(address)} aria-label={t.openRealmQueue({ realm: name })}
        className={cn(buttonVariants({ size: 'sm' }), 'justify-self-start')}>{t.openQueue}</LocalizedLink>
    </div>
  </li>;
}

/**
 * `/manage`: the Realms the acting Agent holds a role in (Main's
 * `GET /v1/me/managed-realms`), each with what waits for it. The navigation
 * opens the only one directly; this list is for people with several.
 */
export function ManageHome({ agent, realms, moreHref, now, locale, messages, signInHref, retryHref, platformSafety = false }: {
  agent: AgentOption; realms: Loaded<ManagedList>; moreHref: string | null; now: number; locale: UiLocale;
  messages: ManageMessages; signInHref?: string; retryHref?: string;
  /** Whether Main lets the acting Agent read the platform safety queue; only then is its entry shown. */
  platformSafety?: boolean;
}) {
  const t = materializeData(messages, { locale });
  return <PageContainer className="grid gap-10">
    <PageHeader title={t.title} description={t.description}
      actions={<ActingAs agent={agent} locale={locale} messages={messages} />} />
    {platformSafety ? <section aria-labelledby="manage-site" className="grid gap-3">
      <h2 id="manage-site" className="font-semibold text-lg tracking-tight">{t.siteTitle}</h2>
      <p className="max-w-2xl text-muted-foreground text-sm">{t.siteHelp}</p>
      <LocalizedLink href={SITE_SAFETY_PATH} className={cn(buttonVariants({ size: 'sm' }), 'justify-self-start')}>
        {t.siteOpen}</LocalizedLink>
    </section> : null}
    <section aria-labelledby="manage-realms" className="grid gap-4">
      <div className="space-y-1">
        <h2 id="manage-realms" className="font-semibold text-lg tracking-tight">{t.yourRealms}</h2>
        {realms.ok && realms.data.items.length ? <p className="text-muted-foreground text-sm">{t.yourRealmsHelp}</p> : null}
      </div>
      {!realms.ok ? <ManageFailure failure={realms.failure} locale={locale} messages={messages} headingLevel={3}
        signInHref={signInHref} retryHref={retryHref} />
        : realms.data.items.length ? <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {realms.data.items.map(summary => <RealmCard key={summary.realm.realm} summary={summary} now={now} locale={locale}
            messages={messages} />)}
        </ul> : <EmptyState icon={ShieldCheckIcon} title={t.noRealmsTitle} description={t.noRealmsHelp} headingLevel={3} />}
      {moreHref ? <LocalizedLink href={moreHref} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }),
        'justify-self-start')}>{t.moreRealms}</LocalizedLink> : null}
    </section>
  </PageContainer>;
}
