'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { AppWindowIcon, BanIcon, CheckCheckIcon, FingerprintIcon, KeyRoundIcon, ListChecksIcon, LogInIcon, LogOutIcon,
  MailIcon, MonitorOffIcon, NotebookPenIcon, ShieldAlertIcon, ShieldCheckIcon, SmartphoneIcon, UserCogIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { TimelineCategory, TimelineEntry, TimelinePage } from '../api/types.ts';
import { errorMessage } from '../actions/confirm.tsx';
import { Actor, actionLabel, reasonLabel, userHref } from '../audit/entry.tsx';
import { Time } from '../format.tsx';
import { Panel } from './parts.tsx';
import { timelineShows } from './tabs.ts';
import { useLocale, useTranslation } from '../../../i18n/client.ts';

type AdminText = ReturnType<typeof useTranslation<'admin'>>['t'];

const icons: Record<string, typeof LogInIcon> = { sign_in: LogInIcon, sign_in_failed: ShieldAlertIcon, sign_out: LogOutIcon,
  session_revoked: MonitorOffIcon, password_added: KeyRoundIcon, password_changed: KeyRoundIcon, password_removed: KeyRoundIcon,
  passkey_added: FingerprintIcon, passkey_removed: FingerprintIcon, passkey_renamed: FingerprintIcon, totp_added: SmartphoneIcon,
  totp_removed: SmartphoneIcon, totp_renamed: SmartphoneIcon, backup_codes_changed: ListChecksIcon, email_changed: MailIcon,
  consent_granted: AppWindowIcon, consent_revoked: AppWindowIcon, app_revoked: AppWindowIcon, suspend: BanIcon,
  operator_role_changed: UserCogIcon, signal_reviewed: CheckCheckIcon, note: NotebookPenIcon };
/** Security events worth a colour of their own (with words, never colour alone). */
const alarming = new Set(['sign_in_failed', 'email_changed', 'password_removed', 'passkey_removed', 'totp_removed', 'suspend',
  'require-password-reset']);

function methodName(method: unknown, t: AdminText): string | null {
  return typeof method === 'string' ? (t.timeline.methods as Record<string, string>)[method] ?? method : null;
}

/** An entry's headline and its supporting line, in the operator's words. */
function describe(entry: TimelineEntry, t: AdminText, appName: (clientId: string) => string) {
  const detail = entry.detail as { device?: { label?: string }; network?: string | null; method?: string; clientId?: string;
    action?: string };
  if (entry.source === 'note') return { title: t.timeline.note, line: null };
  if (entry.source === 'staff') {
    if (entry.action === 'signal_reviewed') {
      const kind = (entry.staff?.after as { kind?: string } | null)?.kind;
      return { title: t.timeline.reviewed({ signal: (t.signals.kinds as Record<string, string>)[kind ?? ''] ?? kind ?? '' }), line: null };
    }
    return { title: actionLabel(entry.action, t), line: null };
  }
  const title = entry.action === 'admin_action' && detail.action
    ? `${t.activityLabels.admin_action}: ${actionLabel(detail.action, t)}`
    : (t.activityLabels as Record<string, string>)[entry.action] ?? entry.action;
  const parts = [detail.device?.label, detail.network, methodName(detail.method, t),
    detail.clientId ? appName(detail.clientId) : null].filter(Boolean);
  return { title, line: parts.length ? parts.join(' · ') : null };
}

const dayKey = (iso: string, zone: string | undefined) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric',
  month: '2-digit', day: '2-digit' }).format(new Date(iso));

function days(items: TimelineEntry[], zone: string | undefined) {
  const groups: { key: string; entries: TimelineEntry[] }[] = [];
  for (const entry of items) {
    const key = dayKey(entry.occurredAt, zone);
    if (groups.at(-1)?.key === key) groups.at(-1)!.entries.push(entry); else groups.push({ key, entries: [entry] });
  }
  return groups;
}

