'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldLabel } from '@rezics/ui/field';
import { cn } from '@rezics/ui/utils';
import { ArrowUpDownIcon, BellIcon, CheckCheckIcon, CircleCheckIcon, FileCheckIcon, MessageSquareQuoteIcon, MessageSquareReplyIcon,
  RotateCwIcon, ShieldIcon, ThumbsUpIcon, TriangleAlertIcon, UserPlusIcon, UserRoundCogIcon, type LucideIcon }
  from 'lucide-react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRef, useState } from 'react';
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
  claim_correction: CircleCheckIcon, review: MessageSquareQuoteIcon, review_helpful: ThumbsUpIcon,
  realm_invitation: UserPlusIcon, chapter: MessageSquareQuoteIcon, post_vote: ArrowUpDownIcon };

const uuid = (iri: string | null) => iri?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)?.[0];

/**
 * What happened, in a sentence that says where: Main sends facts (kind,
 * actor, title, Realm and role names), never rendered copy.
 */
function sentence(item: StreamItem, t: T): string {
  const display = item.display;
  if (!display || item.state !== 'active') return t.notificationUnavailable;
  const name = display.actor?.name ?? t.someone;
  const title = display.target.title;
  const realm = display.realmName;
  switch (display.kind) {
    case 'reply': return item.topic === 'mention' ? t.mentionedYou({ name })
      : title ? t.repliedOn({ name, title }) : t.replied({ name });
    case 'submission_decision': {
      if (!title) return t.submissionDecided;
      const state = display.target.excerpt;
      return state === 'accepted' ? t.submissionAccepted({ title }) : state === 'rejected'
        ? t.submissionRejected({ title }) : state === 'changes-requested' ? t.submissionChanges({ title })
          : t.submissionDecided;
    }
    case 'moderation_outcome': return title ? t.moderationOn({ title }) : t.moderationDecided;
    case 'realm_role_change': return realm && display.roleName && display.roleChange === 'given'
      ? t.roleGivenIn({ realm, role: display.roleName })
      : realm && display.roleName && display.roleChange === 'taken'
        ? t.roleTakenIn({ realm, role: display.roleName })
        : realm && display.roleName ? t.roleChangedIn({ name, realm, role: display.roleName })
      : realm ? t.roleChangedInRealm({ name, realm }) : t.roleChanged;
    case 'realm_invitation': return realm ? t.invitedTo({ name, realm }) : t.invitationReceived;
    case 'follow': return t.followedYou({ name });
    case 'claim_correction': return title ? t.correctionOn({ title }) : t.correctionMade;
    case 'review': return title ? t.reviewedWork({ name, title }) : t.reviewedYourWork({ name });
    case 'review_helpful': return title ? t.reviewHelpful({ title }) : t.reviewHelpfulAny;
    case 'chapter': return title ? t.newChapterOn({ title }) : t.newChapter;
    case 'post_vote': return title ? t.votedOnPost({ name, title }) : t.votedOnYourPost({ name });
  }
}

/** Where it happened, for the kinds whose sentence does not already name the Realm. */
function place(item: StreamItem, t: T): string | null {
  const display = item.display;
  if (!display?.realmName || item.state !== 'active'
    || display.kind === 'realm_role_change' || display.kind === 'realm_invitation') return null;
  return t.inRealm({ realm: display.realmName });
}

/** Where a notification leads, when its subject has a page: the Work decided on, or the Realm. */
function destination(item: StreamItem): string | null {
  const display = item.display;
  if (!display || item.state !== 'active') return null;
  if (display.kind === 'submission_decision') {
    const work = uuid(display.target.linkTarget);
    return work ? `/w/${work}` : null;
  }
  if (display.kind === 'chapter' || display.kind === 'post_vote') {
    const work = uuid(display.target.linkTarget);
    return work ? `/w/${work}` : null;
  }
  if (display.kind === 'review' || display.kind === 'review_helpful') {
    const work = uuid(display.target.linkTarget);
    const review = uuid(display.target.reviewId);
    return work ? `/w/${work}${review ? `#review-${review}` : ''}` : null;
  }
  // The Realm by its Zone's address when it has one, as the navigation links it.
  const realm = display.realmRouteSegment ?? uuid(display.realm);
  return realm && (display.kind === 'realm_role_change' || display.kind === 'realm_invitation'
    || display.kind === 'reply') ? `/r/${realm}` : null;
}

