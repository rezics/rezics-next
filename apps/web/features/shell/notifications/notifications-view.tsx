'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { BellIcon, CheckCheckIcon, CircleCheckIcon, FileCheckIcon, MessageSquareReplyIcon, RotateCwIcon,
  ShieldIcon, TriangleAlertIcon, UserPlusIcon, UserRoundCogIcon, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { localizedPath } from '../../../i18n/locale.ts';
import { browserMainApi } from '../../api/browser.ts';
import { relativeTime } from '../../feed/time.ts';
import { type MainClient, settle } from '../../feed/types.ts';
import { CommunityIcon } from '../community-icon.tsx';
import { EmptyState } from '../empty-state.tsx';
import { PageContainer, PageHeader } from '../page.tsx';
import { useShell } from '../shell-provider.tsx';
import { setUnread } from '../unread.ts';
import { type NotificationWindow, readWindow, type StreamItem } from './window.ts';

type T = ReturnType<typeof useShell>['t'];
type Kind = NonNullable<StreamItem['display']>['kind'];

const icons: Record<Kind, LucideIcon> = { reply: MessageSquareReplyIcon, submission_decision: FileCheckIcon,
  moderation_outcome: ShieldIcon, realm_role_change: UserRoundCogIcon, follow: UserPlusIcon,
  claim_correction: CircleCheckIcon };

const uuid = (iri: string | null) => iri?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)?.[0];

/** What happened, in a sentence. Main sends facts (kind, actor, title), never rendered copy. */
function sentence(item: StreamItem, t: T): string {
  const display = item.display;
  if (!display || item.state !== 'active') return t.notificationUnavailable;
  const name = display.actor?.name ?? t.someone;
  const title = display.target.title;
  switch (display.kind) {
    case 'reply': return title ? t.repliedOn({ name, title }) : t.replied({ name });
    case 'submission_decision': {
      if (!title) return t.submissionDecided;
      const state = display.target.excerpt;
      return state === 'accepted' ? t.submissionAccepted({ title }) : state === 'rejected'
        ? t.submissionRejected({ title }) : state === 'changes-requested' ? t.submissionChanges({ title })
          : t.submissionDecided;
    }
    case 'moderation_outcome': return title ? t.moderationOn({ title }) : t.moderationDecided;
    case 'realm_role_change': return t.roleChanged;
    case 'follow': return t.followedYou({ name });
    case 'claim_correction': return title ? t.correctionOn({ title }) : t.correctionMade;
  }
}

/** Where a notification leads, when its subject has a page: the Work decided on, or the Realm. */
function destination(item: StreamItem): string | null {
  const display = item.display;
  if (!display || item.state !== 'active') return null;
  if (display.kind === 'submission_decision') {
    const work = uuid(display.target.linkTarget);
    return work ? `/w/${work}` : null;
  }
  const realm = uuid(display.realm);
  return realm && (display.kind === 'realm_role_change' || display.kind === 'reply') ? `/r/${realm}` : null;
}

