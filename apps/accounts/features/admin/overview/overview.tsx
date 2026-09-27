'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ArrowRightIcon, BanIcon, CircleCheckIcon, KeyRoundIcon, LoaderIcon, MailWarningIcon, ShieldAlertIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import type { Overview as OverviewData, QueueUser } from '../api/types.ts';
import { Actor, actionLabel, reasonLabel, Target, userHref } from '../audit/entry.tsx';
import { count as formatCount, DateOnly, Time } from '../format.tsx';
import { PageHeading } from '../shell/admin-states.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { useLocale, useTranslation } from '../../../i18n/client.ts';

type Queue = OverviewData['suspended'];

function QueueCard({ title, body, icon, queue, href, detail, tone }: { title: string; body: string; icon: ReactNode;
  queue: Queue; href?: string; detail(user: QueueUser): ReactNode; tone: 'destructive' | 'warning' | 'info' }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
  const empty = queue.count === 0;
  const shown = formatCount(queue.count, locale);
  const headingId = useId();
  return <section aria-labelledby={headingId} className="flex flex-col rounded-3xl border border-border/60 bg-card shadow-(--aura-shadow-card)">
    <header className="flex items-start gap-3 px-5 pt-5">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-2xl', empty ? 'bg-success/10 text-success-foreground'
        : tone === 'destructive' ? 'bg-destructive/10 text-destructive-foreground' : tone === 'warning'
          ? 'bg-warning/10 text-warning-foreground' : 'bg-info/10 text-info-foreground')}>
        {empty ? <CircleCheckIcon className="size-5" aria-hidden="true" /> : icon}</span>
      <div className="min-w-0 flex-1">
        <h2 id={headingId} className="font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <p className="text-3xl font-semibold tabular-nums"><span className="sr-only">{title}: </span>
        {queue.capped ? t.queues.capped({ count: shown }) : shown}</p>
    </header>
    {empty ? <p className="px-5 pt-4 pb-5 text-sm text-muted-foreground">{t.queues.nothing}</p> : <ul className="mt-3 divide-y divide-border/60">
      {queue.users.map(user => <li key={user.id}>
        <a href={userHref(user.id)} className="flex items-center gap-3 px-5 py-2.5 outline-none hover:bg-accent/40 focus-visible:bg-accent/60">
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{user.name || user.email}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span></span>
          <span className="shrink-0 text-end text-xs text-muted-foreground">{detail(user)}</span>
        </a></li>)}
    </ul>}
    {href && !empty ? <div className="mt-auto border-t border-border/60 px-5 py-3">
      <Button asChild variant="link" size="sm" className="h-auto px-0"><a href={href}>{t.queues.viewAll}
        <ArrowRightIcon aria-hidden="true" /></a></Button></div> : null}
  </section>;
}

export function Overview({ data }: { data: OverviewData }) {
  const { t } = useTranslation('admin');
  const { can } = useAdmin();
  const users = (query: string) => `/admin/users?q=${encodeURIComponent(query)}`;
  return <>
    <PageHeading title={t.overview} intro={t.overviewIntro} />
    <div className="grid gap-4 md:grid-cols-2 group-data-[density=compact]/admin:gap-3">
      <QueueCard title={t.queues.suspended} body={t.queues.suspendedBody} tone="destructive"
        icon={<BanIcon className="size-5" aria-hidden="true" />} queue={data.suspended} href={users('status:suspended')}
        detail={user => <>
          {user.reasonCode ? <Badge variant="outline" size="sm" className="mb-0.5">{reasonLabel(user.reasonCode, t)}</Badge> : null}
          <span className="block">{user.until ? <>{t.queues.until} <DateOnly iso={user.until} /></> : t.queues.indefinite}</span></>} />
      <QueueCard title={t.queues.reset} body={t.queues.resetBody} tone="warning"
        icon={<KeyRoundIcon className="size-5" aria-hidden="true" />} queue={data.passwordResetRequired} href={users('status:reset')}
        detail={user => <>{user.reasonCode ? <span className="block">{reasonLabel(user.reasonCode, t)}</span> : null}
          <Time iso={user.since} /></>} />
      <QueueCard title={t.queues.unverified} body={t.queues.unverifiedBody} tone="info"
        icon={<MailWarningIcon className="size-5" aria-hidden="true" />} queue={data.unverified} href={users('verified:no')}
        detail={user => <Time iso={user.since} />} />
      <QueueCard title={t.queues.failed} body={t.queues.failedBody} tone="warning"
        icon={<ShieldAlertIcon className="size-5" aria-hidden="true" />} queue={data.failedSignIns}
        detail={user => <><span className="block font-medium text-foreground">{t.queues.failedCount(user.count ?? 0)}</span>
          <Time iso={user.since} /></>} />
    </div>
    <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {data.recentActions && can('audit:read') ? <section aria-labelledby="recent-actions"
        className="rounded-3xl border border-border/60 bg-card shadow-(--aura-shadow-card)">
        <header className="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
          <h2 id="recent-actions" className="font-semibold">{t.recentActions}</h2>
          <Button asChild variant="link" size="sm" className="h-auto px-0"><a href="/admin/audit">{t.openAuditLog}
            <ArrowRightIcon aria-hidden="true" /></a></Button>
        </header>
        {data.recentActions.length ? <ol className="divide-y divide-border/60">
          {data.recentActions.map(entry => <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-5 py-2.5 text-sm">
            <Actor entry={entry} /><span className="text-muted-foreground">{actionLabel(entry.action, t)}</span>
            <Target entry={entry} />
            {entry.reasonCode ? <Badge variant="outline" size="sm">{reasonLabel(entry.reasonCode, t)}</Badge> : null}
            <Time iso={entry.occurredAt} className="ms-auto text-xs text-muted-foreground" />
          </li>)}
        </ol> : <p className="px-5 pb-5 text-sm text-muted-foreground">{t.recentActionsEmpty}</p>}
      </section> : null}
      {data.jobs.length ? <section aria-labelledby="your-jobs" className="rounded-3xl border border-border/60 bg-card shadow-(--aura-shadow-card)">
        <h2 id="your-jobs" className="px-5 pt-5 pb-2 font-semibold">{t.yourJobs}</h2>
        <ul className="divide-y divide-border/60">
          {data.jobs.map(job => <li key={job.id} className="flex flex-col gap-0.5 px-5 py-2.5 text-sm">
            <span className="flex items-center gap-2"><span className="font-medium">{actionLabel(job.action, t)}</span>
              <Badge variant="outline" size="sm">{reasonLabel(job.reasonCode, t)}</Badge>
              <Time iso={job.createdAt} className="ms-auto text-xs text-muted-foreground" /></span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {job.finishedAt ? null : <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {job.finishedAt ? t.jobResult({ succeeded: job.succeeded, skipped: job.skipped, failed: job.failed })
                : t.jobProgress({ done: job.total - job.pending, total: job.total })}</span>
          </li>)}
        </ul>
      </section> : null}
    </div>
  </>;
}
