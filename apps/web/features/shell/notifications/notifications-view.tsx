'use client';

import { spaceHref } from '../../address/path.ts';
import { signInPath } from '../../auth/paths.ts';
import { globalWorkHref } from '../../work-page/route.ts';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from '@rezics/ui/collapsible';
import { Field, FieldLabel } from '@rezics/ui/field';
import { cn } from '@rezics/ui/utils';
import { ArrowUpDownIcon, BellIcon, BookmarkIcon, CheckIcon, CheckCheckIcon, CircleCheckIcon, FileCheckIcon, FilePenLineIcon, MessageSquareQuoteIcon, MessageSquareReplyIcon,
  RotateCwIcon, ShieldIcon, ThumbsUpIcon, TriangleAlertIcon, UserPlusIcon, UserRoundCogIcon, type LucideIcon }
  from 'lucide-react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { materializeData } from 'native-i18n';
import { messages as newWorkMessages } from './messages.ts';
import { sanctionSentence } from './sanction.ts';
import { NotificationDeliveries } from './delivery.tsx';
import type { UiLocale } from '../../../i18n/define.ts';
import { useEffect, useRef, useState } from 'react';
import { localizedPath } from '../../../i18n/locale.ts';
import { browserMainApi } from '../../api/browser.ts';
import { relativeTime } from '../../feed/time.ts';
import { failureText, type Loaded, type MainClient, type ReadFailure, settle } from '../../feed/types.ts';
import { CommunityIcon } from '../community-icon.tsx';
import { EmptyState, failureDetail } from '../empty-state.tsx';
import LocalizedLink from '../localized-link.tsx';
import { PageContainer, PageHeader } from '../page.tsx';
import { useShell } from '../shell-provider.tsx';
import { beginNotificationRequest, isNotificationRequestCurrent, setUnread, setUnreadGeneration } from '../unread.ts';
import { inboxReasons, inboxViews, mergeNotificationTriage, type NotificationSelection, type NotificationWindow, notificationsHref,
  readNotificationCount, readWindow, type NotificationCount, type StreamItem } from './window.ts';

type T = ReturnType<typeof useShell>['t'];
type Kind = NonNullable<StreamItem['display']>['kind'];
type Traversal = { generation: string; head: string; revision: number };
type TriageFeedback = { id: string; text: string; failed: boolean; stale?: boolean; patch: { saved?: boolean; done?: boolean } };
type RowCopy = ReturnType<typeof materializeData<typeof newWorkMessages.en>>;

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
  if (display.membershipAction === 'ban' || display.membershipAction === 'unban') {
    return sanctionSentence(locale, { action: display.membershipAction, realm: realm ?? '',
      reason: display.membershipReason ?? '', until: display.membershipUntil ?? null,
      permanent: display.membershipPermanent === true });
  }
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