function NotificationRow({ item, grouped, now, avatarQuery, onRead }: { item: StreamItem; grouped: number; now: number;
  avatarQuery: string; onRead: (item: StreamItem) => void }) {
  const { t, locale } = useShell();
  const display = item.display;
  const Icon = display ? icons[display.kind] : BellIcon;
  const href = destination(item);
  const text = sentence(item, t);
  const excerpt = display?.kind === 'reply' ? display.target.excerpt : null;
  return <li className={cn('relative flex gap-3 px-4 py-3.5 transition-colors hover:bg-accent/30',
    !item.read && 'bg-primary/4')}>
    <span className="relative mt-0.5 shrink-0">
      {display?.actor ? <CommunityIcon name={display.actor.name} size="md" avatarQuery={avatarQuery} person
        icon={display.actor.avatar ? { kind: 'image', url: display.actor.avatar } : null} />
        : <span className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon aria-hidden="true" className="size-4.5" /></span>}
      {display?.actor ? <span className="absolute -end-1 -bottom-1 grid size-5 place-items-center rounded-full border
        border-background bg-card text-muted-foreground"><Icon aria-hidden="true" className="size-3" /></span> : null}
    </span>
    <div className="grid min-w-0 flex-1 gap-1">
      <p className={cn('text-pretty text-sm', !item.read && 'font-semibold')}>
        {href ? <Link href={localizedPath(href, locale)} onClick={() => onRead(item)}
          lang={display?.target.language ?? undefined}
          className="outline-none after:absolute after:inset-0 hover:underline focus-visible:underline">{text}</Link>
          : <span lang={display?.target.language ?? undefined}>{text}</span>}
        {grouped ? <span className="font-normal text-muted-foreground"> {t.moreLikeThis(grouped)}</span> : null}
      </p>
      {excerpt ? <p lang={display?.target.language ?? undefined} className="line-clamp-2 text-muted-foreground text-sm">
        {excerpt}</p> : null}
      <time dateTime={item.createdAt} suppressHydrationWarning className="text-muted-foreground text-xs">
        {relativeTime(item.createdAt, now, locale, 'long')}</time>
    </div>
    {!item.read ? <span className="mt-2 flex shrink-0 items-center gap-1">
      <span aria-hidden="true" className="size-2 rounded-full bg-brand" />
      <span className="sr-only">{t.unread}</span></span> : null}
  </li>;
}

/** Groups Main made on a page show once, as their newest member with a count. */
function collapse(window: Pick<NotificationWindow, 'items' | 'groups'>): { item: StreamItem; grouped: number }[] {
  const hidden = new Set<string>();
  const counts = new Map<string, number>();
  for (const group of window.groups) {
    if (group.itemIds.length < 2) continue;
    const members = window.items.filter(item => group.itemIds.includes(item.id));
    const [newest, ...rest] = members;
    if (!newest) continue;
    counts.set(newest.id, rest.length);
    for (const item of rest) hidden.add(item.id);
  }
  return window.items.filter(item => !hidden.has(item.id)).map(item => ({ item, grouped: counts.get(item.id) ?? 0 }));
}

/**
 * The notifications page: newest first, unread marked, one press to mark all
 * read; opening one marks it read. Older windows load on request. `main` is
 * the browser client (stories pass an in-memory one).
 */
export function NotificationsView({ initial, now, avatarQuery, main }: {
  initial: NotificationWindow; now: number; avatarQuery: string; main?: MainClient;
}) {
  const { t } = useShell();
  const client = () => main ?? browserMainApi();
  const [windows, setWindows] = useState([initial]);
  const [readThrough, setReadThrough] = useState(initial.readThrough);
  const [readHere, setReadHere] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<'idle' | 'loading' | 'older-failed' | 'mark-failed' | 'marked'>('idle');
  const oldest = windows.at(-1)!;
  const isRead = (item: StreamItem) => item.read || readHere.has(item.id)
    || BigInt(item.sequence) <= BigInt(readThrough);
  const unread = windows.some(window => window.items.some(item => !isRead(item)));

  async function markAll() {
    const result = await settle(() => client().v1.me['notification-read-watermarks'].inbox.put({
      profile: 'notification-read-watermark-v1', generation: initial.generation, readThrough: initial.head }));
    if (!result.ok) { setState('mark-failed'); return; }
    setReadThrough(result.data.readThrough);
    setUnread({ count: 0, overflow: false });
    setState('marked');
  }

  function markOne(item: StreamItem) {
    if (isRead(item)) return;
    setReadHere(current => new Set(current).add(item.id));
    void settle(() => client().v1.me.notifications({ item: item.id }).read.put());
  }

  async function older() {
    setState('loading');
    const next = await readWindow(client(), oldest.generation, oldest.from);
    if (!next.ok) { setState('older-failed'); return; }
    setWindows(current => [...current, { ...next.data, head: initial.head }]);
    setState('idle');
  }

  const rows = windows.flatMap(window => collapse(window));
  return <PageContainer className="grid max-w-3xl gap-6">
    <PageHeader title={t.notifications} description={t.notificationsIntro}
      actions={unread ? <Button variant="outline" size="sm" onClick={() => void markAll()}>
        <CheckCheckIcon aria-hidden="true" />{t.markAllRead}</Button> : null} />
    {state === 'marked' ? <p role="status" className="sr-only">{t.markedAllRead}</p> : null}
    {state === 'mark-failed' ? <p role="alert" className="text-destructive-foreground text-sm">{t.markReadFailed}</p>
      : null}
    {rows.length ? <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60
      bg-card shadow-(--aura-shadow-card)">
      {rows.map(({ item, grouped }) => <NotificationRow key={item.id} item={{ ...item, read: isRead(item) }}
        grouped={grouped} now={now} avatarQuery={avatarQuery} onRead={markOne} />)}
    </ul> : <EmptyState icon={BellIcon} title={t.noNotifications} description={t.noNotificationsBody} />}
    {oldest.from !== '0' ? <div className="flex flex-col items-center gap-2">
      {state === 'older-failed' ? <p role="alert" className="text-muted-foreground text-sm">{t.olderFailed}</p> : null}
      <Button variant="outline" isLoading={state === 'loading'} onClick={() => void older()}>
        {state === 'older-failed' ? <RotateCwIcon aria-hidden="true" /> : null}{t.olderNotifications}</Button>
    </div> : null}
  </PageContainer>;
}

/** Signed out, or Main could not answer: say which, and offer the one next step. */
export function NotificationsUnavailable({ reason, signInHref }: { reason: 'signed-out' | 'failed'; signInHref: string }) {
  const { t } = useShell();
  return <PageContainer className="max-w-3xl">
    {reason === 'signed-out'
      ? <EmptyState icon={BellIcon} headingLevel={1} title={t.signInForNotifications}
        description={t.signInForNotificationsBody}>
        <a href={signInHref} className={buttonVariants()}>{t.signIn}</a>
      </EmptyState>
      : <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1}
        title={t.notificationsFailed} description={t.notificationsFailedBody}>
        <Button onClick={() => location.reload()}><RotateCwIcon aria-hidden="true" />{t.retry}</Button>
      </EmptyState>}
  </PageContainer>;
}
