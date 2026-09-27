import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ClockIcon, CompassIcon, SirenIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { relativeTime } from './format.ts';
import type { ManageMessages } from './messages.ts';
import { Named, Thumb } from './parts.tsx';
import { ActingAs } from './realm-frame.tsx';
import { RealmFinder } from './realm-finder.tsx';
import { ForgetRealm } from './remember.tsx';
import { realmHref } from './routes.ts';
import type { Loaded, ModerationPage, RealmDirectoryPage, RealmHeader } from './types.ts';

export interface RealmSummary { realm: string; header: RealmHeader | null; queue: Loaded<ModerationPage> }

/** One Realm at a glance: what is waiting, what was escalated, and how long the oldest item has waited. */
function RealmCard({ summary, now, locale, messages }: { summary: RealmSummary; now: number; locale: UiLocale;
  messages: ManageMessages }) {
  const t = materializeData(messages, { locale });
  const { realm, header, queue } = summary;
  const name = header?.name.value ?? t.realmFallback({ id: realm.slice(0, 8) });
  const items = queue.ok ? queue.data.items : [];
  const escalated = items.filter(item => item.escalation).length;
  const oldest = items[0]?.openedAt;
  const waiting = !queue.ok ? null : queue.data.nextCursor ? t.waitingAtLeast({ count: String(items.length) })
    : items.length ? t.waiting(items.length) : t.nothingWaiting;
  return <li className="grid content-start gap-4 rounded-2xl border border-border/60 bg-card p-5">
    <div className="flex min-w-0 items-center gap-3">
      <Thumb image={header?.icon ?? null} label={name} fallbackKey={realm} />
      <h3 className="min-w-0 truncate font-semibold">{header ? <Named name={header.name} /> : name}</h3>
    </div>
    {queue.ok ? <div className="grid gap-1.5 text-sm">
      <p className={cn('font-medium', items.length ? 'text-foreground' : 'text-muted-foreground')}>{waiting}</p>
      {escalated ? <p className="flex items-center gap-2 text-warning-foreground">
        <SirenIcon aria-hidden="true" className="size-4" />{t.escalated(escalated)}</p> : null}
      {oldest ? <p className="flex items-center gap-2 text-muted-foreground">
        <ClockIcon aria-hidden="true" className="size-4" />{t.oldestWaiting({ time: relativeTime(oldest, now, locale) })}</p>
        : null}
    </div> : <p className="text-muted-foreground text-sm">
      {queue.failure === 'denied' ? t.noLongerManaged : t.realmUnavailable}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {!queue.ok && queue.failure === 'denied' ? null
        : <LocalizedLink href={realmHref(realm)} className={buttonVariants({ size: 'sm' })}>{t.openQueue}</LocalizedLink>}
      <ForgetRealm realm={realm} label={t.forget} name={t.forgetRealm({ realm: name })} />
    </div>
  </li>;
}

/** `/manage`: the Realms this person manages from this device, each with its queue at a glance. */
export function ManageHome({ agent, realms, query, results, now, locale, messages }: {
  agent: AgentOption; realms: readonly RealmSummary[]; query: string; results: Loaded<RealmDirectoryPage> | null;
  now: number; locale: UiLocale; messages: ManageMessages;
}) {
  const t = materializeData(messages, { locale });
  return <PageContainer className="grid gap-10">
    <PageHeader title={t.title} description={t.description}
      actions={<ActingAs agent={agent} locale={locale} messages={messages} />} />
    <section aria-labelledby="manage-realms" className="grid gap-4">
      <div className="space-y-1">
        <h2 id="manage-realms" className="font-semibold text-lg tracking-tight">{t.yourRealms}</h2>
        {realms.length ? <p className="text-muted-foreground text-sm">{t.yourRealmsHelp}</p> : null}
      </div>
      {realms.length ? <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {realms.map(summary => <RealmCard key={summary.realm} summary={summary} now={now} locale={locale}
          messages={messages} />)}
      </ul> : <EmptyState icon={CompassIcon} title={t.noRealmsTitle} description={t.noRealmsHelp} headingLevel={3} />}
    </section>
    <RealmFinder query={query} results={results} locale={locale} messages={messages} />
  </PageContainer>;
}
