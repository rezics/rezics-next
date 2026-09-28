'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ArrowRightIcon, BanIcon, CircleCheckIcon, KeyRoundIcon, LoaderIcon, MailWarningIcon, ShieldCheckIcon } from 'lucide-react';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { Overview as OverviewData, QueueUser, Signal } from '../api/types.ts';
import { JobDialog } from '../actions/action-dialog.tsx';
import { Actor, actionLabel, reasonLabel, Target, userHref } from '../audit/entry.tsx';
import { count as formatCount, DateOnly, Time } from '../format.tsx';
import { ReviewDialog, reviewPermission, SignalRow } from '../signals/signal.tsx';
import { PageHeading } from '../shell/admin-states.tsx';
import { useAdmin } from '../shell/admin-context.tsx';
import { usePageKeys } from '../shell/keys.ts';
import { useLocale, useTranslation } from '../../../i18n/client.ts';

type Queue = OverviewData['suspended'];
type JobSummary = OverviewData['jobs'][number];
const card = 'rounded-3xl border border-border/60 bg-card shadow-(--aura-shadow-card)';

/** A work queue: its count (capped counts say so) and the first users in it. */
function QueueCard({ title, body, icon, queue, href, detail, tone }: { title: string; body: string; icon: ReactNode;
  queue: Queue; href: string; detail(user: QueueUser): ReactNode; tone: 'destructive' | 'warning' | 'info' }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
  const empty = queue.count === 0;
  const shown = formatCount(queue.count, locale);
  const headingId = useId();
  return <section aria-labelledby={headingId} className={cn(card, 'flex flex-col')}>
    <header className="flex items-start gap-3 px-5 pt-4">
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', empty ? 'bg-success/10 text-success-foreground'
        : tone === 'destructive' ? 'bg-destructive/10 text-destructive-foreground' : tone === 'warning'
          ? 'bg-warning/10 text-warning-foreground' : 'bg-info/10 text-info-foreground')}>
        {empty ? <CircleCheckIcon className="size-4.5" aria-hidden="true" /> : icon}</span>
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{body}</p>
      </div>
      <p className="text-2xl font-semibold tabular-nums"><span className="sr-only">{title}: </span>
        {queue.capped ? t.queues.capped({ count: shown }) : shown}</p>
    </header>
    {empty ? <p className="px-5 pt-3 pb-4 text-sm text-muted-foreground">{t.queues.nothing}</p> : <ul className="mt-2 divide-y divide-border/60">
      {queue.users.slice(0, 3).map(user => <li key={user.id}>
        <a href={userHref(user.id)} className="flex items-center gap-3 px-5 py-2 outline-none hover:bg-accent/40 focus-visible:bg-accent/60">
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{user.name || user.email}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span></span>
          <span className="shrink-0 text-end text-xs text-muted-foreground">{detail(user)}</span>
        </a></li>)}
    </ul>}
    {!empty ? <div className="mt-auto border-t border-border/60 px-5 py-2.5">
      <Button asChild variant="link" size="sm" className="h-auto px-0"><a href={href}>{t.queues.viewAll}
        <ArrowRightIcon aria-hidden="true" /></a></Button></div> : null}
  </section>;
}

/** The signals to review, severe first; j/k move between them (Enter opens one), r reviews. */
function NeedsReview({ initial }: { initial: OverviewData['signals'] }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { can } = useAdmin();
  const [signals, setSignals] = useState(initial);
  const [active, setActive] = useState(-1);
  const [reviewing, setReviewing] = useState<Signal | null>(null);
  const total = Object.values(signals.counts).reduce((sum, kind) => sum + kind.count, 0);
  const capped = Object.values(signals.counts).some(kind => kind.capped);
  const focus = (index: number) => {
    setActive(index);
    document.querySelector<HTMLAnchorElement>(`[data-signal-link="${index}"]`)?.focus();
  };
  usePageKeys(event => {
    const items = signals.items;
    if (!items.length || reviewing) return false;
    if (event.key === 'j') { focus(Math.min(items.length - 1, active + 1)); return true; }
    if (event.key === 'k') { focus(Math.max(0, active - 1)); return true; }
    const signal = items[active];
    if (!signal) return false;
    if (event.key === 'r' && can(reviewPermission[signal.kind])) { setReviewing(signal); return true; }
    return false;
  });
  const done = useCallback((signal: Signal) => {
    setReviewing(null);
    setSignals(current => ({ ...current, items: current.items.filter(item => item.key !== signal.key),
      reviewedLastDay: current.reviewedLastDay + 1 }));
    // The counts and any signal the cap held back come from a fresh read.
    void api.signals().then(result => { if (result.ok) setSignals(result.data); });
  }, [api]);
  const heading = useId();
  return <section aria-labelledby={heading} className={cn(card, signals.items.length ? 'border-destructive/20' : null)}>
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-5 pb-3">
      <h2 id={heading} className="text-lg font-semibold">{t.signals.title}</h2>
      {total ? <Badge variant="destructive" size="sm" pill>{capped ? t.queues.capped({ count: String(total) }) : t.signals.count(total)}</Badge> : null}
      <p className="basis-full text-sm text-muted-foreground">{t.signals.intro}</p>
    </header>
    {signals.items.length ? <ul className="divide-y divide-border/60 border-t border-border/60" aria-label={t.signals.title}>
      {signals.items.map((signal, index) => <SignalRow key={signal.key} signal={signal} rowIndex={index} active={index === active}
        onReview={setReviewing} />)}
    </ul> : <div className="flex items-start gap-3 border-t border-border/60 px-5 py-5">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-success/10 text-success-foreground">
        <ShieldCheckIcon className="size-4.5" aria-hidden="true" /></span>
      <div><p className="font-medium">{t.signals.allClear}</p><p className="text-sm text-muted-foreground">{t.signals.allClearBody}</p></div>
    </div>}
    {signals.reviewedLastDay ? <p className="flex flex-wrap items-center gap-2 border-t border-border/60 px-5 py-2.5 text-sm text-muted-foreground">
      {t.signals.reviewedLastDay(signals.reviewedLastDay)}
      {can('audit:read') ? <Button asChild variant="link" size="sm" className="h-auto px-0">
        <a href="/admin/audit?action=signal_reviewed&range=24h">{t.signals.seeReviews}</a></Button> : null}
    </p> : null}
    {reviewing ? <ReviewDialog signal={reviewing} onClose={() => setReviewing(null)} onDone={done} /> : null}
  </section>;
}

