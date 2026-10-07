'use client';

import { spaceHref } from '../../address/path.ts';
import { globalWorkHref } from '../../work-page/route.ts';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldLabel } from '@rezics/ui/field';
import { cn } from '@rezics/ui/utils';
import { ArrowUpDownIcon, BellIcon, CheckCheckIcon, CircleCheckIcon, FileCheckIcon, FilePenLineIcon, MessageSquareQuoteIcon, MessageSquareReplyIcon,
  RotateCwIcon, ShieldIcon, ThumbsUpIcon, TriangleAlertIcon, UserPlusIcon, UserRoundCogIcon, type LucideIcon }
  from 'lucide-react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { materializeData } from 'native-i18n';
import { messages as newWorkMessages } from './messages.ts';
import type { UiLocale } from '../../../i18n/define.ts';
import { useRef, useState } from 'react';
import { localizedPath } from '../../../i18n/locale.ts';
import { browserMainApi } from '../../api/browser.ts';
import { relativeTime } from '../../feed/time.ts';
import { type MainClient, settle } from '../../feed/types.ts';
import { CommunityIcon } from '../community-icon.tsx';
import { EmptyState } from '../empty-state.tsx';
import LocalizedLink from '../localized-link.tsx';
import { PageContainer, PageHeader } from '../page.tsx';
import { useShell } from '../shell-provider.tsx';
import { setUnread } from '../unread.ts';
import { inboxReasons, inboxViews, type NotificationSelection, type NotificationWindow, notificationsHref,
  readWindow, type StreamItem } from './window.ts';

type T = ReturnType<typeof useShell>['t'];
type Kind = NonNullable<StreamItem['display']>['kind'];

const icons: Record<Kind, LucideIcon> = { reply: MessageSquareReplyIcon, submission_decision: FileCheckIcon,
  moderation_outcome: ShieldIcon, realm_role_change: UserRoundCogIcon, follow: UserPlusIcon,
  claim_correction: CircleCheckIcon, review: MessageSquareQuoteIcon, review_helpful: ThumbsUpIcon,
  realm_invitation: UserPlusIcon, new_work: BellIcon, chapter: MessageSquareQuoteIcon, post_vote: ArrowUpDownIcon };

const uuid = (iri: string | null) => iri?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)?.[0];

/**
 * What happened, in a sentence that says where: Main sends facts (kind,
 * actor, title, Realm and role names), never rendered copy.
 */
const viewLabel = { inbox: 'viewInbox', saved: 'viewSaved', done: 'viewDone' } as const;
const reasonLabel = { steward: 'reasonReviewRequested', author: 'reasonYourCorrections', reviewer: 'reasonParticipating',
  manual: 'reasonWatching' } as const;

/** A correction Main named with a proposal, in a sentence. Social kinds keep their own sentences below. */
function proposalSentence(topic: string, t: T): string | null {
  switch (topic) {
    case 'review-requested': return t.reviewRequestedNotice;
    case 'changes-requested': return t.changesRequestedNotice;
    case 'proposal-revised': return t.proposalRevisedNotice;
    case 'proposal-decided': return t.proposalDecidedNotice;
    case 'proposal-withdrawn': return t.proposalWithdrawnNotice;
    case 'proposal-reverted': return t.proposalRevertedNotice;
    default: return null;
  }
}

function sentence(item: StreamItem, t: T, locale: UiLocale): string {
  const display = item.display;
  if (item.state !== 'active') return t.notificationUnavailable;
  const proposal = item.proposal ? proposalSentence(item.topic, t) : null;
  if (proposal) return proposal;
  if (!display) return t.notificationUnavailable;
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
    case 'new_work': {
      if (!title) return t.notificationUnavailable;
      const copy = materializeData(newWorkMessages[locale], { locale });
      return display.target.topicName ? copy.newWorkIn({ topic: display.target.topicName, title })
        : copy.newWork({ title });
    }
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
  if (item.state !== 'active') return null;
  if (item.proposal) return `/proposals/${item.proposal.id}?revision=${item.proposal.revision}`;
  if (!display) return null;
  if (display.kind === 'new_work') return display.target.href ?? null;
  if (display.kind === 'submission_decision') {
    const work = uuid(display.target.linkTarget);
    return work ? globalWorkHref(work) : null;
  }
  if (display.kind === 'chapter' || display.kind === 'post_vote') {
    const work = uuid(display.target.linkTarget);
    return work ? globalWorkHref(work) : null;
  }
  if (display.kind === 'review' || display.kind === 'review_helpful') {
    const work = uuid(display.target.linkTarget);
    const review = uuid(display.target.reviewId);
    return work ? `${globalWorkHref(work)}${review ? `#review-${review}` : ''}` : null;
  }
  // The Realm by its Zone's address when it has one, as the navigation links it.
  const realm = display.realmRouteSegment ?? uuid(display.realm);
  return realm && (display.kind === 'realm_role_change' || display.kind === 'realm_invitation'
    || display.kind === 'reply') ? spaceHref(realm, 'community') : null;
}