/** Titles come only from the supplied display; an unavailable subject never reuses private facts. */
function rowContent(item: StreamItem, t: T, copy: RowCopy, text: string) {
  const display = item.state === 'active' ? item.display : null;
  if (!display || item.proposal) return { title: text, event: null, language: undefined };
  const realmTarget = display.kind === 'realm_role_change' || display.kind === 'realm_invitation';
  const title = realmTarget ? display.realmName : display.kind === 'follow' ? display.actor?.name : display.target.title;
  if (!title) return { title: text, event: null, language: undefined };
  const language = realmTarget || display.kind === 'follow' ? undefined : display.target.language ?? undefined;
  if (display.membershipAction) return { title, event: text, language };
  let event: string;
  switch (display.kind) {
    case 'reply': event = item.topic === 'mention' ? copy.mentionedEvent : copy.repliedEvent; break;
    case 'submission_decision': event = display.target.excerpt === 'accepted' ? copy.submissionAcceptedEvent
      : display.target.excerpt === 'rejected' ? copy.submissionRejectedEvent
        : display.target.excerpt === 'changes-requested' ? copy.submissionChangesEvent : t.submissionDecided; break;
    case 'moderation_outcome': event = copy.moderationEvent; break;
    case 'realm_role_change': event = display.roleName ? display.roleChange === 'given'
      ? copy.roleGivenEvent({ role: display.roleName }) : display.roleChange === 'taken'
        ? copy.roleTakenEvent({ role: display.roleName }) : copy.roleChangedEvent({ role: display.roleName })
      : t.roleChanged; break;
    case 'realm_invitation': event = copy.invitationEvent; break;
    case 'follow': event = copy.followEvent; break;
    case 'claim_correction': event = copy.correctionEvent; break;
    case 'review': event = copy.reviewEvent; break;
    case 'review_helpful': event = t.reviewHelpfulAny; break;
    case 'new_work': event = copy.newWorkEvent; break;
    case 'chapter': event = copy.chapterEvent; break;
    case 'post_vote': event = copy.postVoteEvent; break;
  }
  return { title, event, language };
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

function NotificationRow({ item, grouped, now, avatarQuery, onRead, onTriage, triageBusy, feedback, actingSubject, main, isCurrent }: { item: StreamItem;
  grouped: number; now: number; avatarQuery: string; onRead: (item: StreamItem) => void;
  onTriage: (item: StreamItem, patch: { saved?: boolean; done?: boolean }) => void; triageBusy: boolean;
  feedback: TriageFeedback | null;
  actingSubject?: string; main: () => MainClient; isCurrent: () => boolean }) {
  const { t, locale } = useShell();
  const copy = materializeData(newWorkMessages[locale], { locale });
  const [listed, setListed] = useState(false);
  const [answer, setAnswer] = useState<'accept' | 'decline' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef<{ action: 'accept' | 'decline'; listed: boolean; key: string } | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const answerRef = useRef<HTMLParagraphElement>(null);
  const focusAnswer = useRef(false);
  useEffect(() => {
    if (answer && focusAnswer.current) answerRef.current?.focus();
  }, [answer]);
  const display = item.state === 'active' ? item.display : null;
  // A sanction never shows the person who recorded it.
  const actor = display?.membershipAction ? null : display?.actor;
  const Icon = display?.membershipAction ? ShieldIcon : display ? icons[display.kind]
    : item.state === 'active' && item.proposal ? FilePenLineIcon : BellIcon;
  const href = destination(item);
  const text = sentence(item, t, locale);
  const content = rowContent(item, t, copy, text);
  const source = actor && display?.kind !== 'follow' ? actor.name ?? t.someone : null;
  const realm = display?.realmName && display.realmName !== content.title ? t.inRealm({ realm: display.realmName }) : null;
  const topic = display?.kind === 'new_work' ? display.target.topicName : null;
  const because = item.state === 'active' && item.reason ? t[reasonLabel[item.reason]] : null;
  const excerpt = display?.kind === 'reply' || display?.kind === 'review' ? display.target.excerpt : null;
  const invitation = item.state === 'active' && display?.kind === 'realm_invitation' && actingSubject && item.subject?.ref
    && uuid(display.realm) ? { realm: uuid(display.realm)!, id: item.subject.ref } : null;
  async function respond(action: 'accept' | 'decline') {
    if (!invitation || !actingSubject || !isCurrent()) return;
    if (attempt.current?.action !== action || attempt.current.listed !== listed)
      attempt.current = { action, listed, key: crypto.randomUUID() };
    setBusy(true); setFailed(false);
    const result = await settle(() => main().v1.realms({ realm: invitation.realm })
      .invitations({ invitation: invitation.id }).response.post({ actingSubject, action, listed },
        { headers: { 'idempotency-key': attempt.current!.key } }));
    if (!isCurrent()) return;
    setBusy(false);
    if (!result.ok) { setFailed(true); return; }
    focusAnswer.current = rowRef.current?.contains(document.activeElement) === true;
    setAnswer(action);
    onRead(item);
  }
  return <li ref={rowRef} data-notification-row={item.id} aria-busy={triageBusy || busy || undefined}
    className={cn('relative flex gap-3 px-4 py-4 transition-colors hover:bg-accent/30',
    !item.read && 'bg-primary/4')}>
    <span className="relative mt-0.5 shrink-0">
      {actor ? <CommunityIcon name={actor.name ?? t.someone} size="md" avatarQuery={avatarQuery} person
        icon={actor.avatar ? { kind: 'image', url: actor.avatar } : null} />
        : <span className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon aria-hidden="true" className="size-4.5" /></span>}
      {actor ? <span className="absolute -end-1 -bottom-1 grid size-5 place-items-center rounded-full border
        border-background bg-card text-muted-foreground"><Icon aria-hidden="true" className="size-3" /></span> : null}
    </span>
    <div className="grid min-w-0 flex-1 gap-1.5">
      <h2 className={cn('wrap-anywhere text-pretty text-base leading-snug font-medium', !item.read && 'font-semibold')}>
        {href ? <Link href={localizedPath(href, locale)} onClick={() => onRead(item)}
          aria-label={text} lang={content.language}
          className="rounded-sm outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring">
          {content.title}</Link>
          : <span lang={content.language}>{content.title}</span>}
      </h2>
      {content.event || grouped ? <p className="wrap-anywhere text-sm leading-snug">
        {content.event}
        {grouped ? <span className="text-muted-foreground">{content.event ? <span aria-hidden="true"> · </span> : null}
          <span>{t.moreLikeThis(grouped)}</span></span> : null}
      </p> : null}
      <Collapsible className="grid gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
            {[source, realm, topic, because].filter(Boolean).map((part, index) => <span key={index}>
              <bdi className="wrap-anywhere">{part}</bdi><span aria-hidden="true"> · </span>
            </span>)}
            <time className="inline-block" dateTime={item.createdAt} suppressHydrationWarning>
              {relativeTime(item.createdAt, now, locale, 'long')}</time>
          </p>
          <CollapsibleTrigger asChild>
            <Button data-notification-actions size="sm" variant="ghost"
              className="-me-2 -mt-1 h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground">
              {copy.notificationActions}<CollapsibleIndicator className="[&_svg]:size-3" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant={item.saved ? 'soft' : 'outline'} aria-pressed={item.saved} disabled={triageBusy}
            onClick={() => onTriage(item, { saved: !item.saved })}>
            <BookmarkIcon aria-hidden="true" />{item.saved ? t.unsaveNotification : t.saveNotification}</Button>
          <Button size="sm" variant={item.done ? 'soft' : 'outline'} aria-pressed={item.done} disabled={triageBusy}
            onClick={() => onTriage(item, { done: !item.done })}>
            <CheckIcon aria-hidden="true" />{item.done ? t.undoDone : t.markDone}</Button>
        </CollapsibleContent>
      </Collapsible>
      {!item.read || item.saved || item.done ? <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {!item.read ? <span className="inline-flex items-center gap-1.5 font-medium text-brand">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />{t.unread}</span> : null}
        {item.saved ? <span className="inline-flex items-center gap-1 text-muted-foreground">
          <BookmarkIcon aria-hidden="true" className="size-3" />{t.viewSaved}</span> : null}
        {item.done ? <span className="inline-flex items-center gap-1 text-muted-foreground">
          <CheckIcon aria-hidden="true" className="size-3" />{t.viewDone}</span> : null}
      </p> : null}
      {triageBusy ? <p role="status" className="text-sm text-muted-foreground">{t.loading}</p> : null}
      {feedback ? <div className="flex flex-wrap items-center gap-2 text-sm">
        <p role={feedback.failed ? 'alert' : 'status'}
          className={feedback.failed ? 'text-destructive-foreground' : 'text-muted-foreground'}>{feedback.text}</p>
        {feedback.failed ? <Button size="sm" variant="outline" disabled={triageBusy}
          onClick={() => feedback.stale ? location.reload() : onTriage(item, feedback.patch)}>
          {feedback.stale ? copy.reloadNotifications : t.retry}</Button> : null}
      </div> : null}
      {excerpt ? <p lang={display?.target.language ?? undefined} className="line-clamp-2 wrap-anywhere text-muted-foreground text-sm">
        {excerpt}</p> : null}
      {invitation ? answer ? <p ref={answerRef} tabIndex={-1} role="status"
        className="rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{answer === 'accept'
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
      <NotificationDeliveries item={item} main={main} isCurrent={isCurrent} />
    </div>
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

function mergePageTriage(items: StreamItem[], windows: NotificationWindow[]): StreamItem[] {
  const known = new Map<string, StreamItem>();
  for (const window of windows) for (const item of window.items) {
    const previous = known.get(item.id);
    known.set(item.id, previous ? mergeNotificationTriage(previous, item) : item);
  }
  return items.map(item => known.has(item.id) ? mergeNotificationTriage(item, known.get(item.id)!) : item);
}

/**
 * The notifications page: loaded matches newest first, unread marked, one press to mark all
 * read; opening one marks it read. Saved and Done are a separate triage, kept
 * in the URL with the reason filter so a reload shows what Main returns.
 * Further matching pages load on request. `main` is the browser client (stories pass
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
  const [triageFeedback, setTriageFeedback] = useState<TriageFeedback | null>(null);
  const [countRead, setCountRead] = useState<Loaded<NotificationCount> | undefined>(initial.unreadCount);
  const [olderFailure, setOlderFailure] = useState<Extract<Loaded<NotificationWindow>, { ok: false }> | null>(null);
  const initialCount = useRef(initial.unreadCount);
  // Identity fences completions even when a restart retains the same generation.
  const traversal = useRef<Traversal>({ generation: initial.generation, head: initial.head, revision: 0 });
  const mounted = useRef(true);
  const loadingMore = useRef<Traversal | null>(null);
  const restartRequired = useRef(false);
  const triageBusy = useRef<string | null>(null);
  const rowsRegion = useRef<HTMLDivElement>(null);
  const focusAfterTriage = useRef<HTMLElement | null>(null);
  const displayed = traversal.current;
  useEffect(() => {
    mounted.current = true;
    setUnreadGeneration(traversal.current.generation);
    if (initialCount.current?.ok && initialCount.current.data.generation === traversal.current.generation)
      setUnread(initialCount.current.data, beginNotificationRequest());
    return () => {
      mounted.current = false;
      setUnreadGeneration(null);
    };
  }, []);
  useEffect(() => {
    // Removing the focused row continues at its neighbour, or the empty result.
    focusAfterTriage.current?.focus();
    focusAfterTriage.current = null;
  }, [windows]);
  const isCurrent = (request: Traversal) => mounted.current && traversal.current === request;
  const lastWindow = windows.at(-1)!;
  const isRead = (item: StreamItem) => item.read || readHere.has(item.id)
    || BigInt(item.sequence) <= BigInt(readThrough);
  const unread = windows.some(window => window.items.some(item => item.state === 'active'
    && (item.display || item.proposal) && !isRead(item)));

  async function refreshCount(request: Traversal) {
    const fence = beginNotificationRequest();
    const count = await readNotificationCount(client());
    if (!isCurrent(request) || !isNotificationRequestCurrent(fence)) return;
    if (!count.ok) { setCountRead(count); return; }
    if (count.data.generation !== request.generation) return;
    setCountRead(count);
    setUnread({ count: count.data.count, overflow: count.data.overflow, generation: count.data.generation }, fence);
  }

  async function markAll() {
    const request = displayed;
    if (!isCurrent(request) || restartRequired.current) return;
    const fence = beginNotificationRequest('mark-all');
    const result = await settle(() => client().v1.me['notification-read-watermarks'].inbox.put({
      profile: 'notification-read-watermark-v1', generation: request.generation, readThrough: request.head }));
    if (!isCurrent(request) || !isNotificationRequestCurrent(fence)) return;
    if (!result.ok) { setState('mark-failed'); return; }
    if (result.data.generation !== request.generation) return;
    setReadThrough(current => BigInt(current) > BigInt(result.data.readThrough) ? current : result.data.readThrough);
    setState('marked');
    await refreshCount(request);
  }

  function markOne(item: StreamItem) {
    const request = displayed;
    if (!isCurrent(request) || restartRequired.current || isRead(item)) return;
    const fence = beginNotificationRequest(`read:${item.id}`);
    setReadHere(current => new Set(current).add(item.id));
    void settle(() => client().v1.me.notifications({ item: item.id }).read.put()).then(async result => {
      if (!isCurrent(request) || !isNotificationRequestCurrent(fence) || !result.ok) return;
      await refreshCount(request);
    });
  }

  function replaceTraversal(window: NotificationWindow) {
    const sameGeneration = traversal.current.generation === window.generation;
    traversal.current = { generation: window.generation, head: window.head, revision: traversal.current.revision + 1 };
    setUnreadGeneration(window.generation);
    triageBusy.current = null;
    setBusy(null); setTriageFeedback(null);
    setWindows(current => [{ ...window, items: mergePageTriage(window.items, sameGeneration ? current : []) }]);
    setReadThrough(window.readThrough);
    setReadHere(new Set());
    void refreshCount(traversal.current);
  }

  async function older() {
    let request = displayed;
    if (!isCurrent(request) || loadingMore.current || (!restartRequired.current && lastWindow.next === null)) return;
    loadingMore.current = request;
    setOlderFailure(null);
    setState('loading');
    let restarting = restartRequired.current;
    let fence = beginNotificationRequest('page');
    let next = await readWindow(client(), restarting ? null : lastWindow.next, selection);
    if (!isCurrent(request)) return;
    if (!isNotificationRequestCurrent(fence)) {
      // Remember transport rejection even when a newer snapshot superseded this page.
      if (!next.ok && next.failure === 'invalid') restartRequired.current = true;
      loadingMore.current = null;
      setState('idle');
      return;
    }
    if (!next.ok && next.failure === 'invalid' && !restarting) {
      // Invalidate the rejected cursor before recovery, including a failed recovery's retry.
      restartRequired.current = true;
      restarting = true;
      request = { ...request, revision: request.revision + 1 };
      traversal.current = request;
      loadingMore.current = request;
      triageBusy.current = null;
      setBusy(null); setTriageFeedback(null);
      setUnreadGeneration(request.generation);
      fence = beginNotificationRequest('page');
      next = await readWindow(client(), null, selection);
      if (!isCurrent(request)) return;
    }
    loadingMore.current = null;
    if (!isNotificationRequestCurrent(fence)) { setState('idle'); return; }
    if (!next.ok) { setOlderFailure(next); setState('older-failed'); return; }
    if (BigInt(next.data.generation) < BigInt(request.generation)
      || (next.data.generation !== request.generation && !next.data.reset && !restarting)) {
      setState('older-failed'); return;
    }
    if (restarting || next.data.reset || next.data.generation !== request.generation) {
      restartRequired.current = false;
      replaceTraversal(next.data);
    } else {
      setWindows(current => [...current, { ...next.data, items: mergePageTriage(next.data.items, current) }]);
      setReadThrough(current => BigInt(current) > BigInt(next.data.readThrough) ? current : next.data.readThrough);
    }
    setState('idle');
  }

  /** One flag at a time. Main keeps the flag we omit, and the response is what this view shows. */
  async function triage(item: StreamItem, patch: { saved?: boolean; done?: boolean }) {
    const request = displayed;
    if (!isCurrent(request) || restartRequired.current || triageBusy.current) return;
    triageBusy.current = item.id;
    setBusy(item.id); setTriageFeedback(null);
    const result = await settle(() => client().v1.me.notifications({ item: item.id }).triage.put({
      profile: 'notification-item-triage-v1', ...patch, expectedRevision: item.triageRevision }));
    if (!isCurrent(request)) return;
    triageBusy.current = null;
    setBusy(null);
    if (!result.ok) {
      setTriageFeedback({ id: item.id, text: result.failure === 'moved' ? t.triageStale : t.triageFailed,
        failed: true, stale: result.failure === 'moved', patch });
      return;
    }
    const next = result.data;
    const leaves = (selection.view === 'inbox' && next.done) || (selection.view === 'saved' && !next.saved)
      || (selection.view === 'done' && !next.done);
    const focused = document.activeElement;
    const row = focused instanceof HTMLElement ? focused.closest('[data-notification-row]') : null;
    if (leaves && row?.getAttribute('data-notification-row') === item.id && rowsRegion.current?.contains(row)) {
      const neighbour = row.nextElementSibling ?? row.previousElementSibling;
      focusAfterTriage.current = neighbour?.querySelector<HTMLElement>('[data-notification-actions]') ?? rowsRegion.current;
    }
    setWindows(current => current.map(window => ({ ...window, items: window.items.flatMap(entry => {
      if (entry.id !== item.id) return [entry];
      const merged = mergeNotificationTriage(entry, { saved: next.saved, done: next.done, triageRevision: next.revision });
      const leaves = (selection.view === 'inbox' && merged.done) || (selection.view === 'saved' && !merged.saved)
        || (selection.view === 'done' && !merged.done);
      return leaves ? [] : [merged];
    }) })));
    setTriageFeedback({ id: item.id, failed: false, patch,
      text: patch.done === true ? t.triageDone : patch.done === false ? t.triageUndone
        : patch.saved ? t.triageSaved : t.triageUnsaved });
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
    {triageFeedback && !rows.some(({ item }) => item.id === triageFeedback.id)
      ? <p role="status" className="text-sm text-muted-foreground">{triageFeedback.text}</p> : null}
    {countRead && !countRead.ok && countRead.failure !== 'closed' ? <div className="grid justify-items-start gap-2">
      <NotificationReadFailure read={countRead} kind="count" />
      <Button size="sm" variant="outline" onClick={() => void refreshCount(displayed)}>{t.retry}</Button>
    </div> : null}
    {invitations}
    <div ref={rowsRegion} tabIndex={-1} role="region" aria-label={t.notifications}
      className="rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
    {rows.length ? <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60
      bg-card shadow-(--aura-shadow-card)">
      {rows.map(({ item, grouped }) => <NotificationRow key={`${displayed.revision}:${item.id}`} item={{ ...item, read: isRead(item) }}
        grouped={grouped} now={now} avatarQuery={avatarQuery} onRead={markOne} onTriage={(entry, patch) => void triage(entry, patch)}
        feedback={triageFeedback?.id === item.id ? triageFeedback : null}
        triageBusy={busy === item.id} actingSubject={actingSubject} main={client} isCurrent={() => isCurrent(displayed)} />)}
    </ul> : <EmptyState icon={BellIcon} title={empty.title} description={empty.description} />}
    </div>
    {lastWindow.next !== null ? <div className="flex flex-col items-center gap-2">
      {state === 'older-failed' ? olderFailure ? <NotificationReadFailure read={olderFailure} kind="older" />
        : <p role="alert" className="text-muted-foreground text-sm">{t.olderFailed}</p> : null}
      <Button variant="outline" isLoading={state === 'loading'} onClick={() => void older()}>
        {state === 'older-failed' ? <RotateCwIcon aria-hidden="true" /> : null}{t.olderNotifications}</Button>
    </div> : null}
  </PageContainer>;
}

function NotificationReadFailure({ read, kind }: {
  read: { failure: ReadFailure; reference?: string }; kind: 'count' | 'older';
}) {
  const { t, locale } = useShell();
  const copy = materializeData(newWorkMessages[locale], { locale });
  const text = failureText(read.failure, { failedTitle: kind === 'count' ? copy.countUnavailable : t.olderFailed,
    offline: t.notificationsFailedBody,
    server: t.notificationsServerBody,
    missingTitle: kind === 'count' ? copy.countUnavailable : t.notificationsMissing,
    missingBody: kind === 'count' ? '' : t.notificationsMissingBody,
    deniedTitle: t.signInForNotifications, deniedBody: t.signInForNotificationsBody,
    movedTitle: t.notificationsMoved, movedBody: t.notificationsMovedBody, budget: t.notificationsBudgetBody });
  if (text.kind === 'absent') return null;
  return <div className="grid gap-2">
    <p role="alert" className="text-muted-foreground text-sm">{text.title} {failureDetail(text.description,
      read.reference, t.errorReference, text.reference)}</p>
    {text.action === 'sign-in' ? <a className="underline" href={signInPath(localizedPath('/notifications', locale))}>
      {t.signIn}</a> : null}
  </div>;
}

/** A request still loading is separate from a completed API result. */
export function NotificationsLoading() {
  const { t } = useShell();
  return <PageContainer className="grid max-w-3xl gap-6">
    <PageHeader title={t.notifications} />
    <p role="status" aria-busy="true">{t.loading}</p>
  </PageContainer>;
}

/** Signed out, or Main could not answer: say which, and offer the one next step. */
export function NotificationsUnavailable({ reason, failure = 'unavailable', reference, signInHref }: {
  reason: 'signed-out' | 'failed'; failure?: ReadFailure; reference?: string; signInHref: string;
}) {
  const { t } = useShell();
  if (reason === 'signed-out' || failure === 'sign-in') {
    return <PageContainer className="max-w-3xl">
      <EmptyState icon={BellIcon} headingLevel={1} title={t.signInForNotifications}
        description={t.signInForNotificationsBody}>
        <a href={signInHref} className={buttonVariants()}>{t.signIn}</a>
      </EmptyState>
    </PageContainer>;
  }
  const text = failureText(failure, { failedTitle: t.notificationsFailed, offline: t.notificationsFailedBody,
    server: t.notificationsServerBody, missingTitle: t.notificationsMissing, missingBody: t.notificationsMissingBody,
    deniedTitle: t.signInForNotifications, deniedBody: t.signInForNotificationsBody,
    movedTitle: t.notificationsMoved, movedBody: t.notificationsMovedBody, budget: t.notificationsBudgetBody });
  if (text.kind === 'absent') return null;
  const quiet = text.action === 'none' || text.action === 'restart';
  return <PageContainer className="max-w-3xl">
    <EmptyState icon={TriangleAlertIcon} tone={quiet ? 'default' : 'destructive'} role={quiet ? 'status' : 'alert'}
      headingLevel={1} title={text.title}
      description={failureDetail(text.description, reference, t.errorReference, text.reference)}>
      {text.action === 'none' ? null : <Button onClick={() => location.reload()}>
        <RotateCwIcon aria-hidden="true" />{t.retry}</Button>}
    </EmptyState>
  </PageContainer>;
}