/** The operator's own recent bulk actions; one still waiting or running can be undone or stopped. */
function Jobs({ jobs }: { jobs: JobSummary[] }) {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState<JobSummary | null>(null);
  return <section aria-labelledby="your-jobs" className={card}>
    <h2 id="your-jobs" className="px-5 pt-5 pb-2 font-semibold">{t.yourJobs}</h2>
    <ul className="divide-y divide-border/60">
      {jobs.map(job => <li key={job.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{actionLabel(job.action, t)}</span>
            <Badge variant="outline" size="sm">{reasonLabel(job.reasonCode, t)}</Badge></span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {job.finishedAt ? null : <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {job.cancelledAt ? t.undo.stoppedSummary({ done: job.succeeded + job.skipped + job.failed, cancelled: job.cancelled })
              : job.finishedAt ? t.jobResult({ succeeded: job.succeeded, skipped: job.skipped, failed: job.failed })
                : Date.parse(job.startsAt) > Date.now() ? t.undo.scheduled : t.jobProgress({ done: job.total - job.pending, total: job.total })}
            <span aria-hidden="true">·</span><Time iso={job.createdAt} /></span>
        </div>
        <Button size="sm" variant={job.finishedAt ? 'ghost' : 'outline'} onClick={() => setOpen(job)}>
          {job.finishedAt ? t.undo.results : t.undo.manage}</Button>
      </li>)}
    </ul>
    {open ? <JobDialog jobId={open.id} action={open.action} count={open.total} onClose={() => setOpen(null)} /> : null}
  </section>;
}

export function Overview({ data }: { data: OverviewData }) {
  const { t } = useTranslation('admin');
  const { can } = useAdmin();
  const users = (query: string) => `/admin/users?q=${encodeURIComponent(query)}`;
  return <>
    <PageHeading title={t.overview} intro={t.overviewIntro} />
    <div className="flex flex-col gap-6 group-data-[density=compact]/admin:gap-4">
      <NeedsReview initial={data.signals} />
      <section aria-labelledby="queues">
        <h2 id="queues" className="mb-3 font-semibold">{t.queuesTitle}</h2>
        <div className="grid gap-4 md:grid-cols-3 group-data-[density=compact]/admin:gap-3">
          <QueueCard title={t.queues.suspended} body={t.queues.suspendedBody} tone="destructive"
            icon={<BanIcon className="size-4.5" aria-hidden="true" />} queue={data.suspended} href={users('status:suspended')}
            detail={user => <>
              {user.reasonCode ? <Badge variant="outline" size="sm" className="mb-0.5">{reasonLabel(user.reasonCode, t)}</Badge> : null}
              <span className="block">{user.until ? <>{t.queues.until} <DateOnly iso={user.until} /></> : t.queues.indefinite}</span></>} />
          <QueueCard title={t.queues.reset} body={t.queues.resetBody} tone="warning"
            icon={<KeyRoundIcon className="size-4.5" aria-hidden="true" />} queue={data.passwordResetRequired} href={users('status:reset')}
            detail={user => <>{user.reasonCode ? <span className="block">{reasonLabel(user.reasonCode, t)}</span> : null}
              <Time iso={user.since} /></>} />
          <QueueCard title={t.queues.unverified} body={t.queues.unverifiedBody} tone="info"
            icon={<MailWarningIcon className="size-4.5" aria-hidden="true" />} queue={data.unverified} href={users('verified:no')}
            detail={user => <Time iso={user.since} />} />
        </div>
      </section>
      {(data.recentActions && can('audit:read')) || data.jobs.length ? <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {data.recentActions && can('audit:read') ? <section aria-labelledby="recent-actions" className={card}>
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
        {data.jobs.length ? <Jobs jobs={data.jobs} /> : null}
      </div> : null}
    </div>
  </>;
}