function NotificationRow({ item, grouped, now, avatarQuery, onRead, onTriage, triageBusy, actingSubject, main }: { item: StreamItem;
  grouped: number; now: number; avatarQuery: string; onRead: (item: StreamItem) => void;
  onTriage: (item: StreamItem, patch: { saved?: boolean; done?: boolean }) => void; triageBusy: boolean;
  actingSubject?: string; main: () => MainClient }) {
  const { t, locale } = useShell();
  const [listed, setListed] = useState(false);
  const [answer, setAnswer] = useState<'accept' | 'decline' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef<{ action: 'accept' | 'decline'; listed: boolean; key: string } | null>(null);
  const display = item.display;
  const Icon = display ? icons[display.kind] : item.proposal ? FilePenLineIcon : BellIcon;
  const href = destination(item);
  const text = sentence(item, t, locale);
  const where = place(item, t);
  const because = item.reason ? t[reasonLabel[item.reason]] : null;
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
      {display?.actor ? <CommunityIcon name={display.actor.name ?? t.someone} size="md" avatarQuery={avatarQuery} person
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
          className={cn('outline-none hover:underline focus-visible:underline',
            invitation ? 'rounded-sm focus-visible:ring-2 focus-visible:ring-ring'
              : 'after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset')}>
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
      <div className="relative z-10 flex flex-wrap gap-2">
        <Button size="sm" variant={item.saved ? 'soft' : 'outline'} aria-pressed={item.saved} disabled={triageBusy}
          onClick={() => onTriage(item, { saved: !item.saved })}>
          {item.saved ? t.unsaveNotification : t.saveNotification}</Button>
        <Button size="sm" variant={item.done ? 'soft' : 'outline'} aria-pressed={item.done} disabled={triageBusy}
          onClick={() => onTriage(item, { done: !item.done })}>
          {item.done ? t.undoDone : t.markDone}</Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {because ? <><span>{because}</span><span aria-hidden="true"> · </span></> : null}
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
 * read; opening one marks it read. Saved and Done are a separate triage, kept
 * in the URL with the reason filter so a reload shows what Main returns.
 * Older windows load on request. `main` is the browser client (stories pass
 * an in-memory one).
 */
export function NotificationsView({ initial, now, avatarQuery, invitations, main, actingSubject,
  selection = { view: 'inbox', reason: null } }: {
  initial: NotificationWindow; now: number; avatarQuery: string;
  /** Open invitations to join a Realm, answered here before the notifications. */
  invitations?: ReactNode; main?: MainClient; actingSubject?: string;
  selection?: NotificationSelection;
}) {
  const { t } = useShell();
  const client = () => main ?? browserMainApi();
  const [windows, setWindows] = useState([initial]);
  const [readThrough, setReadThrough] = useState(initial.readThrough);
  const [readHere, setReadHere] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<'idle' | 'loading' | 'older-failed' | 'mark-failed' | 'marked'>('idle');
  const [busy, setBusy] = useState<string | null>(null);
  const [triageNote, setTriageNote] = useState<string | null>(null);
  const [triageError, setTriageError] = useState<string | null>(null);
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
    const next = await readWindow(client(), oldest.generation, oldest.from, selection);
    if (!next.ok) { setState('older-failed'); return; }
    setWindows(current => [...current, { ...next.data, head: initial.head }]);
    setState('idle');
  }

  /** One flag at a time. Main keeps the flag we omit, and the response is what this view shows. */
  async function triage(item: StreamItem, patch: { saved?: boolean; done?: boolean }) {
    if (busy) return;
    setBusy(item.id); setTriageError(null); setTriageNote(null);
    const result = await settle(() => client().v1.me.notifications({ item: item.id }).triage.put({
      profile: 'notification-item-triage-v1', ...patch, expectedRevision: item.triageRevision }));
    setBusy(null);
    if (!result.ok) { setTriageError(result.failure === 'moved' ? t.triageStale : t.triageFailed); return; }
    const next = result.data;
    const leaves = (selection.view === 'inbox' && next.done) || (selection.view === 'saved' && !next.saved)
      || (selection.view === 'done' && !next.done);
    setWindows(current => current.map(window => ({ ...window, items: window.items.flatMap(entry =>
      entry.id !== item.id ? [entry] : leaves ? [] : [{ ...entry, saved: next.saved, done: next.done,
        triageRevision: next.revision }]) })));
    setTriageNote(patch.done === true ? t.triageDone : patch.done === false ? t.triageUndone
      : patch.saved ? t.triageSaved : t.triageUnsaved);
  }

  const rows = windows.flatMap(window => collapse(window));
  const empty = selection.reason ? { title: t.noFiltered, description: t.noFilteredBody }
    : selection.view === 'saved' ? { title: t.noSaved, description: t.noSavedBody }
      : selection.view === 'done' ? { title: t.noDone, description: t.noDoneBody }
        : { title: t.noNotifications, description: t.noNotificationsBody };
  const tabClass = (current: boolean) => cn('rounded-lg px-3 py-1.5 font-medium',
    current ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground');
  const reasonClass = (current: boolean) => cn('rounded-full border px-3 py-1 font-medium',
    current ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground');
  return <PageContainer className="grid max-w-3xl gap-6">
    <PageHeader title={t.notifications} description={t.notificationsIntro}
      actions={unread ? <Button variant="outline" size="sm" onClick={() => void markAll()}>
        <CheckCheckIcon aria-hidden="true" />{t.markAllRead}</Button> : null} />
    <div className="grid gap-3">
      <nav aria-label={t.viewsLabel} className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-muted p-1 text-sm">
        {inboxViews.map(view => <LocalizedLink key={view} href={notificationsHref({ view, reason: selection.reason })}
          aria-current={view === selection.view ? 'page' : undefined} className={tabClass(view === selection.view)}>
          {t[viewLabel[view]]}</LocalizedLink>)}
      </nav>
      <nav aria-label={t.reasonFilterLabel} className="flex flex-wrap gap-2 text-sm">
        <LocalizedLink href={notificationsHref({ view: selection.view, reason: null })}
          aria-current={selection.reason === null ? 'page' : undefined} className={reasonClass(selection.reason === null)}>
          {t.reasonAll}</LocalizedLink>
        {inboxReasons.map(reason => <LocalizedLink key={reason}
          href={notificationsHref({ view: selection.view, reason })}
          aria-current={selection.reason === reason ? 'page' : undefined}
          className={reasonClass(selection.reason === reason)}>{t[reasonLabel[reason]]}</LocalizedLink>)}
      </nav>
    </div>
    {state === 'marked' ? <p role="status" className="sr-only">{t.markedAllRead}</p> : null}
    {state === 'mark-failed' ? <p role="alert" className="text-destructive-foreground text-sm">{t.markReadFailed}</p>
      : null}
    {triageNote ? <p role="status" className="sr-only">{triageNote}</p> : null}
    {triageError ? <p role="alert" className="text-destructive-foreground text-sm">{triageError}</p> : null}
    {invitations}
    {rows.length ? <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60
      bg-card shadow-(--aura-shadow-card)">
      {rows.map(({ item, grouped }) => <NotificationRow key={item.id} item={{ ...item, read: isRead(item) }}
        grouped={grouped} now={now} avatarQuery={avatarQuery} onRead={markOne} onTriage={(entry, patch) => void triage(entry, patch)}
        triageBusy={busy === item.id} actingSubject={actingSubject} main={client} />)}
    </ul> : <EmptyState icon={BellIcon} title={empty.title} description={empty.description} />}
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