function Line({ entry, appName }: { entry: TimelineEntry; appName(clientId: string): string }) {
  const { t } = useTranslation('admin');
  const { title, line } = describe(entry, t, appName);
  const Icon = icons[entry.source === 'note' ? 'note' : entry.action] ?? ShieldCheckIcon;
  const alarm = alarming.has(entry.action);
  const noted = entry.action !== 'signal_reviewed' || (entry.staff?.after as { noted?: boolean } | null)?.noted;
  const by = entry.staff ? { actorId: entry.staff.actorId, actorName: entry.staff.actorName, actorEmail: entry.staff.actorEmail }
    : entry.note ? { actorId: entry.note.authorId, actorName: entry.note.authorName, actorEmail: entry.note.authorEmail } : null;
  return <li className="flex gap-3 px-5 py-2.5 text-sm group-data-[density=compact]/admin:py-1.5">
    <span aria-hidden="true" className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg',
      entry.source === 'note' ? 'bg-info/10 text-info-foreground' : entry.source === 'staff' ? 'bg-primary/10 text-primary'
        : alarm ? 'bg-destructive/10 text-destructive-foreground' : 'bg-muted text-muted-foreground')}>
      <Icon className="size-3.5" /></span>
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn('font-medium', alarm && entry.source === 'security' && 'text-destructive-foreground')}>{title}</span>
        {entry.staff?.reasonCode ? <Badge variant="outline" size="sm">{reasonLabel(entry.staff.reasonCode, t)}</Badge> : null}
        {entry.staff && entry.staff.outcome !== 'succeeded' ? <Badge variant="warning" size="sm">
          {(t.outcomes as Record<string, string>)[entry.staff.outcome] ?? entry.staff.outcome}</Badge> : null}
        <Time iso={entry.occurredAt} className="ms-auto shrink-0 text-xs text-muted-foreground" />
      </p>
      {line ? <p className="text-xs text-muted-foreground">{line}</p> : null}
      {entry.note ? <p className="mt-0.5 whitespace-pre-wrap">{entry.note.body}</p> : null}
      {entry.staff?.reason && noted ? <p className="mt-0.5 text-muted-foreground">{entry.staff.reason}</p> : null}
      {entry.staff?.userMessage ? <blockquote className="mt-1.5 rounded-xl border-s-2 border-primary/40 bg-muted/50 px-3 py-2 text-xs">
        <span className="block font-medium text-muted-foreground">{t.user.messageToUser}</span>
        <span className="whitespace-pre-wrap">{entry.staff.userMessage}</span></blockquote> : null}
      {by ? <p className="mt-0.5 text-xs text-muted-foreground">{t.user.actorPrefix} <Actor entry={by} /></p> : null}
    </div>
  </li>;
}

/** One account's story, newest first, grouped by day: its security log,
 * staff actions with who and why, and staff notes. Filters and pages are
 * read from the service; the filter is kept in the address. */
export function Timeline({ userId, initial, initialCategory, appName }: { userId: string; initial: TimelinePage;
  initialCategory: TimelineCategory; appName(clientId: string): string }) {
  const { t } = useTranslation('admin');
  const locale = useLocale().current;
  const { api, replaceUrl } = useAdminClient();
  const [category, setCategory] = useState(initialCategory);
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Days are UTC until hydrated (as the server rendered them), then local.
  const [zone, setZone] = useState<string | undefined>('UTC');
  useEffect(() => setZone(undefined), []);
  const filterId = useId();
  async function show(next: TimelineCategory) {
    if (next === category) return;
    setCategory(next); setLoading(true); setError(null);
    replaceUrl(next === 'all' ? userHref(userId) : `${userHref(userId)}?show=${next}`);
    const result = await api.timeline(userId, { category: next });
    setLoading(false);
    if (!result.ok) { setError(errorMessage(result, t)); return; }
    setItems(result.data.items); setCursor(result.data.nextCursor);
  }
  async function more() {
    if (!cursor) return;
    setLoading(true); setError(null);
    const result = await api.timeline(userId, { category, cursor });
    setLoading(false);
    if (!result.ok) { setError(errorMessage(result, t)); return; }
    setItems(current => [...current, ...result.data.items]); setCursor(result.data.nextCursor);
  }
  const today = dayKey(new Date().toISOString(), zone);
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString(), zone);
  const dayLabel = (key: string, iso: string) => key === today ? t.timeline.today : key === yesterday ? t.timeline.yesterday
    : new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: zone }).format(new Date(iso));
  return <Panel title={t.timeline.title} description={t.timeline.intro}>
    <div role="group" aria-labelledby={filterId} className="flex items-center gap-1.5 overflow-x-auto border-t border-border/60 px-5 py-2.5
      [scrollbar-width:none]">
      <span id={filterId} className="me-1 shrink-0 text-xs text-muted-foreground">{t.timeline.filterLabel}</span>
      {timelineShows.map(value => <button key={value} type="button" aria-pressed={value === category} onClick={() => void show(value)}
        className={cn('h-7 shrink-0 rounded-full border px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/32',
          value === category ? 'border-primary/30 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
        {t.timeline.categories[value]}</button>)}
    </div>
    {items.length ? <ol aria-busy={loading} className={cn('border-t border-border/60 transition-opacity', loading && 'opacity-60')}>
      {days(items, zone).map(day => <li key={day.key}>
        <h3 className="sticky top-14 z-[1] bg-card/95 px-5 pt-3 pb-1 text-xs font-medium text-muted-foreground backdrop-blur">
          <span suppressHydrationWarning>{dayLabel(day.key, day.entries[0]!.occurredAt)}</span></h3>
        <ol>{day.entries.map(entry => <Line key={entry.id} entry={entry} appName={appName} />)}</ol>
      </li>)}
    </ol> : <p className="border-t border-border/60 px-5 py-8 text-center text-sm text-muted-foreground">
      {loading ? t.timeline.loading : category === 'all' ? t.timeline.empty : t.timeline.emptyFiltered}</p>}
    {error ? <p role="alert" className="border-t border-border/60 px-5 py-3 text-sm text-destructive-foreground">{error}</p> : null}
    {cursor ? <div className="flex justify-center border-t border-border/60 px-5 py-3">
      <Button variant="outline" size="sm" isLoading={loading} onClick={() => void more()}>{t.loadMore}</Button></div> : null}
  </Panel>;
}