function NotificationRow({ item, grouped, now, avatarQuery, onRead, actingSubject, main }: { item: StreamItem;
  grouped: number; now: number; avatarQuery: string; onRead: (item: StreamItem) => void;
  actingSubject?: string; main: () => MainClient }) {
  const { t, locale } = useShell();
  const [listed, setListed] = useState(false);
  const [answer, setAnswer] = useState<'accept' | 'decline' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef<{ action: 'accept' | 'decline'; listed: boolean; key: string } | null>(null);
  const display = item.display;
  const Icon = display ? icons[display.kind] : BellIcon;
  const href = destination(item);
  const text = sentence(item, t);
  const where = place(item, t);
  const excerpt = display?.kind === 'reply' || display?.kind === 'review' ? display.target.excerpt : null;
  const invitation = item.state === 'active' && display?.kind === 'realm_invitation' && actingSubject && item.subject?.ref
    && uuid(display.realm) ? { realm: uuid(display.realm)!, id: item.subject.ref } : null;
  async function respond(action: 'accept' | 'decline') {
    if (!invitation || !actingSubject) return;
    if (attempt.current?.action !== action || attempt.current.listed !== listed)
      attempt.current = { action, listed, key: crypto.randomUUID() };
    setBusy(true); setFailed(false);
    const result = await settle(() => main().v1.realms({ realm: invitation.realm })
      .invitations({ invitation: invitation.id }).response.post({ actingSubject, action, listed },
        { headers: { 'idempotency-key': attempt.current!.key } }));
    setBusy(false);
    if (!result.ok) { setFailed(true); return; }
    setAnswer(action);
    onRead(item);
  }
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
          className={cn('outline-none hover:underline focus-visible:underline', !invitation && 'after:absolute after:inset-0')}>
          {text}</Link>
          : <span lang={display?.target.language ?? undefined}>{text}</span>}
        {grouped ? <span className="font-normal text-muted-foreground"> {t.moreLikeThis(grouped)}</span> : null}
      </p>
      {excerpt ? <p lang={display?.target.language ?? undefined} className="line-clamp-2 text-muted-foreground text-sm">
        {excerpt}</p> : null}
      {invitation ? answer ? <p role="status" className="text-sm">{answer === 'accept'
        ? t.joinedRealm({ realm: display?.realmName ?? t.yourRealms })
        : t.declinedInvitation({ realm: display?.realmName ?? t.yourRealms })}</p>
        : <div className="grid gap-2">
          <Field orientation="horizontal" className="gap-2">
            <Checkbox checked={listed} onCheckedChange={details => setListed(details.checked === true)} />
            <FieldLabel className="font-normal">{t.listMe}</FieldLabel>
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void respond('decline')}>
              {t.declineInvitation}</Button>
            <Button size="sm" disabled={busy} isLoading={busy} onClick={() => void respond('accept')}>
              {t.acceptInvitation}</Button>
          </div>
          {failed ? <p role="alert" className="text-destructive-foreground text-sm">{t.invitationFailed}</p> : null}
        </div> : null}
      <p className="text-muted-foreground text-xs">
        {where ? <><span>{where}</span><span aria-hidden="true"> · </span></> : null}
        <time dateTime={item.createdAt} suppressHydrationWarning>{relativeTime(item.createdAt, now, locale, 'long')}</time>
      </p>
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
export function NotificationsView({ initial, now, avatarQuery, invitations, main, actingSubject }: {
  initial: NotificationWindow; now: number; avatarQuery: string;
  /** Open invitations to join a Realm, answered here before the notifications. */
  invitations?: ReactNode; main?: MainClient; actingSubject?: string;
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
    void settle(() => client().v1.me.notifications({ item: item.id }).read.put()).then(async () => {
      const count = await settle(() => client().v1.me.notifications['unread-count'].get());
      if (count.ok) setUnread({ count: count.data.count, overflow: count.data.overflow });
    });
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
    {invitations}
    {rows.length ? <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60
      bg-card shadow-(--aura-shadow-card)">
      {rows.map(({ item, grouped }) => <NotificationRow key={item.id} item={{ ...item, read: isRead(item) }}
        grouped={grouped} now={now} avatarQuery={avatarQuery} onRead={markOne}
        actingSubject={actingSubject} main={client} />)}
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
